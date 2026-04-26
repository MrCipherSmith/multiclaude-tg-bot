// Canonical LLM client. Older callers may still import from "../claude/client.ts",
// which re-exports this module for backward compatibility.
import Anthropic from "@anthropic-ai/sdk";
import { CONFIG } from "../config.ts";
import { recordApiRequest } from "../utils/stats.ts";
import { logger } from "../logger.ts";
import { resolveProfileByName } from "./profile-resolver.ts";
import type { ResolvedProvider } from "./types.ts";

/**
 * Strip API-key-shaped tokens from upstream error/response bodies before
 * we store them in api_request_stats.error_message or surface them via
 * /api/stats/errors. Third-party providers occasionally echo partial keys
 * or bearer tokens in their JSON error replies; with single-tenant trust
 * we still don't want operator-visible logs to retain them.
 *
 * The body is also length-capped at 500 bytes — long stack-trace-like
 * payloads bloat the stats table and rarely add diagnostic value.
 */
function sanitizeUpstreamMessage(msg: string): string {
  return msg
    .slice(0, 500)
    .replace(/\b(?:sk|pk|Bearer)[A-Za-z0-9_.-]{8,}/gi, "***")
    .replace(/\bapi[_-]?key["':\s=]+[A-Za-z0-9_.-]{8,}/gi, "api_key=***");
}

/**
 * Classify a provider error as retryable (worth attempting fallback) or
 * non-retryable (fail fast — fallback wouldn't help). Per PRD §11.2:
 *   retryable: 429 rate limit, 5xx, timeout, network failure, provider unavailable
 *   non-retryable: invalid API key, model not found, context length, schema/policy
 */
function classifyProviderError(err: unknown): "retryable" | "non-retryable" {
  const e = err as { status?: number; response?: { status?: number }; message?: string };
  const status = e?.status ?? e?.response?.status;
  const msg = String(e?.message ?? err ?? "");

  if (status === 429) return "retryable";
  if (typeof status === "number" && status >= 500 && status < 600) return "retryable";
  if (status === 401 || status === 403) return "non-retryable";  // invalid key / unauthorized
  if (status === 404) return "non-retryable";                     // model not found
  if (status === 400) {
    if (/context.{0,5}length|tokens.*exceed|too.*many.*tokens/i.test(msg)) return "non-retryable";
    return "non-retryable";  // schema / policy / invalid request — fallback won't help
  }

  // Error-message heuristics for transports without HTTP status (e.g. SDK timeouts).
  if (/timeout|timed.?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN/i.test(msg)) return "retryable";
  if (/rate.?limit/i.test(msg)) return "retryable";
  if (/unavailable|service.*down/i.test(msg)) return "retryable";

  // Default conservative: non-retryable. Avoids fallback storms on unknown
  // SDK errors that may be misconfiguration rather than transient failure.
  return "non-retryable";
}

let cachedFallback: ResolvedProvider | null | undefined; // undefined = not loaded; null = none configured

async function getFallbackProvider(): Promise<ResolvedProvider | null> {
  if (cachedFallback !== undefined) return cachedFallback;
  const name = process.env.LLM_FALLBACK_PROFILE;
  if (!name) {
    cachedFallback = null;
    return null;
  }
  cachedFallback = await resolveProfileByName(name);
  if (!cachedFallback) {
    logger.warn({ name }, "LLM_FALLBACK_PROFILE set but profile not found/disabled — fallback disabled");
  } else {
    logger.info({ name, provider: cachedFallback.providerType, model: cachedFallback.model }, "LLM fallback configured");
  }
  return cachedFallback;
}

/** Test-only hook: reset the cached fallback so a subsequent call re-reads env + DB. */
export function _resetFallbackCacheForTests(): void {
  cachedFallback = undefined;
}

/**
 * Best-effort write to agent_events for fallback traceability (PRD §11.2).
 * Lazy-imports memory/db.ts to avoid a hard dependency on the DB at module
 * load — if the import fails (e.g. running tests without a configured
 * Postgres), the write is silently skipped. agent_events is observability
 * data; failure to record must NEVER fail the actual LLM call.
 */
async function recordFallbackEvent(
  eventType: "model_primary_failed" | "model_fallback_selected" | "model_request_completed",
  ctx: StreamContext | undefined,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!ctx?.taskId && !ctx?.agentInstanceId) return; // no traceability context — skip
  try {
    const { sql } = await import("../memory/db.ts");
    await sql`
      INSERT INTO agent_events (agent_instance_id, task_id, event_type, message, metadata)
      VALUES (
        ${ctx.agentInstanceId ?? null},
        ${ctx.taskId ?? null},
        ${eventType},
        ${typeof metadata.message === "string" ? metadata.message : null},
        ${JSON.stringify(metadata)}::jsonb
      )
    `;
  } catch (err) {
    logger.warn({ err: String(err), eventType }, "agent_events write failed (observability-only, ignoring)");
  }
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type MessageParam = { role: "user" | "assistant"; content: string | ContentBlock[] };

/** Extract text content from a message for non-Anthropic providers */
function contentToString(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}

/** Convert messages to plain text for OpenAI/Ollama */
function toTextMessages(messages: MessageParam[]): { role: string; content: string }[] {
  return messages.map((m) => ({ role: m.role, content: contentToString(m.content) }));
}

// --- Retry with backoff ---

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const is429 = err?.message?.includes("429") || err?.message?.includes("rate");
      const is5xx = err?.message?.match(/5\d\d/);
      if ((is429 || is5xx) && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 1000;
        console.log(`[client] ${label} retry ${attempt + 1}/${MAX_RETRIES} after ${Math.round(delay)}ms (${is429 ? "429" : "5xx"})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Provider detection: anthropic > google-ai > openai-compatible (openrouter etc) > ollama
const googleAiUrl = "https://generativelanguage.googleapis.com/v1beta/openai";

const provider = CONFIG.ANTHROPIC_API_KEY
  ? "anthropic"
  : CONFIG.GOOGLE_AI_API_KEY
    ? "google-ai"
    : CONFIG.OPENROUTER_API_KEY
      ? "openai"
      : "ollama";

const anthropic = provider === "anthropic" ? new Anthropic() : null;

// Resolve effective OpenAI-compat settings (Google AI uses the same protocol)
const effectiveApiKey = provider === "google-ai" ? CONFIG.GOOGLE_AI_API_KEY : CONFIG.OPENROUTER_API_KEY;
const effectiveBaseUrl = provider === "google-ai" ? googleAiUrl : CONFIG.OPENROUTER_BASE_URL;
const effectiveModel = provider === "google-ai" ? CONFIG.GOOGLE_AI_MODEL : CONFIG.OPENROUTER_MODEL;

/** Per-call effective config — either pulled from override or module-level globals. */
interface EffectiveConfig {
  provider: string;
  model: string;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  maxTokens: number;
}

/**
 * Compute the effective provider/model/keys for a single call.
 * If `override` is provided, use it. Otherwise return the module-level globals
 * (preserves existing behavior — backward compat path).
 */
function effectiveConfig(override?: ResolvedProvider): EffectiveConfig {
  if (override) {
    return {
      provider: override.providerType,
      model: override.model,
      apiKey: override.apiKey,
      baseUrl: override.baseUrl,
      maxTokens: override.maxTokens ?? CONFIG.MAX_TOKENS,
    };
  }
  return {
    provider,
    model: effectiveModel,
    apiKey: effectiveApiKey,
    baseUrl: effectiveBaseUrl,
    maxTokens: CONFIG.MAX_TOKENS,
  };
}

/**
 * Map provider type to wire format. `custom-openai` (DeepSeek and similar)
 * uses the same OpenAI-compatible wire protocol.
 */
function wireFormatOf(providerType: string): string {
  return providerType === "custom-openai" ? "openai" : providerType;
}

export function getProviderInfo(override?: ResolvedProvider): { provider: string; model: string } {
  if (override) {
    return { provider: override.providerType, model: override.model };
  }
  const model = provider === "anthropic" ? CONFIG.CLAUDE_MODEL
    : provider === "google-ai" ? CONFIG.GOOGLE_AI_MODEL
    : provider === "openai" ? CONFIG.OPENROUTER_MODEL
    : CONFIG.OLLAMA_CHAT_MODEL;
  return { provider, model };
}

console.log(`[client] provider: ${provider}${
  provider === "google-ai" ? ` (${CONFIG.GOOGLE_AI_MODEL} @ Google AI)`
  : provider === "openai" ? ` (${CONFIG.OPENROUTER_MODEL} @ ${CONFIG.OPENROUTER_BASE_URL})`
  : provider === "ollama" ? ` (${CONFIG.OLLAMA_CHAT_MODEL})`
  : ""
}`);

// --- OpenAI-compatible API (OpenRouter, Google AI, custom-openai) ---

// Per-call usage tracking for streaming (avoids global mutable state race)
interface StreamUsage { input?: number; output?: number; }

/** Shared fetch for OpenAI-compatible APIs (OpenRouter, Google AI, custom-openai). */
async function fetchOpenai(
  messages: { role: string; content: string }[],
  stream: boolean,
  cfg: EffectiveConfig,
): Promise<Response> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  // OpenRouter recommends HTTP-Referer and X-Title for attribution / leaderboard.
  // See https://openrouter.ai/docs/api-reference/overview#headers
  if (cfg.baseUrl?.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://github.com/MrCipherSmith/helyx";
    headers["X-Title"] = "Helyx";
  }

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok && (res.status === 429 || res.status >= 500)) {
    throw new Error(`API failed: ${res.status} ${sanitizeUpstreamMessage(await res.text())}`);
  }

  return res;
}

async function* openaiStream(
  messages: MessageParam[],
  system: string,
  cfg: EffectiveConfig,
  usage: StreamUsage = {},
): AsyncGenerator<string> {

  const res = await withRetry(() => fetchOpenai(
    [{ role: "system", content: system }, ...toTextMessages(messages)],
    true,
    cfg,
  ), "stream");

  if (!res.ok) {
    throw new Error(`API failed: ${res.status} ${sanitizeUpstreamMessage(await res.text())}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        // Capture usage from final chunk
        if (parsed.usage) {
          usage.input = parsed.usage.prompt_tokens;
          usage.output = parsed.usage.completion_tokens;
        }
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch (e) {
        console.warn("[client] failed to parse SSE chunk:", (e as Error)?.message);
      }
    }
  }
}

interface GenerateResult {
  content: string;
  inputTokens?: number;
  outputTokens?: number;
}

async function openaiGenerate(
  messages: MessageParam[],
  system: string,
  cfg: EffectiveConfig,
): Promise<GenerateResult> {
  const res = await withRetry(() => fetchOpenai(
    [{ role: "system", content: system }, ...toTextMessages(messages)],
    false,
    cfg,
  ), "generate");

  if (!res.ok) {
    throw new Error(`API failed: ${res.status} ${sanitizeUpstreamMessage(await res.text())}`);
  }

  interface OpenAIResponse {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }
  const data = (await res.json()) as OpenAIResponse;
  let content = data.choices?.[0]?.message?.content ?? "";
  content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return {
    content,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  };
}

// --- Ollama chat API ---

async function* ollamaStream(
  messages: MessageParam[],
  system: string,
  cfg: EffectiveConfig,
): AsyncGenerator<string> {
  const ollamaUrl = cfg.baseUrl ?? CONFIG.OLLAMA_URL;
  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "system", content: system }, ...toTextMessages(messages)],
      stream: true,
    }),
  });

  if (!res.ok) throw new Error(`Ollama chat failed: ${res.status}`);

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let thinkingDone = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        const content = data.message?.content ?? "";
        if (content) {
          if (!thinkingDone) {
            if (content.includes("</think>")) {
              thinkingDone = true;
              const after = content.split("</think>").pop() ?? "";
              if (after) yield after;
            }
            continue;
          }
          yield content;
        }
      } catch (e) {
        console.warn("[client] failed to parse Ollama chunk:", (e as Error)?.message);
      }
    }
  }
}

