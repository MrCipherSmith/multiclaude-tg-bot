// Phase B tests: curator JSON markdown stripping (M-05) and prompt loadability.

import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";

function stripJsonFences(content: string): string {
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1]!.trim();
  return content.trim();
}

describe("stripJsonFences (M-05)", () => {
  test("strips ```json ... ``` fence", () => {
    const input = '```json\n{"actions":[]}\n```';
    expect(stripJsonFences(input)).toBe('{"actions":[]}');
  });

  test("strips ``` ... ``` fence without language tag", () => {
    const input = '```\n{"x":1}\n```';
    expect(stripJsonFences(input)).toBe('{"x":1}');
  });

  test("returns trimmed input when no fence", () => {
    const input = '  {"x":1}  ';
    expect(stripJsonFences(input)).toBe('{"x":1}');
  });

  test("handles fence with surrounding prose", () => {
    const input = 'Here is the result:\n```json\n{"x":1}\n```\nLet me know if you need more.';
    expect(stripJsonFences(input)).toBe('{"x":1}');
  });

  test("handles raw JSON with no fence", () => {
    const input = '{"actions":[{"name":"x","action":"pin","reason":"recent"}]}';
    expect(stripJsonFences(input)).toBe(input);
  });
});

describe("prompts/skill-curation.md", () => {
  test("exists and is non-empty", async () => {
    const path = resolve(import.meta.dir, "../../prompts/skill-curation.md");
    const content = await Bun.file(path).text();
    expect(content.length).toBeGreaterThan(100);
    expect(content).toContain("skill-curation aux");
  });
});
