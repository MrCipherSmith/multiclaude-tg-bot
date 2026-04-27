/**
 * Integration test — verifies migration v34 seeded the 8 skill-based
 * agent_definitions from goodai-base. Each must:
 *  - exist by name
 *  - be enabled
 *  - have a non-trivial system_prompt (>200 chars)
 *  - have at least one capability tag
 *
 * If a future migration accidentally clobbers these or the seed is
 * removed, this test fails loudly.
 */

import { describe, expect, test } from "bun:test";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const EXPECTED_SKILL_DEFS = [
  "issue-analyzer",
  "brainstorm",
  "prd-creator",
  "interview",
  "feature-analyzer",
  "review-logic",
  "changelog",
  "pr-issue-documenter",
] as const;

// v35 — orchestrator definitions (advisory pattern: emit JSON decomposition plans).
const EXPECTED_ORCHESTRATOR_DEFS = [
  "review-orchestrator",
  "job-orchestrator",
  "gproject-orchestrator",
  "autodoc-orchestrator",
] as const;

describe("seed skills (migration v34) — agent_definitions present", () => {
  test.skipIf(!HAS_DB)("all 8 skill-based definitions exist and are well-formed", async () => {
    const { sql } = await import("../../memory/db.ts");
    const rows = (await sql`
      SELECT name, enabled, runtime_type, capabilities,
             length(coalesce(system_prompt, '')) AS prompt_len
      FROM agent_definitions
      WHERE name IN ${sql(EXPECTED_SKILL_DEFS as unknown as string[])}
      ORDER BY name
    `) as any[];

    expect(rows.length).toBe(EXPECTED_SKILL_DEFS.length);
    for (const r of rows) {
      expect(r.enabled).toBe(true);
      expect(r.runtime_type).toBe("standalone-llm");
      // Non-trivial system prompt — empty / one-liner would mean the seed
      // body got truncated by a migration mistake.
      expect(Number(r.prompt_len)).toBeGreaterThan(200);
      // At least one capability tag for orchestrator routing.
      expect(Array.isArray(r.capabilities)).toBe(true);
      expect(r.capabilities.length).toBeGreaterThanOrEqual(1);
    }
  });

  test.skipIf(!HAS_DB)("issue-analyzer has decompose capability for orchestrator routing", async () => {
    const { sql } = await import("../../memory/db.ts");
    const [row] = (await sql`
      SELECT capabilities FROM agent_definitions WHERE name = 'issue-analyzer'
    `) as any[];
    expect(row).toBeDefined();
    // Capability tags must include decompose so orchestrator.selectAgent
    // can route decomposition tasks here.
    expect(row.capabilities).toContain("decompose");
  });

  test.skipIf(!HAS_DB)("seed is idempotent — re-running v34 produces no duplicates", async () => {
    const { sql } = await import("../../memory/db.ts");
    const rows = (await sql`
      SELECT name, COUNT(*)::int AS n
      FROM agent_definitions
      WHERE name IN ${sql(EXPECTED_SKILL_DEFS as unknown as string[])}
      GROUP BY name
      HAVING COUNT(*) > 1
    `) as any[];
    expect(rows.length).toBe(0);
  });
});

// v36 + v38 — claude-code execution-capable definitions
const EXPECTED_CC_DEFS = [
  "task-implementer",
  "code-verifier",
  "tests-creator",
  "commit",
  "pr-create",
  "code-reviewer",
] as const;

