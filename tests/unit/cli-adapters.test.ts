import { describe, test, expect } from "bun:test";
import { getAdapter } from "../../adapters/types.ts";
// importing index runs registerAdapter() side effects
import "../../adapters/index.ts";

describe("CliAdapter registry", () => {
  test("getAdapter('claude-code') returns ClaudeCodeAdapter with type='claude-code'", () => {
    const a = getAdapter("claude-code");
    expect(a.type).toBe("claude-code");
    expect(typeof a.send).toBe("function");
    expect(typeof a.isAlive).toBe("function");
  });

  test("getAdapter('codex-cli') returns CodexCliAdapter with type='codex-cli'", () => {
    const a = getAdapter("codex-cli");
    expect(a.type).toBe("codex-cli");
    expect(typeof a.send).toBe("function");
  });

  test("getAdapter('opencode') returns OpenCodeAdapter with type='opencode'", () => {
    const a = getAdapter("opencode");
    expect(a.type).toBe("opencode");
    expect(typeof a.send).toBe("function");
  });

  test("getAdapter('deepseek-cli') returns DeepseekCliAdapter with type='deepseek-cli'", () => {
    const a = getAdapter("deepseek-cli");
    expect(a.type).toBe("deepseek-cli");
    expect(typeof a.send).toBe("function");
  });

  test("getAdapter('unknown-runtime') throws with descriptive error", () => {
    expect(() => getAdapter("unknown-runtime")).toThrow(/runtime_type/);
  });

  test("isAlive returns true for all 4 adapters (session.status is source of truth)", async () => {
    for (const type of ["claude-code", "codex-cli", "opencode", "deepseek-cli"]) {
      const a = getAdapter(type);
      const alive = await a.isAlive({});
      expect(alive).toBe(true);
    }
  });
});

describe("Adapter contract — send() shape", () => {
  // We can't test the actual DB INSERT without a live DB, but we can verify
  // the send method exists and has the expected arity (sessionId, text, meta).
  test("each adapter's send() has 3 expected parameters", () => {
    for (const type of ["claude-code", "codex-cli", "opencode", "deepseek-cli"]) {
      const a = getAdapter(type);
      expect(a.send.length).toBe(3); // (sessionId, text, meta)
    }
  });
});