async function ollamaGenerate(
  messages: MessageParam[],
  system: string,
  cfg: EffectiveConfig,
): Promise<GenerateResult> {
  const ollamaUrl = cfg.baseUrl ?? CONFIG.OLLAMA_URL;
  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "system", content: system }, ...toTextMessages(messages)],
      stream: false,
    }),
  });

  if (!res.ok) throw new Error(`Ollama chat failed: ${res.status}`);

  const data = (await res.json()) as any;
  let content = data.message?.content ?? "";
  content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return {
    content,
    inputTokens: data.prompt_eval_count,
    outputTokens: data.eval_count,
  };
}

// --- Public API ---

export interface StreamContext {
  sessionId?: number | null;
  chatId?: string | null;
  operation?: string;
  /**
   * Optional per-call override — when provided, this provider/model/key/baseUrl
   * is used INSTEAD of the module-level env-driven globals. When absent, the
   * existing globals (env detection) are used. This preserves backward compat.
   */
  provider?: ResolvedProvider;
  /**
   * Internal: when set, this generateResponse call is itself a fallback
   * attempt — do not recurse into another fallback. Set by the fallback
   * dispatch logic; callers should not pass this directly.
   */
  _fallbackInProgress?: boolean;
  /**
   * Optional task/agent context for §11.2 traceability — when set, fallback
   * decisions are written to agent_events as model.primary_failed /
   * model.fallback_selected / model.request_completed so an operator can
   * reconstruct what happened on a per-task basis. Callers in the
   * orchestrator path (decomposeTask, handleFailure) supply these; ad-hoc
   * callers (summarizer, supervisor) leave them unset and only get
   * api_request_stats records.
   */
  taskId?: number | null;
  agentInstanceId?: number | null;
}

