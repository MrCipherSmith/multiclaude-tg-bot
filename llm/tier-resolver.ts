/**
 * Per-task model-tier override (PRD §10.4 follow-up).
 *
 * Allows agent_tasks.payload.model_tier = "flash" | "pro" to override the
 * agent definition's default model_profile, picking a faster/cheaper or
 * stronger model on a task-by-task basis without re-binding the agent.
 *
 * Design:
 *  - The orchestrator stamps `model_tier` into the task payload at create
 *    time (or it gets in via decomposeTask's subtask.payload pass-through).
 *  - The standalone-llm worker calls `resolveTierOverride` after resolving
 *    the agent's default provider; if the override returns a provider, it
 *    replaces the default for THIS task only.
 *  - Unknown tiers, missing profiles, or resolution failures all fall
 *    back to null so the worker keeps the agent's default. We do not
 *    fail the task — overrides are advisory.
 *
 * Profile-name mapping is intentionally hardcoded here rather than read
 * from a config table: the tier vocabulary is part of the API contract
 * (planner/reviewer code asks for "flash" or "pro"), and we want a
 * compile-time error if a new tier is added without wiring the mapping.
 */

import { resolveProfileByName } from "./profile-resolver.ts";
import { logger } from "../logger.ts";
import type { ResolvedProvider } from "./types.ts";

export type ModelTier = "flash" | "pro";

const TIER_PROFILE_NAMES: Record<ModelTier, string> = {
  flash: "deepseek-flash",
  pro: "deepseek-pro",
};

/**
 * Type guard: narrows an arbitrary payload value to a valid ModelTier.
 * Used by the worker to gate the resolution call — any other value
 * (undefined, null, "default", an object, an array) means "no override".
 */
export function isValidTier(value: unknown): value is ModelTier {
  return value === "flash" || value === "pro";
}

/**
 * Look up the per-tier provider profile by name.
 *
 * Returns:
 *  - ResolvedProvider when the override is valid AND the profile exists
 *  - null when the payload has no model_tier, has an invalid tier, or
 *    the named profile is missing/disabled.
 *
 * Logs at warn level for invalid tiers and at info level for missing
 * profiles — operators should know when a profile rename or seed gap
 * caused an override to fall through.
 */
export async function resolveTierOverride(
  payload: unknown,
): Promise<ResolvedProvider | null> {
  if (payload == null || typeof payload !== "object") return null;
  const tierValue = (payload as Record<string, unknown>).model_tier;
  if (tierValue == null) return null;

  if (!isValidTier(tierValue)) {
    logger.warn(
      { received: tierValue },
      "tier-resolver: payload.model_tier has unknown value, ignoring override",
    );
    return null;
  }

  const profileName = TIER_PROFILE_NAMES[tierValue];
  const provider = await resolveProfileByName(profileName);
  if (!provider) {
    logger.info(
      { tier: tierValue, profileName },
      "tier-resolver: profile not found, falling back to agent default",
    );
    return null;
  }
  return provider;
}
