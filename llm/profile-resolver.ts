import { sql } from "../memory/db.ts";
import { CONFIG } from "../config.ts";
import { logger } from "../logger.ts";
import type { ProviderType, ResolvedProvider } from "./types.ts";

/** Reads the API key from process.env using the column value (env var NAME). */
function readApiKey(envName: string | null | undefined): string | undefined {
  if (!envName) return undefined;
  const value = process.env[envName];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Resolve a model_profile_id to a concrete provider config.
 * Reads two tables: model_profiles JOIN model_providers.
 * Throws if the profile doesn't exist or its provider is disabled.
 */
export async function resolveProfile(profileId: number): Promise<ResolvedProvider> {
  const rows = await sql`
    SELECT
      p.id           AS profile_id,
      p.model        AS model,
      p.max_tokens   AS max_tokens,
      p.temperature  AS temperature,
      p.system_prompt AS system_prompt,
      p.metadata     AS profile_metadata,
      p.enabled      AS profile_enabled,
      pr.id          AS provider_id,
      pr.provider_type AS provider_type,
      pr.base_url    AS base_url,
      pr.api_key_env AS api_key_env,
      pr.metadata    AS provider_metadata,
      pr.enabled     AS provider_enabled
    FROM model_profiles p
    JOIN model_providers pr ON pr.id = p.provider_id
    WHERE p.id = ${profileId}
    LIMIT 1
  `;

  if (rows.length === 0) {
    throw new Error(`model_profile_id=${profileId} not found`);
  }

  const r = rows[0];
  if (!r.profile_enabled) throw new Error(`model_profile_id=${profileId} is disabled`);
  if (!r.provider_enabled) throw new Error(`model_provider for profile ${profileId} is disabled`);

  const apiKey = readApiKey(r.api_key_env);
  if (r.api_key_env && !apiKey) {
    logger.warn({ profileId, envName: r.api_key_env }, "profile api key env var is empty");
  }

  return {
    providerType: r.provider_type as ProviderType,
    model: r.model,
    apiKey,
    baseUrl: r.base_url ?? undefined,
    maxTokens: r.max_tokens ?? undefined,
    temperature: r.temperature ?? undefined,
    systemPrompt: r.system_prompt ?? undefined,
    metadata: { ...(r.provider_metadata ?? {}), ...(r.profile_metadata ?? {}) },
  };
}

/**
 * Resolve a model_profile by NAME (rather than id). Used by the LLM
 * fallback policy (PRD §11.2) which configures the secondary provider
 * via an env var holding the profile name (LLM_FALLBACK_PROFILE).
 *
 * Returns null when the profile is missing or disabled — callers should
 * treat that as "no fallback configured" rather than fail loudly, since
 * fallback is opt-in.
 */
export async function resolveProfileByName(name: string): Promise<ResolvedProvider | null> {
  const rows = await sql`
    SELECT id FROM model_profiles WHERE name = ${name} AND enabled = true LIMIT 1
  ` as { id: number }[];
  if (rows.length === 0) return null;
  try {
    return await resolveProfile(Number(rows[0]!.id));
  } catch (err) {
    logger.warn({ name, err: String(err) }, "fallback profile resolution failed");
    return null;
  }
}

/**
 * Fallback: detect provider from environment variables (current claude/client.ts behavior).
 * Used when no model_profile_id is associated with the session.
 * IMPORTANT: This is the backward-compatibility path — see analysis report R3.
 */
export function resolveFromEnv(): ResolvedProvider {
  if (CONFIG.ANTHROPIC_API_KEY) {
    return {
      providerType: "anthropic",
      model: CONFIG.CLAUDE_MODEL,
      apiKey: CONFIG.ANTHROPIC_API_KEY,
      maxTokens: CONFIG.MAX_TOKENS,
    };
  }
  if (CONFIG.GOOGLE_AI_API_KEY) {
    return {
      providerType: "google-ai",
      model: CONFIG.GOOGLE_AI_MODEL,
      apiKey: CONFIG.GOOGLE_AI_API_KEY,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    };
  }
  if (CONFIG.OPENROUTER_API_KEY) {
    return {
      providerType: "openai",
      model: CONFIG.OPENROUTER_MODEL,
      apiKey: CONFIG.OPENROUTER_API_KEY,
      baseUrl: CONFIG.OPENROUTER_BASE_URL,
    };
  }
  return {
    providerType: "ollama",
    model: CONFIG.OLLAMA_CHAT_MODEL,
    baseUrl: CONFIG.OLLAMA_URL,
  };
}

/**
 * Resolve a session's effective provider: profile if set, else env fallback.
 * If profile resolution fails (table missing, profile deleted), logs and falls back.
 */
export async function resolveSessionProvider(profileId: number | null | undefined): Promise<ResolvedProvider> {
  if (profileId == null) return resolveFromEnv();
  try {
    return await resolveProfile(profileId);
  } catch (err) {
    logger.warn({ profileId, err: String(err) }, "profile resolution failed, falling back to env detection");
    return resolveFromEnv();
  }
}
