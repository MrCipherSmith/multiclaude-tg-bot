/**
 * Unit tests verifying that the OpenAI-compatible HTTP client in
 * `llm/client.ts` adds the OpenRouter attribution headers
 * (`HTTP-Referer` and `X-Title`) ONLY when the request is going to
 * `openrouter.ai`.
 *
 * Strategy:
 *   - Stub `globalThis.fetch` so it captures the (url, init) tuple and
 *     returns a synthetic OpenAI-compatible response payload.
 *   - Drive the code path via `generateResponse(messages, system, ctx)`
 *     with a per-call `ctx.provider` override (`providerType: "openai"`)
 *     pointing at different baseUrls.
 *   - Inspect `init.headers` to assert presence/absence of the
 *     OpenRouter-specific headers.
 *
 * Note on dynamic import:
 *   `llm/client.ts` performs side-effects at module load (provider
 *   detection, `console.log`). Importing it once at the top of the file
 *   is sufficient — we don't need to re-evaluate the module per test
 *   because the override path inside `effectiveConfig()` ignores the
 *   module-level globals when `ctx.provider` is supplied.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// Mock recordApiRequest BEFORE importing the module under test, so its
// `import { recordApiRequest } from "../utils/stats.ts"` binding resolves
// to the no-op stub. Without this, generateResponse fires real INSERTs
// against api_request_stats — errors get silently swallowed in stats.ts
// but generate noise + slow CI when no DB is available.
mock.module("../../utils/stats.ts", () => ({
  recordApiRequest: mock(async () => {}),
  recordTranscription: mock(async () => {}),
  appendLog: mock(async () => {}),
  getApiStats: mock(async () => ({})),
  getTranscriptionStats: mock(async () => ({})),
  getRecentErrors: mock(async () => []),
  getSessionLogs: mock(async () => []),
  getRecentLogs: mock(async () => []),
  getMessageStats: mock(async () => ({})),
}));

import { generateResponse } from "../../llm/client.ts";
import type { ResolvedProvider } from "../../llm/types.ts";

interface CapturedRequest {
  url: string;
  init?: RequestInit;
}

const origFetch = globalThis.fetch;

function installFetchStub(captured: CapturedRequest[]): void {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.push({ url: String(input), init });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

function restoreFetch(): void {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
}

/** Pull a header value out of a `RequestInit.headers` (which may be a plain object). */
function getHeader(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers;
  if (!h) return undefined;
  if (h instanceof Headers) return h.get(name) ?? undefined;
  if (Array.isArray(h)) {
    const lower = name.toLowerCase();
    const found = h.find(([k]) => k.toLowerCase() === lower);
    return found?.[1];
  }
  // Plain Record<string, string>
  const rec = h as Record<string, string>;
  if (name in rec) return rec[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() === lower) return rec[k];
  }
  return undefined;
}

describe("openrouter headers", () => {
  let captured: CapturedRequest[];

  beforeEach(() => {
    captured = [];
    installFetchStub(captured);
  });

  afterEach(() => {
    restoreFetch();
  });

  test("adds HTTP-Referer and X-Title when baseUrl includes openrouter.ai", async () => {
    const provider: ResolvedProvider = {
      providerType: "openai",
      model: "test-model",
      apiKey: "sk-test-or",
      baseUrl: "https://openrouter.ai/api/v1",
    };

    const result = await generateResponse(
      [{ role: "user", content: "hi" }],
      "system prompt",
      { provider, sessionId: null, chatId: null, operation: "test" },
    );

    expect(result).toBe("ok");
    expect(captured.length).toBe(1);
    expect(captured[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");

    const init = captured[0]?.init;
    expect(getHeader(init, "HTTP-Referer")).toBe("https://github.com/MrCipherSmith/helyx");
    expect(getHeader(init, "X-Title")).toBe("Helyx");
    expect(getHeader(init, "Authorization")).toBe("Bearer sk-test-or");
  });

  test("does NOT add OpenRouter headers when baseUrl is a non-openrouter host", async () => {
    const provider: ResolvedProvider = {
      providerType: "openai",
      model: "deepseek-chat",
      apiKey: "sk-test-ds",
      baseUrl: "https://api.deepseek.com",
    };

    await generateResponse(
      [{ role: "user", content: "hi" }],
      "system prompt",
      { provider, sessionId: null, chatId: null, operation: "test" },
    );

    expect(captured.length).toBe(1);
    const init = captured[0]?.init;
    expect(getHeader(init, "HTTP-Referer")).toBeUndefined();
    expect(getHeader(init, "X-Title")).toBeUndefined();
    // Authorization MUST still be present
    expect(getHeader(init, "Authorization")).toBe("Bearer sk-test-ds");
  });

  test("does NOT add OpenRouter headers for Google AI baseUrl", async () => {
    const provider: ResolvedProvider = {
      providerType: "google-ai",
      model: "gemini-1.5-flash",
      apiKey: "google-key",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    };

    await generateResponse(
      [{ role: "user", content: "hi" }],
      "system prompt",
      { provider, sessionId: null, chatId: null, operation: "test" },
    );

    expect(captured.length).toBe(1);
    const init = captured[0]?.init;
    expect(getHeader(init, "HTTP-Referer")).toBeUndefined();
    expect(getHeader(init, "X-Title")).toBeUndefined();
  });

  test("Content-Type is application/json on the OpenAI-compatible request", async () => {
    const provider: ResolvedProvider = {
      providerType: "openai",
      model: "test",
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api/v1",
    };

    await generateResponse(
      [{ role: "user", content: "hi" }],
      "system prompt",
      { provider, sessionId: null, chatId: null, operation: "test" },
    );

    expect(getHeader(captured[0]?.init, "Content-Type")).toBe("application/json");
  });

  test("request body includes the override model and the system+user messages", async () => {
    const provider: ResolvedProvider = {
      providerType: "openai",
      model: "override-model-x",
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api/v1",
    };

    await generateResponse(
      [{ role: "user", content: "hello world" }],
      "you are helpful",
      { provider, sessionId: null, chatId: null, operation: "test" },
    );

    const body = captured[0]?.init?.body;
    expect(typeof body).toBe("string");
    const parsed = JSON.parse(String(body));
    expect(parsed.model).toBe("override-model-x");
    expect(Array.isArray(parsed.messages)).toBe(true);
    expect(parsed.messages[0]).toEqual({ role: "system", content: "you are helpful" });
    expect(parsed.messages[1]).toEqual({ role: "user", content: "hello world" });
    // generateResponse is non-stream
    expect(parsed.stream).toBe(false);
  });
});
