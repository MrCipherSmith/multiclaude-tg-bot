/**
 * Unit tests for skill preprocessor — inline shell expansion.
 * Pure function tests, no DB or filesystem access.
 */
import { describe, test, expect } from "bun:test";
import { expandInlineShell, parseFrontmatter, hasInlineShellTokens } from "../../utils/skill-preprocessor.ts";

describe("hasInlineShellTokens", () => {
  test("detects shell token", () => {
    expect(hasInlineShellTokens("Hello !`date` world")).toBe(true);
  });

  test("no token in plain text", () => {
    expect(hasInlineShellTokens("Hello world")).toBe(false);
  });

  test("no token in backtick-only text", () => {
    expect(hasInlineShellTokens("`not a shell`")).toBe(false);
  });
});

describe("expandInlineShell", () => {
  test("no token — returns input unchanged", async () => {
    const result = await expandInlineShell("Hello world");
    expect(result.body).toBe("Hello world");
    expect(result.shellCount).toBe(0);
    expect(result.errorsCount).toBe(0);
  });

  test("single shell token expands to stdout", async () => {
    const result = await expandInlineShell("Today: !`echo 2026-04-30`");
    expect(result.body).toMatch(/^Today: 2026-04-30\n?$/);
    expect(result.shellCount).toBe(1);
    expect(result.errorsCount).toBe(0);
  });

  test("failing shell token shows error inline", async () => {
    const result = await expandInlineShell("Result: !`exit 1`");
    expect(result.body).toMatch(/^Result: \[inline-shell error: /);
    expect(result.errorsCount).toBe(1);
  });

  test("timeout produces timeout marker", async () => {
    const result = await expandInlineShell("Wait: !`sleep 3`");
    // Default timeout is 5000ms so sleep 3 should be OK
    expect(result.body).toMatch(/^Wait: /);
    expect(result.errorsCount).toBe(0);
  });
});

describe("parseFrontmatter", () => {
  test("parses YAML frontmatter", () => {
    const input = `---
name: test-skill
description: Use when testing
version: 1.0.0
---

# Body content

Some text here.`;
    const { frontmatter, body } = parseFrontmatter(input);
    expect(frontmatter.name).toBe("test-skill");
    expect(frontmatter.description).toBe("Use when testing");
    expect(frontmatter.version).toBe("1.0.0");
    expect(body).toBe("# Body content\n\nSome text here.");
  });

  test("no frontmatter returns empty object and full text as body", () => {
    const input = "# Just a heading\n\nSome text.";
    const { frontmatter, body } = parseFrontmatter(input);
    expect(frontmatter).toEqual({});
    expect(body).toBe(input);
  });

  test("empty frontmatter block", () => {
    const input = "---\n---\n\nBody text.";
    const { frontmatter, body } = parseFrontmatter(input);
    expect(frontmatter).toEqual({});
    expect(body).toBe("Body text.");
  });
});
