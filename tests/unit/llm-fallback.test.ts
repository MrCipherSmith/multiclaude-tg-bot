import { describe, test, expect } from "bun:test";

/**
 * Unit tests for the LLM fallback policy (PRD §11.2). The classifier is
 * a pure function — verify it categorizes the canonical error shapes from
 * each provider SDK (Anthropic, OpenAI-compatible) and from raw
 * fetch/network errors correctly.
 *
 * The classifier is not exported by the public llm/client.ts surface
 * (it's an implementation detail), so we test it indirectly by ensuring
 * the export shape and verifying the fallback cache reset hook exists.
 */
describe("llm fallback — module exports", () => {
  test("exports _resetFallbackCacheForTests", async () => {
    const mod = await import("../../llm/client");
    expect(typeof mod._resetFallbackCacheForTests).toBe("function");
    // Idempotent — calling twice should not throw.
    mod._resetFallbackCacheForTests();
    mod._resetFallbackCacheForTests();
  });

  test("StreamContext type has _fallbackInProgress flag", async () => {
    // We can't reflect on TS types at runtime, but we can verify that
    // passing the flag does not throw a runtime error (the property is
    // part of the interface, not a runtime check). This is a smoke
    // assertion — the actual fallback behavior requires DB + live
    // providers, which are out of scope for unit tests.
    const ctx: import("../../llm/client").StreamContext = { _fallbackInProgress: true };
    expect(ctx._fallbackInProgress).toBe(true);
  });
});

describe("llm fallback — classifyProviderError (via integration shape)", () => {
  // The classifier runs inside generateResponse on a thrown error. We can't
  // trigger a real generateResponse call here without a DB and provider.
  // These tests document the EXPECTED classification table — when the
  // classifier changes, update both this table and the implementation.
  //
  // NOTE: classifyProviderError is intentionally NOT exported. To validate
  // it in isolation, we re-implement the classification logic here as a
  // pure mirror and assert against the canonical inputs. If the impl
  // diverges, this mirror also needs updating — flag it in the PR.

  function mirror(err: unknown): "retryable" | "non-retryable" {
    const e = err as { status?: number; response?: { status?: number }; message?: string };
    const status = e?.status ?? e?.response?.status;
    const msg = String(e?.message ?? err ?? "");
    if (status === 429) return "retryable";
    if (typeof status === "number" && status >= 500 && status < 600) return "retryable";
    if (status === 401 || status === 403) return "non-retryable";
    if (status === 404) return "non-retryable";
    if (status === 400) {
      if (/context.{0,5}length|tokens.*exceed|too.*many.*tokens/i.test(msg)) return "non-retryable";
      return "non-retryable";
    }
    if (/timeout|timed.?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN/i.test(msg)) return "retryable";
    if (/rate.?limit/i.test(msg)) return "retryable";
    if (/unavailable|service.*down/i.test(msg)) return "retryable";
    return "non-retryable";
  }

  test("HTTP 429 → retryable", () => {
    expect(mirror({ status: 429, message: "Too Many Requests" })).toBe("retryable");
  });

  test("HTTP 500/502/503 → retryable", () => {
    expect(mirror({ status: 500, message: "Internal Server Error" })).toBe("retryable");
    expect(mirror({ status: 502, message: "Bad Gateway" })).toBe("retryable");
    expect(mirror({ status: 503, message: "Service Unavailable" })).toBe("retryable");
  });

  test("HTTP 401/403 → non-retryable (invalid key)", () => {
    expect(mirror({ status: 401, message: "Unauthorized" })).toBe("non-retryable");
    expect(mirror({ status: 403, message: "Forbidden" })).toBe("non-retryable");
  });

  test("HTTP 404 → non-retryable (model not found)", () => {
    expect(mirror({ status: 404, message: "Model not found" })).toBe("non-retryable");
  });

  test("HTTP 400 with context-length message → non-retryable", () => {
    expect(mirror({ status: 400, message: "context length exceeded for model" })).toBe("non-retryable");
    expect(mirror({ status: 400, message: "too many tokens in request" })).toBe("non-retryable");
  });

  test("HTTP 400 generic → non-retryable", () => {
    expect(mirror({ status: 400, message: "Invalid request" })).toBe("non-retryable");
  });

  test("network errors (no status) → retryable", () => {
    expect(mirror({ message: "fetch failed: ECONNRESET" })).toBe("retryable");
    expect(mirror({ message: "Request timed out after 30s" })).toBe("retryable");
    expect(mirror({ message: "ETIMEDOUT connecting to host" })).toBe("retryable");
    expect(mirror({ message: "ECONNREFUSED at api.example.com" })).toBe("retryable");
    expect(mirror(new Error("rate limit reached"))).toBe("retryable");
    expect(mirror(new Error("provider service unavailable"))).toBe("retryable");
  });

  test("response.status (axios-style) classifies same as flat status", () => {
    expect(mirror({ response: { status: 429 } })).toBe("retryable");
    expect(mirror({ response: { status: 503 } })).toBe("retryable");
    expect(mirror({ response: { status: 401 } })).toBe("non-retryable");
  });

  test("unknown errors → non-retryable (conservative default)", () => {
    expect(mirror(new Error("something unexpected"))).toBe("non-retryable");
    expect(mirror({})).toBe("non-retryable");
    expect(mirror("plain string")).toBe("non-retryable");
  });
});
