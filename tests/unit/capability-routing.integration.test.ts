/**
 * Integration test — capability-based routing through orchestrator.selectAgent
 * and orchestrator.handleFailure.
 *
 * Locks in the v1.34.1 fix: postgres.js v3 silently strips trailing `::jsonb`
 * casts on parameter placeholders, so the original `@> ${json}::jsonb` form
 * bound the parameter as TEXT and never matched any row. Replaced with
 * `@> ${sql.json(required)}` which forces JSONB encoding at the wire-protocol
 * level. If anyone reverts to the broken form, ALL of these tests fail —
 * selectAgent returns null and handleFailure flips to no_alternative for
 * every capability lookup.
 *
 * Requires DATABASE_URL pointing at a live helyx schema. Tests are gated
 * via `test.skipIf(!HAS_DB)` to keep CI green when the DB isn't reachable.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// Unique tag avoids cross-run collisions when this file is executed in
// parallel with other tests against the same DB.
const RUN_TAG = `cap-routing-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CAP_A = `${RUN_TAG}:capA`;
const CAP_B = `${RUN_TAG}:capB`;
const CAP_C_OTHER = `${RUN_TAG}:capC-other`;
const CAP_NEVER = `${RUN_TAG}:never-assigned`;

// Lazily resolved on first use so the import side-effects of orchestrator
// (which opens a postgres pool) don't run when HAS_DB is false.
async function getCtx() {
  const { sql } = await import("../../memory/db.ts");
  const orch = await import("../../agents/orchestrator.ts");
  return { sql, orch };
}

interface SeedRow {
  defAId: number;
  defCId: number;
  agentA1Id: number;
  agentA2Id: number;
  agentCId: number;
  cleanupTaskIds: number[];
}

let seed: SeedRow | null = null;

beforeAll(async () => {
  if (!HAS_DB) return;
  const { sql } = await getCtx();

  // defA — has capabilities [CAP_A, CAP_B]; two instances point at it.
  const [defA] = (await sql`
    INSERT INTO agent_definitions (name, description, runtime_type, runtime_driver, capabilities, enabled)
    VALUES (
      ${`def-A-${RUN_TAG}`},
      'integration test definition A',
      'standalone-llm',
      'standalone',
      ${sql.json([CAP_A, CAP_B])},
      true
    )
    RETURNING id
  `) as any[];
  // defC — has capabilities [CAP_C_OTHER]; control group, must NOT match A/B queries.
  const [defC] = (await sql`
    INSERT INTO agent_definitions (name, description, runtime_type, runtime_driver, capabilities, enabled)
    VALUES (
      ${`def-C-${RUN_TAG}`},
      'integration test definition C',
      'standalone-llm',
      'standalone',
      ${sql.json([CAP_C_OTHER])},
      true
    )
    RETURNING id
  `) as any[];

  const [agentA1] = (await sql`
    INSERT INTO agent_instances (definition_id, project_id, name, desired_state, actual_state)
    VALUES (${defA.id}, NULL, ${`a1-${RUN_TAG}`}, 'running', 'running')
    RETURNING id
  `) as any[];
  const [agentA2] = (await sql`
    INSERT INTO agent_instances (definition_id, project_id, name, desired_state, actual_state)
    VALUES (${defA.id}, NULL, ${`a2-${RUN_TAG}`}, 'running', 'running')
    RETURNING id
  `) as any[];
  const [agentC] = (await sql`
    INSERT INTO agent_instances (definition_id, project_id, name, desired_state, actual_state)
    VALUES (${defC.id}, NULL, ${`c-${RUN_TAG}`}, 'running', 'running')
    RETURNING id
  `) as any[];

  seed = {
    defAId: Number(defA.id),
    defCId: Number(defC.id),
    agentA1Id: Number(agentA1.id),
    agentA2Id: Number(agentA2.id),
    agentCId: Number(agentC.id),
    cleanupTaskIds: [],
  };
});

afterAll(async () => {
  if (!HAS_DB || !seed) return;
  const { sql } = await getCtx();

  // Order matters: events → tasks → instances → definitions (FK chain).
  if (seed.cleanupTaskIds.length > 0) {
    await sql`DELETE FROM agent_events WHERE task_id IN ${sql(seed.cleanupTaskIds)}`;
    await sql`DELETE FROM agent_tasks WHERE id IN ${sql(seed.cleanupTaskIds)}`;
  }
  await sql`DELETE FROM agent_events WHERE agent_instance_id IN ${sql([
    seed.agentA1Id, seed.agentA2Id, seed.agentCId,
  ])}`;
  await sql`DELETE FROM agent_instances WHERE id IN ${sql([
    seed.agentA1Id, seed.agentA2Id, seed.agentCId,
  ])}`;
  await sql`DELETE FROM agent_definitions WHERE id IN ${sql([seed.defAId, seed.defCId])}`;
});

describe("capability routing — selectAgent (jsonb @> containment)", () => {
  test.skipIf(!HAS_DB)("matches when required is a strict subset of definition.capabilities", async () => {
    const { orch } = await getCtx();
    // Required = [CAP_A] — defA has [CAP_A, CAP_B], so it contains the requirement.
    const result = await orch.orchestrator.selectAgent([CAP_A]);
    expect(result).not.toBeNull();
    expect([seed!.agentA1Id, seed!.agentA2Id]).toContain(result!.id);
  });

  test.skipIf(!HAS_DB)("matches when required equals definition.capabilities", async () => {
    const { orch } = await getCtx();
    const result = await orch.orchestrator.selectAgent([CAP_A, CAP_B]);
    expect(result).not.toBeNull();
    expect([seed!.agentA1Id, seed!.agentA2Id]).toContain(result!.id);
  });

  test.skipIf(!HAS_DB)("returns null when required has cap not in any definition (regression guard)", async () => {
    const { orch } = await getCtx();
    // CAP_NEVER doesn't exist on any definition. If the jsonb cast is broken
    // and the param binds as TEXT, @> never matches and returns null too —
    // so this assertion alone wouldn't catch regression. Pair it with the
    // positive-match tests above.
    const result = await orch.orchestrator.selectAgent([CAP_NEVER]);
    expect(result).toBeNull();
  });

  test.skipIf(!HAS_DB)("returns null when required mixes one matching and one missing cap", async () => {
    const { orch } = await getCtx();
    // CAP_A is on defA, CAP_NEVER is nowhere. @> requires ALL be present.
    const result = await orch.orchestrator.selectAgent([CAP_A, CAP_NEVER]);
    expect(result).toBeNull();
  });

  test.skipIf(!HAS_DB)("does not pick an agent whose definition has only an unrelated cap", async () => {
    const { orch } = await getCtx();
    // Search for CAP_A — defC (CAP_C_OTHER) must not match.
    const result = await orch.orchestrator.selectAgent([CAP_A]);
    expect(result).not.toBeNull();
    expect(result!.id).not.toBe(seed!.agentCId);
  });
});

describe("capability routing — handleFailure (jsonb @> in reassignment lookup)", () => {
  test.skipIf(!HAS_DB)("reassigns failed task to alternative agent with matching capabilities", async () => {
    const { sql, orch } = await getCtx();

    // Create a task assigned to agentA1 with required_capabilities = [CAP_A].
    // This lets handleFailure (a) look up the agent's def caps OR (b) fall
    // back to payload.required_capabilities. Both paths use the same jsonb @>
    // candidate query — we exercise (a) by relying on definition lookup.
    const [taskRow] = (await sql`
      INSERT INTO agent_tasks (agent_instance_id, title, status, payload)
      VALUES (${seed!.agentA1Id}, ${`task-${RUN_TAG}-A`}, 'in_progress', ${sql.json({
        required_capabilities: [CAP_A],
      })})
      RETURNING id
    `) as any[];
    const taskId = Number(taskRow.id);
    seed!.cleanupTaskIds.push(taskId);

    const result = await orch.orchestrator.handleFailure(taskId, {
      reason: `integration-test-${RUN_TAG}`,
    });

    expect(result.outcome).toBe("reassigned");
    // Reassigned to agentA2 because agentA1 (the failing one) is excluded.
    expect(result.newAgentInstanceId).toBe(seed!.agentA2Id);
    expect(result.task.agentInstanceId).toBe(seed!.agentA2Id);
    expect(result.task.status).toBe("pending");
  });

  test.skipIf(!HAS_DB)("flips to no_alternative when caller excludes every capability-matching agent", async () => {
    const { sql, orch } = await getCtx();

    const [taskRow] = (await sql`
      INSERT INTO agent_tasks (agent_instance_id, title, status, payload)
      VALUES (${seed!.agentA1Id}, ${`task-${RUN_TAG}-B`}, 'in_progress', ${sql.json({
        required_capabilities: [CAP_A],
      })})
      RETURNING id
    `) as any[];
    const taskId = Number(taskRow.id);
    seed!.cleanupTaskIds.push(taskId);

    // Exclude both A1 and A2 — there is no other agent with CAP_A in the system.
    const result = await orch.orchestrator.handleFailure(taskId, {
      reason: `integration-test-${RUN_TAG}-no-alt`,
      excludeAgentIds: [seed!.agentA1Id, seed!.agentA2Id],
    });

    expect(result.outcome).toBe("no_alternative");
    expect(result.newAgentInstanceId).toBeNull();
    expect(result.task.status).toBe("failed");
  });

  test.skipIf(!HAS_DB)("payload.required_capabilities path also resolves correctly", async () => {
    const { sql, orch } = await getCtx();

    // Task with no agent_instance_id — handleFailure must read caps from payload
    // (definition-lookup branch is skipped because there's no failing agent).
    const [taskRow] = (await sql`
      INSERT INTO agent_tasks (agent_instance_id, title, status, payload)
      VALUES (NULL, ${`task-${RUN_TAG}-C`}, 'in_progress', ${sql.json({
        required_capabilities: [CAP_B],
      })})
      RETURNING id
    `) as any[];
    const taskId = Number(taskRow.id);
    seed!.cleanupTaskIds.push(taskId);

    const result = await orch.orchestrator.handleFailure(taskId, {
      reason: `integration-test-${RUN_TAG}-payload-path`,
    });

    expect(result.outcome).toBe("reassigned");
    // Either A1 or A2 — both definitions contain CAP_B.
    expect([seed!.agentA1Id, seed!.agentA2Id]).toContain(result.newAgentInstanceId);
  });
});