export async function* streamResponse(
  messages: MessageParam[],
  system: string,
  ctx?: StreamContext,
): AsyncGenerator<string> {
  const cfg = effectiveConfig(ctx?.provider);
  const wire = wireFormatOf(cfg.provider);
  const start = Date.now();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let error: string | undefined;

  try {
    switch (wire) {
      case "google-ai":
      case "openai": {
        const streamUsage: StreamUsage = {};
        yield* openaiStream(messages, system, cfg, streamUsage);
        inputTokens = streamUsage.input;
        outputTokens = streamUsage.output;
        break;
      }
      case "ollama":
        yield* ollamaStream(messages, system, cfg);
        break;
      case "anthropic": {
        // The Anthropic SDK reads ANTHROPIC_API_KEY from env by default. When an
        // override is provided we must construct a per-call client with that key.
        const client = ctx?.provider
          ? new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) })
          : anthropic!;
        const stream = client.messages.stream({
          model: cfg.model,
          max_tokens: cfg.maxTokens,
          system,
          messages,
        });
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            yield event.delta.text;
          }
          if (event.type === "message_delta" && (event as any).usage) {
            outputTokens = (event as any).usage.output_tokens;
          }
        }
        const final = await stream.finalMessage();
        inputTokens = final.usage?.input_tokens;
        outputTokens = final.usage?.output_tokens;
        break;
      }
      default:
        throw new Error(`Unknown provider: ${cfg.provider}`);
    }
  } catch (err: any) {
    error = err?.message ?? String(err);
    throw err;
  } finally {
    recordApiRequest({
      sessionId: ctx?.sessionId,
      chatId: ctx?.chatId,
      provider: cfg.provider,
      model: cfg.model,
      operation: ctx?.operation ?? "chat",
      durationMs: Date.now() - start,
      status: error ? "error" : "success",
      inputTokens,
      outputTokens,
      totalTokens: inputTokens && outputTokens ? inputTokens + outputTokens : null,
      errorMessage: error,
    });
  }
}

