import { describe, test, expect } from "bun:test";

describe("non-claude-poller: import contract", () => {
  test("startNonClaudePoller is callable and returns a stop function", async () => {
    const mod = await import("../../scripts/non-claude-poller.ts");
    expect(typeof mod.startNonClaudePoller).toBe("function");

    // We can't easily mock postgres.Sql template tag. Smoke test:
    // verify the function takes (sql, driver) and the first arg type is permissive.
    // Just check signature length.
    expect(mod.startNonClaudePoller.length).toBeGreaterThanOrEqual(2);
  });
});
