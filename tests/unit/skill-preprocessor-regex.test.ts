// Regression test for B-08: hasInlineShellTokens used to return alternating
// false/true on the SAME body because a module-level /g regex advances
// lastIndex on each .test() call.

import { describe, test, expect } from "bun:test";
import { hasInlineShellTokens, expandInlineShell } from "../../utils/skill-preprocessor.ts";

describe("hasInlineShellTokens — stateless detection (B-08)", () => {
  test("returns true on every call for the same body", () => {
    const body = "Today: !`date +%Y`";
    for (let i = 0; i < 5; i++) {
      expect(hasInlineShellTokens(body)).toBe(true);
    }
  });

  test("returns false consistently for token-free body", () => {
    const body = "no tokens here";
    for (let i = 0; i < 5; i++) {
      expect(hasInlineShellTokens(body)).toBe(false);
    }
  });

  test("alternation between bodies does not flip detection", () => {
    expect(hasInlineShellTokens("a !`echo 1`")).toBe(true);
    expect(hasInlineShellTokens("plain")).toBe(false);
    expect(hasInlineShellTokens("b !`echo 2`")).toBe(true);
    expect(hasInlineShellTokens("plain2")).toBe(false);
  });
});

describe("expandInlineShell — duplicate identical tokens (F-004)", () => {
  test("two identical tokens are both expanded independently", async () => {
    const body = "A: !`echo same` and B: !`echo same`";
    const result = await expandInlineShell(body);
    expect(result.shellCount).toBe(2);
    // Both occurrences are replaced by the command output (`same\n`).
    // Count occurrences of "same" — the cmd was `echo same` so output is "same\n".
    const matches = result.body.match(/same/g);
    expect(matches?.length).toBeGreaterThanOrEqual(2);
    // The original `!`echo same`` token must NOT remain anywhere.
    expect(result.body).not.toContain("!`echo same`");
  });
});