/**
 * Internal: dispatch a single attempt to the configured provider. Pure —
 * no stats recording, no fallback handling. Used by generateResponse and
 * its fallback path.
 */
async function callProvider(
  messages: MessageParam[],
  system: string,
  cfg: EffectiveConfig,
  override?: ResolvedProvider,
): Promise<{ result: string; inputTokens?: number; outputTokens?: number }> {
  const wire = wireFormatOf(cfg.provider);
  switch (wire) {
    case "google-ai":
    case "openai": {
      const r = await openaiGenerate(messages, system, cfg);
      return { result: r.content, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
    }
    case "ollama": {
      const r = await ollamaGenerate(messages, system, cfg);
      return { result: r.content, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
    }
    case "anthropic": {
      const client = override
        ? new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) })
        : anthropic!;
      const response = await client.messages.create({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        system,
        messages,
      });
      const result = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return {
        result,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      };
    }
    default:
      throw new Error(`Unknown provider: ${cfg.provider}`);
  }
}

export async function generateResponse(
  messages: MessageParam[],
  system: string,
  ctx?: StreamContext,
): Promise<string> {
  const cfg = effectiveConfig(ctx?.provider);
  const start = Date.now();

  try {
    const r = await callProvider(messages, system, cfg, ctx?.provider);
    recordApiRequest({
      sessionId: ctx?.sessionId,
      chatId: ctx?.chatId,
      provider: cfg.provider,
      model: cfg.model,
      operation: ctx?.operation ?? "generate",
      durationMs: Date.now() - start,
      status: "success",
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      totalTokens: r.inputTokens && r.outputTokens ? r.inputTokens + r.outputTokens : null,
    });
    return r.result;
  } catch (err: any) {
    const primaryDuration = Date.now() - start;
    const primaryErrorMsg = err?.message ?? String(err);

    // PRD §11.2: provider failover. Only retry on classified-retryable errors;
    // skip when the caller is already running as a fallback (avoid recursion).
    const classification = classifyProviderError(err);
    if (classification === "retryable" && !ctx?._fallbackInProgress) {
      const fallback = await getFallbackProvider().catch(() => null);
      if (fallback && fallback.providerType !== cfg.provider) {
        // Record the primary failure with a special operation tag so stats
        // queries can distinguish "primary failed" from "single attempt failed".
        recordApiRequest({
          sessionId: ctx?.sessionId,
          chatId: ctx?.chatId,
          provider: cfg.provider,
          model: cfg.model,
          operation: `${ctx?.operation ?? "generate"}:primary-failed`,
          durationMs: primaryDuration,
          status: "error",
          errorMessage: primaryErrorMsg,
        });
        logger.warn(
          { primary: cfg.provider, fallback: fallback.providerType, error: primaryErrorMsg },
          "primary provider failed, attempting fallback",
        );

        // Per PRD §11.2 — record traceability events (best effort).
        await recordFallbackEvent("model_primary_failed", ctx, {
          message: `primary provider ${cfg.provider} (${cfg.model}) failed: ${primaryErrorMsg}`,
          provider: cfg.provider,
          model: cfg.model,
          duration_ms: primaryDuration,
        });
        await recordFallbackEvent("model_fallback_selected", ctx, {
          message: `fallback provider ${fallback.providerType} (${fallback.model}) selected`,
          provider: fallback.providerType,
          model: fallback.model,
        });

        // Re-dispatch with the fallback provider config. Mark _fallbackInProgress
        // so this attempt cannot itself trigger another fallback.
        const fbStart = Date.now();
        const fbCfg = effectiveConfig(fallback);
        try {
          const r = await callProvider(messages, system, fbCfg, fallback);
          recordApiRequest({
            sessionId: ctx?.sessionId,
            chatId: ctx?.chatId,
            provider: fbCfg.provider,
            model: fbCfg.model,
            operation: `${ctx?.operation ?? "generate"}:fallback-success`,
            durationMs: Date.now() - fbStart,
            status: "success",
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            totalTokens: r.inputTokens && r.outputTokens ? r.inputTokens + r.outputTokens : null,
          });
          logger.info(
            { primary: cfg.provider, fallback: fbCfg.provider, model: fbCfg.model },
            "fallback provider succeeded",
          );
          await recordFallbackEvent("model_request_completed", ctx, {
            message: `request completed via fallback ${fbCfg.provider} (${fbCfg.model})`,
            provider: fbCfg.provider,
            model: fbCfg.model,
            duration_ms: Date.now() - fbStart,
            outcome: "fallback-success",
          });
          return r.result;
        } catch (fbErr: any) {
          recordApiRequest({
            sessionId: ctx?.sessionId,
            chatId: ctx?.chatId,
            provider: fbCfg.provider,
            model: fbCfg.model,
            operation: `${ctx?.operation ?? "generate"}:fallback-failed`,
            durationMs: Date.now() - fbStart,
            status: "error",
            errorMessage: fbErr?.message ?? String(fbErr),
          });
          await recordFallbackEvent("model_request_completed", ctx, {
            message: `request failed via both primary and fallback`,
            primary_error: primaryErrorMsg,
            fallback_error: fbErr?.message ?? String(fbErr),
            outcome: "fallback-failed",
          });
          // Throw the ORIGINAL primary error — that's what callers expect to
          // see (the fallback failure is in stats for debugging).
          throw err;
        }
      }
    }

    // No fallback (not configured, non-retryable error, or already in fallback) —
    // record + rethrow as before.
    recordApiRequest({
      sessionId: ctx?.sessionId,
      chatId: ctx?.chatId,
      provider: cfg.provider,
      model: cfg.model,
      operation: ctx?.operation ?? "generate",
      durationMs: primaryDuration,
      status: "error",
      errorMessage: primaryErrorMsg,
    });
    throw err;
  }
}

