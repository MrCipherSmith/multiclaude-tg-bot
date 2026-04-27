/**
 * Integration tests — agents/context-injector.ts (v1.39.0 Gap 3).
 *
 * Verifies that buildProjectContext fetches project facts + recent
 * messages for a project-bound agent_instance, and formatProjectContext
 * renders them as a system-prompt-appendable block respecting the
 * character budget.
 *
 * Requires DATABASE_URL.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const RUN_TAG = `ctx-inj-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function getCtx() {
  const { sql } = await import("../../memory/db.ts");
  const inj = await import("../../agents/context-injector.ts");
  const mgr = await import("../../agents/agent-manager.ts");
  return { sql, inj, mgr };
}

interface Seed {
  defId: number;
  projectId: number;
  projectPath: string;
  projectName: string;
  agentWithProject: number;
  agentWithoutProject: number;
  agentEmptyProject: number;
  cleanupInstanceIds: number[];
  cleanupMemoryIds: number[];
  cleanupMessageIds: number[];
}

let seed: Seed | null = null;

beforeAll(async () => {
  if (!HAS_DB) return;
  const { sql, mgr } = await getCtx();

  // Project to bind agents to.
  const projectName = `proj-${RUN_TAG}`;
  const projectPath = `/tmp/${projectName}`;
  const [projRow] = (await sql`
    INSERT INTO projects (name, path, tmux_session_name)
    VALUES (${projectName}, ${projectPath}, 'bots')
    RETURNING id
  `) as any[];
  const projectId = Number(projRow.id);

  // Agent definition.
  const [defRow] = (await sql`
    INSERT INTO agent_definitions (name, description, runtime_type, runtime_driver, capabilities, enabled)
    VALUES (
      ${`def-${RUN_TAG}`},
      'integration test definition for context-injector',
      'standalone-llm',
      'standalone',
      '[]'::jsonb,
      true
    )
    RETURNING id
  `) as any[];

  // Three agent_instances:
  //  - withProject: bound to projectId, has facts + messages → full context
  //  - withoutProject: project_id IS NULL → returns null
  //  - emptyProject: bound to a SECOND project with no facts/messages → returns null
  const a1 = await mgr.agentManager.createInstance({
    definitionId: Number(defRow.id),
    projectId,
    name: `with-proj-${RUN_TAG}`,
    desiredState: "stopped",
  });
  const a2 = await mgr.agentManager.createInstance({
    definitionId: Number(defRow.id),
    projectId: null,
    name: `no-proj-${RUN_TAG}`,
    desiredState: "stopped",
  });
  // Second empty project.
  const [empProjRow] = (await sql`
    INSERT INTO projects (name, path, tmux_session_name)
    VALUES (${`empty-${RUN_TAG}`}, ${`/tmp/empty-${RUN_TAG}`}, 'bots')
    RETURNING id
  `) as any[];
  const a3 = await mgr.agentManager.createInstance({
    definitionId: Number(defRow.id),
    projectId: Number(empProjRow.id),
    name: `empty-proj-${RUN_TAG}`,
    desiredState: "stopped",
  });

  // Seed memories under projectPath. Mix of types: include 'fact' and
  // 'decision' (must surface) plus 'note' (must NOT surface).
  const memIds: number[] = [];
  for (const [type, content] of [
    ["fact", "Helyx uses postgres.js v3 — beware ::jsonb cast stripping (v1.37.0)."],
    ["fact", "admin-daemon runs on host via stdbuf -oL bun scripts/admin-daemon.ts."],
    ["decision", "Standalone-llm agents must receive AGENT_INSTANCE_ID env."],
    ["note", "TRANSIENT note — must not appear in context."],
  ] as const) {
    const [r] = (await sql`
      INSERT INTO memories (source, type, content, project_path)
      VALUES ('cli', ${type}, ${content}, ${projectPath})
      RETURNING id
    `) as any[];
    memIds.push(Number(r.id));
  }

  // Seed messages under projectPath. Include 5 turns alternating user/assistant.
  const msgIds: number[] = [];
  for (let i = 0; i < 5; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const [r] = (await sql`
      INSERT INTO messages (chat_id, role, content, project_path)
      VALUES ('test-chat', ${role}, ${`turn ${i}: ${role} says hello`}, ${projectPath})
      RETURNING id
    `) as any[];
    msgIds.push(Number(r.id));
  }

  seed = {
    defId: Number(defRow.id),
    projectId,
    projectPath,
    projectName,
    agentWithProject: a1.id,
    agentWithoutProject: a2.id,
    agentEmptyProject: a3.id,
    cleanupInstanceIds: [a1.id, a2.id, a3.id],
    cleanupMemoryIds: memIds,
    cleanupMessageIds: msgIds,
  };
});

afterAll(async () => {
  if (!HAS_DB || !seed) return;
  const { sql } = await getCtx();
  await sql`DELETE FROM agent_events WHERE agent_instance_id IN ${sql(seed.cleanupInstanceIds)}`;
  await sql`DELETE FROM agent_instances WHERE id IN ${sql(seed.cleanupInstanceIds)}`;
  await sql`DELETE FROM memories WHERE id IN ${sql(seed.cleanupMemoryIds)}`;
  await sql`DELETE FROM messages WHERE id IN ${sql(seed.cleanupMessageIds)}`;
  await sql`DELETE FROM agent_definitions WHERE id = ${seed.defId}`;
  await sql`DELETE FROM projects WHERE id = ${seed.projectId}`;
  await sql`DELETE FROM projects WHERE name = ${`empty-${RUN_TAG}`}`;
});

describe("context-injector — buildProjectContext", () => {
  test.skipIf(!HAS_DB)("returns null for project-less agent", async () => {
    const { inj } = await getCtx();
    const ctx = await inj.buildProjectContext(seed!.agentWithoutProject);
    expect(ctx).toBeNull();
  });

  test.skipIf(!HAS_DB)("returns null when project has no facts and no messages", async () => {
    const { inj } = await getCtx();
    const ctx = await inj.buildProjectContext(seed!.agentEmptyProject);
    expect(ctx).toBeNull();
  });

  test.skipIf(!HAS_DB)("returns project info, facts, and messages for bound agent", async () => {
    const { inj } = await getCtx();
    const ctx = await inj.buildProjectContext(seed!.agentWithProject);
    expect(ctx).not.toBeNull();
    expect(ctx!.projectName).toBe(seed!.projectName);
    expect(ctx!.projectPath).toBe(seed!.projectPath);
    // 3 facts/decisions seeded; 'note' type filtered out.
    expect(ctx!.facts.length).toBe(3);
    expect(ctx!.facts.every((f) => !f.includes("TRANSIENT note"))).toBe(true);
    expect(ctx!.recentMessages.length).toBe(5);
  });

  test.skipIf(!HAS_DB)("messages are oldest-first after reverse (natural reading order)", async () => {
    const { inj } = await getCtx();
    const ctx = await inj.buildProjectContext(seed!.agentWithProject);
    expect(ctx).not.toBeNull();
    // First message is "turn 0", last is "turn 4".
    expect(ctx!.recentMessages[0]!.content).toContain("turn 0");
    expect(ctx!.recentMessages[ctx!.recentMessages.length - 1]!.content).toContain("turn 4");
  });
});

describe("context-injector — formatProjectContext", () => {
  test.skipIf(!HAS_DB)("renders project header + facts + messages sections", async () => {
    const { inj } = await getCtx();
    const ctx = await inj.buildProjectContext(seed!.agentWithProject);
    const out = inj.formatProjectContext(ctx!);
    expect(out).toContain("## Project:");
    expect(out).toContain(seed!.projectName);
    expect(out).toContain("### Project facts (3):");
    expect(out).toContain("### Recent conversation");
    expect(out).toContain("postgres.js");
  });

  test.skipIf(!HAS_DB)("does NOT include filtered 'note' type entries", async () => {
    const { inj } = await getCtx();
    const ctx = await inj.buildProjectContext(seed!.agentWithProject);
    const out = inj.formatProjectContext(ctx!);
    expect(out).not.toContain("TRANSIENT note");
  });

  test.skipIf(!HAS_DB)("respects the 4000-char character budget", async () => {
    const { inj } = await getCtx();
    // Build a synthetic ctx with many huge facts. Budget should bite.
    const longFacts = Array.from({ length: 50 }, (_, i) => `fact ${i}: ${"x".repeat(200)}`);
    const synthetic: import("../../agents/context-injector.ts").ProjectContext = {
      projectName: "x",
      projectPath: "/x",
      facts: longFacts,
      recentMessages: [],
    };
    const out = inj.formatProjectContext(synthetic);
    expect(out.length).toBeLessThan(4500); // budget + small overhead per line
    // Some facts must have been truncated.
    expect(out).toContain("fact 0:");
    expect(out).not.toContain("fact 49:");
  });
});
