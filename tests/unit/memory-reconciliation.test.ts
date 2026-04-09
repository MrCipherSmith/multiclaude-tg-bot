import { describe, test, expect } from "bun:test";

/**
 * Memory reconciliation — pure parser tests.
 *
 * These tests do NOT hit a database or call the LLM.
 * They test the `parseReconcileDecision` logic from memory/long-term.ts —
 * the pure parser that turns LLM output strings into typed decisions.
 *
 * The parser is extracted inline here (same logic) to avoid importing
 * modules that have side-effectful top-level code (db connections, etc.).
 */

type ReconcileDecision =
  | { action: "ADD" }
  | { action: "UPDATE"; id: number; content: string }
  | { action: "DELETE"; id: number }
  | { action: "NOOP"; id: number };

function parseReconcileDecision(raw: string, similarIds: number[]): ReconcileDecision {
  const s = raw.trim();
  if (s === "ADD") return { action: "ADD" };
  if (s === "NOOP") return { action: "NOOP", id: similarIds[0] ?? -1 };

  const updateMatch = s.match(/^UPDATE id=(\d+) content="(.+)"$/s);
  if (updateMatch) return { action: "UPDATE", id: Number(updateMatch[1]), content: updateMatch[2] };

  const deleteMatch = s.match(/^DELETE id=(\d+)$/);
  if (deleteMatch) return { action: "DELETE", id: Number(deleteMatch[1]) };

  throw new Error(`unparseable decision: "${s.slice(0, 100)}"`);
}

/**
 * Simulate the threshold check: if no similar memories exist (or none close enough),
 * skip LLM and go straight to ADD.
 */
function decideWithoutLLM(
  similarDistances: number[],
  threshold: number,
): "ADD" | "call-llm" {
  if (similarDistances.length === 0) return "ADD";
  if (similarDistances[0] > threshold) return "ADD";
  return "call-llm";
}

// --- Tests ---

describe("parseReconcileDecision — ADD", () => {
  test("ADD when LLM returns 'ADD'", () => {
    const result = parseReconcileDecision("ADD", []);
    expect(result.action).toBe("ADD");
  });

  test("ADD with leading/trailing whitespace", () => {
    const result = parseReconcileDecision("  ADD  ", []);
    expect(result.action).toBe("ADD");
  });
});

describe("parseReconcileDecision — NOOP", () => {
  test("NOOP uses first similar memory ID", () => {
    const result = parseReconcileDecision("NOOP", [42, 99]);
    expect(result.action).toBe("NOOP");
    expect((result as any).id).toBe(42);
  });

  test("NOOP with no similar IDs defaults to -1", () => {
    const result = parseReconcileDecision("NOOP", []);
    expect(result.action).toBe("NOOP");
    expect((result as any).id).toBe(-1);
  });
});

describe("parseReconcileDecision — UPDATE", () => {
  test("UPDATE parses id and new content", () => {
    const result = parseReconcileDecision('UPDATE id=7 content="project uses PostgreSQL 16"', [7]);
    expect(result.action).toBe("UPDATE");
    expect((result as any).id).toBe(7);
    expect((result as any).content).toBe("project uses PostgreSQL 16");
  });

  test("UPDATE content with special characters", () => {
    const result = parseReconcileDecision('UPDATE id=3 content="uses port 3847, not 3000"', [3]);
    expect(result.action).toBe("UPDATE");
    expect((result as any).content).toBe("uses port 3847, not 3000");
  });

  test("UPDATE content with newlines (multiline content)", () => {
    const raw = 'UPDATE id=1 content="line one\nline two"';
    const result = parseReconcileDecision(raw, [1]);
    expect(result.action).toBe("UPDATE");
    expect((result as any).content).toContain("line one");
  });
});

describe("parseReconcileDecision — DELETE", () => {
  test("DELETE parses the id of the contradicted memory", () => {
    const result = parseReconcileDecision("DELETE id=15", [15]);
    expect(result.action).toBe("DELETE");
    expect((result as any).id).toBe(15);
  });
});

describe("parseReconcileDecision — invalid input", () => {
  test("throws on garbage input", () => {
    expect(() => parseReconcileDecision("whatever nonsense", [1])).toThrow("unparseable decision");
  });

  test("throws on empty string", () => {
    expect(() => parseReconcileDecision("", [1])).toThrow("unparseable decision");
  });

  test("throws on partial UPDATE (missing content)", () => {
    expect(() => parseReconcileDecision("UPDATE id=5", [5])).toThrow("unparseable decision");
  });
});

describe("Similarity threshold — skip LLM decision", () => {
  test("ADD when no similar memories found", () => {
    expect(decideWithoutLLM([], 0.3)).toBe("ADD");
  });

  test("ADD when best match distance > threshold", () => {
    // distance=0.8, threshold=0.3 → too dissimilar
    expect(decideWithoutLLM([0.8, 0.9], 0.3)).toBe("ADD");
  });

  test("call-llm when best match distance ≤ threshold", () => {
    // distance=0.1, threshold=0.3 → similar enough → ask LLM
    expect(decideWithoutLLM([0.1, 0.5], 0.3)).toBe("call-llm");
  });

  test("call-llm at exact threshold boundary", () => {
    expect(decideWithoutLLM([0.3], 0.3)).toBe("call-llm");
  });
});