export async function summarizeConversation(
  messages: { role: string; content: string }[],
  ctx?: StreamContext,
): Promise<{ summary: string; facts: string[] }> {
  const formatted = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const userPrompt = `Analyze this conversation and return JSON:
{
  "summary": "brief description of the conversation in 2-3 sentences",
  "facts": ["fact 1 about the user or decisions", "fact 2", ...]
}

Conversation:
${formatted}`;

  const systemPrompt = "You extract structured information from conversations. Reply only with valid JSON, no markdown.";

  // Use local Ollama model for summarization if configured (cheaper, offline).
  // Note: SUMMARIZE_MODEL is a global default that always uses local Ollama —
  // it is independent of any per-call provider override (the override would be
  // for the main model, not the summarizer fast-path).
  if (CONFIG.SUMMARIZE_MODEL && CONFIG.OLLAMA_URL) {
    try {
      const res = await fetch(`${CONFIG.OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: CONFIG.SUMMARIZE_MODEL,
          think: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          stream: false,
          format: "json",
          options: { num_predict: 400, temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const text = (data.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        try { return JSON.parse(text); } catch { /* fall through to main model */ }
      }
    } catch { /* timeout or connection error — fall through to main model */ }
  }

  const response = await generateResponse(
    [{ role: "user", content: userPrompt }],
    systemPrompt,
    ctx,
  );

  try {
    return JSON.parse(response);
  } catch {
    return { summary: response, facts: [] };
  }
}