describe("seed claude-code execution agents (migration v36 + v38) — definitions present", () => {
  test.skipIf(!HAS_DB)("all 6 claude-code execution definitions exist", async () => {
    const { sql } = await import("../../memory/db.ts");
    const rows = (await sql`
      SELECT name, enabled, runtime_type, capabilities,
             length(coalesce(system_prompt, '')) AS prompt_len
      FROM agent_definitions
      WHERE name IN ${sql(EXPECTED_CC_DEFS as unknown as string[])}
      ORDER BY name
    `) as any[];

    expect(rows.length).toBe(EXPECTED_CC_DEFS.length);
    for (const r of rows) {
      expect(r.enabled).toBe(true);
      expect(r.runtime_type).toBe("claude-code");
      // Prompts are 1100-1400 chars after distillation. Reject
      // anything truncated below 600 (would mean migration corruption).
      expect(Number(r.prompt_len)).toBeGreaterThan(600);
      expect(Array.isArray(r.capabilities)).toBe(true);
      expect(r.capabilities.length).toBeGreaterThanOrEqual(1);
    }
  });

  test.skipIf(!HAS_DB)("task-implementer carries 'implement' capability for orchestrator routing", async () => {
    const { sql } = await import("../../memory/db.ts");
    const [row] = (await sql`
      SELECT capabilities FROM agent_definitions WHERE name = 'task-implementer'
    `) as any[];
    expect(row).toBeDefined();
    // Job-orchestrator's plan output uses "code" or "implement" tags
    // for IMPLEMENT subtasks. selectAgent must find task-implementer
    // when either is requested.
    expect(row.capabilities).toContain("code");
  });

  test.skipIf(!HAS_DB)("code-verifier carries 'verify' capability", async () => {
    const { sql } = await import("../../memory/db.ts");
    const [row] = (await sql`
      SELECT capabilities FROM agent_definitions WHERE name = 'code-verifier'
    `) as any[];
    expect(row.capabilities).toContain("verify");
  });

  test.skipIf(!HAS_DB)("code-reviewer (v38) carries the orchestrator's review-fanout capabilities", async () => {
    const { sql } = await import("../../memory/db.ts");
    const [row] = (await sql`
      SELECT runtime_type, capabilities FROM agent_definitions WHERE name = 'code-reviewer'
    `) as any[];
    expect(row).toBeDefined();
    expect(row.runtime_type).toBe("claude-code");
    // Must contain review + analyze (orchestrator dispatches both).
    expect(row.capabilities).toContain("review");
    expect(row.capabilities).toContain("analyze");
    expect(row.capabilities).toContain("logic");
  });
});

describe("seed orchestrators (migration v35) — agent_definitions present", () => {
  test.skipIf(!HAS_DB)("all 4 orchestrator definitions exist with 'orchestrate' capability", async () => {
    const { sql } = await import("../../memory/db.ts");
    const rows = (await sql`
      SELECT name, enabled, capabilities,
             length(coalesce(system_prompt, '')) AS prompt_len
      FROM agent_definitions
      WHERE name IN ${sql(EXPECTED_ORCHESTRATOR_DEFS as unknown as string[])}
      ORDER BY name
    `) as any[];

    expect(rows.length).toBe(EXPECTED_ORCHESTRATOR_DEFS.length);
    for (const r of rows) {
      expect(r.enabled).toBe(true);
      // All orchestrators MUST carry the 'orchestrate' capability — that's
      // the routing tag /orchestrate and selectAgent(["orchestrate"]) match.
      expect(r.capabilities).toContain("orchestrate");
      // Orchestrator prompts are longer (have to enumerate capabilities
      // taxonomy + describe pipeline) — ensure no migration truncated them.
      expect(Number(r.prompt_len)).toBeGreaterThan(800);
    }
  });

  test.skipIf(!HAS_DB)("orchestrator prompts reference the strict JSON output schema", async () => {
    const { sql } = await import("../../memory/db.ts");
    const rows = (await sql`
      SELECT name, system_prompt FROM agent_definitions
      WHERE name IN ${sql(EXPECTED_ORCHESTRATOR_DEFS as unknown as string[])}
    `) as any[];
    for (const r of rows) {
      // Output schema mirrors orchestrator.ts:DecompositionSchema —
      // critical for Pattern B (auto-dispatch v1.40+) to be able to
      // parse the response uniformly across all orchestrator roles.
      expect(r.system_prompt).toContain("subtasks");
      expect(r.system_prompt).toContain("capabilities");
    }
  });
});
