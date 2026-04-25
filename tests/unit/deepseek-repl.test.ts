/**
 * Smoke test for scripts/deepseek-repl.ts — verifies module shape.
 *
 * The script has a top-level `main()` that reads stdin, so we cannot import
 * it directly without side-effects. Instead we validate the file's source
 * contains the expected wiring (resolver call, generate call, env var name,
 * argv flags). Full E2E lives in Phase 7+.
 */

import { describe, test, expect } from "bun:test";
import { readFile } from "fs/promises";
import { resolve } from "path";

// Resolve script path relative to this test file — works in any checkout location.
const SCRIPT_PATH = resolve(import.meta.dir, "../../scripts/deepseek-repl.ts");

describe("deepseek-repl: module shape", () => {
  test("file exists and exposes the expected wiring", async () => {
    const content = await readFile(SCRIPT_PATH, "utf-8");

    // Module identity / docstring
    expect(content).toContain("deepseek-repl");

    // Pulls profile resolution from llm layer
    expect(content).toContain("resolveProfile");

    // Calls into the canonical llm client (not claude/client directly)
    expect(content).toContain("generateResponse");
    expect(content).toContain("../llm/client.ts");

    // Honors the env var contract
    expect(content).toContain("MODEL_PROFILE_ID");

    // Default profile lookup name matches migration v24
    expect(content).toContain("deepseek-default");

    // CLI flags
    expect(content).toContain("--profile-id");
    expect(content).toContain("--profile-name");

    // Graceful shutdown wiring
    expect(content).toContain("SIGTERM");
    expect(content).toContain("SIGINT");

    // Turn separator on stdout
    expect(content).toContain("---");
  });

  test("threads the resolved provider through StreamContext.provider", async () => {
    const content = await readFile(SCRIPT_PATH, "utf-8");
    // The override field is StreamContext.provider — must be passed in ctx.
    expect(content).toMatch(/generateResponse\(messages,\s*systemPrompt,\s*\{[\s\S]*?provider/);
  });
});
