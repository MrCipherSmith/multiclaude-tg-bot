/**
 * Integration tests for v1.44.0 Pattern C — MCP-driven task pull/complete.
 *
 * Verifies the SQL behavior of `agents/task-mcp-bridge.ts`:
 *  - claimNextPendingTask: picks oldest pending, marks in_progress,
 *    skip-locked, returns null when none.
 *  - completeTask: refuses non-in_progress states, persists result as
 *    JSONB object, fires result-router (no-op when no topic), audit
 *    event recorded.
 *  - failTask: flips to failed; idempotent on already-terminal.
 *
 * Requires DATABASE_URL.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const RUN_TAG = `mcp-bridge-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function getCtx() {
  const { sql } = await import("../../memory/db.ts");
  const bridge = await import("../../agents/task-mcp-bridge.ts");
  const mgr = await import("../../agents/agent-manager.ts");
  return { sql, bridge, mgr };
}

interface Seed {
  defId: number;
  agentId: number;
  cleanupTaskIds: number[];
  cleanupInstanceIds: number[];
}

let seed: Seed | null = null;

beforeAll(async () => {
  if (!HAS_DB) return;
  const { sql, mgr } = await getCtx();
  const [defRow] = (await sql`
    INSERT INTO agent_definitions (name, description, runtime_type, runtime_driver, capabilities, enabled)
    VALUES (
      ${`mcp-def-${RUN_TAG}`},
      'integration test definition for task-mcp-bridge',
      'standalone-llm',
      'standalone',
      '[]'::jsonb,
      true
    )
    RETURNING id
  `) as any[];
  const inst = await mgr.agentManager.createInstance({
    definitionId: Number(defRow.id),
    projectId: null,
    name: `mcp-agent-${RUN_TAG}`,
    desiredState: "running",
  });
  seed = {
    defId: Number(defRow.id),
    agentId: inst.id,
    cleanupTaskIds: [],
    cleanupInstanceIds: [inst.id],
  };
});

afterAll(async () => {
  if (!HAS_DB || !seed) return;
  const { sql } = await getCtx();
  if (seed.cleanupTaskIds.length > 0) {
    await sql`DELETE FROM agent_events WHERE task_id IN ${sql(seed.cleanupTaskIds)}`;
    await sql`DELETE FROM agent_tasks WHERE id IN ${sql(seed.cleanupTaskIds)}`;
  }
  await sql`DELETE FROM agent_events WHERE agent_instance_id IN ${sql(seed.cleanupInstanceIds)}`;
  await sql`DELETE FROM agent_instances WHERE id IN ${sql(seed.cleanupInstanceIds)}`;
  await sql`DELETE FROM agent_definitions WHERE id = ${seed.defId}`;
});

describe("claimNextPendingTask", () => {
  test.skipIf(!HAS_DB)("returns null when no pending tasks for the agent", async () => {
    const { bridge } = await getCtx();
    const claimed = await bridge.claimNextPendingTask(seed!.agentId);
    expect(claimed).toBeNull();
  });

  test.skipIf(!HAS_DB)("claims oldest pending task and flips status to in_progress", async () => {
    const { sql, bridge } = await getCtx();
    const [task] = (await sql`
      INSERT INTO agent_tasks (agent_instance_id, title, status, payload, priority)
      VALUES (${seed!.agentId}, ${`first-${RUN_TAG}`}, ${"pending"}, ${sql.json({ kind: "demo" })}, 5)
      RETURNING id
    `) as any[];
    seed!.cleanupTaskIds.push(Number(task.id));

    const claimed = await bridge.claimNextPendingTask(seed!.agentId);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(Number(task.id));
    expect(claimed!.priority).toBe(5);
    expect(claimed!.payload.kind).toBe("demo");

    const [post] = (await sql`SELECT status FROM agent_tasks WHERE id = ${task.id}`) as any[];
    expect(post.status).toBe("in_progress");

    const events = (await sql`
      SELECT event_type, from_state, to_state FROM agent_events
      WHERE task_id = ${task.id} AND event_type = 'task_status_change'
      ORDER BY id DESC LIMIT 1
    `) as any[];
    expect(events[0].from_state).toBe("pending");
    expect(events[0].to_state).toBe("in_progress");
  });

  test.skipIf(!HAS_DB)("respects priority ordering (lower number first)", async () => {
    const { sql, bridge } = await getCtx();
    const [low] = (await sql`
      INSERT INTO agent_tasks (agent_instance_id, title, status, priority)
      VALUES (${seed!.agentId}, ${`low-prio-${RUN_TAG}`}, ${"pending"}, 9)
      RETURNING id
    `) as any[];
    const [high] = (await sql`
      INSERT INTO agent_tasks (agent_instance_id, title, status, priority)
      VALUES (${seed!.agentId}, ${`high-prio-${RUN_TAG}`}, ${"pending"}, 0)
      RETURNING id
    `) as any[];
    seed!.cleanupTaskIds.push(Number(low.id), Number(high.id));

    const claimed = await bridge.claimNextPendingTask(seed!.agentId);
    expect(claimed!.id).toBe(Number(high.id));
  });
});

describe("completeTask", () => {
  test.skipIf(!HAS_DB)("happy path: in_progress → done, result persisted as JSONB object", async () => {
    const { sql, bridge } = await getCtx();
    const [task] = (await sql`
      INSERT INTO agent_tasks (agent_instance_id, title, status)
      VALUES (${seed!.agentId}, ${`complete-${RUN_TAG}`}, ${"in_progress"})
      RETURNING id
    `) as any[];
    seed!.cleanupTaskIds.push(Number(task.id));

    const out = await bridge.completeTask(Number(task.id), "all good — no issues found");
    expect(out.ok).toBe(true);
    expect(out.taskId).toBe(Number(task.id));
    // Agent has no forum_topic_id → posted_to_topic must be false.
    expect(out.postedToTopic).toBe(false);

    const [post] = (await sql`
      SELECT status, jsonb_typeof(result) AS rt, result FROM agent_tasks WHERE id = ${task.id}
    `) as any[];
    expect(post.status).toBe("done");
    // v1.37.0 guard — result MUST be JSONB object, not scalar string.
    expect(post.rt).toBe("object");
    expect(post.result.output).toBe("all good — no issues found");
  });

  test.skipIf(!HAS_DB)("rejects task that is not in_progress (pending → throws)", async () => {
    const { sql, bridge } = await getCtx();
    const [task] = (await sql`
      INSERT INTO agent_tasks (agent_instance_id, title, status)
      VALUES (${seed!.agentId}, ${`refuse-pending-${RUN_TAG}`}, ${"pending"})
      RETURNING id
    `) as any[];
    seed!.cleanupTaskIds.push(Number(task.id));

    await expect(bridge.completeTask(Number(task.id), "x")).rejects.toThrow(/expected 'in_progress'/);
  });

  test.skipIf(!HAS_DB)("rejects task that does not exist", async () => {
    const { bridge } = await getCtx();
    await expect(bridge.completeTask(999_999_999, "x")).rejects.toThrow(/not found/);
  });

  test.skipIf(!HAS_DB)("rejects empty result", async () => {
    const { bridge } = await getCtx();
    await expect(bridge.completeTask(1, "")).rejects.toThrow(/result required/);
  });

  test.skipIf(!HAS_DB)("caps oversized result text", async () => {
    const { sql, bridge } = await getCtx();
    const [task] = (await sql`
      INSERT INTO agent_tasks (agent_instance_id, title, status)
      VALUES (${seed!.agentId}, ${`cap-${RUN_TAG}`}, ${"in_progress"})
      RETURNING id
    `) as any[];
    seed!.cleanupTaskIds.push(Number(task.id));

    const huge = "x".repeat(60_000);
    await bridge.completeTask(Number(task.id), huge);

    const [post] = (await sql`SELECT result FROM agent_tasks WHERE id = ${task.id}`) as any[];
    const out = post.result.output as string;
    expect(out.length).toBeLessThan(50_100);
    expect(out.endsWith("…(truncated)")).toBe(true);
  });
});

describe("failTask", () => {
  test.skipIf(!HAS_DB)("happy path: in_progress → failed", async () => {
    const { sql, bridge } = await getCtx();
    const [task] = (await sql`
      INSERT INTO agent_tasks (agent_instance_id, title, status)
      VALUES (${seed!.agentId}, ${`fail-${RUN_TAG}`}, ${"in_progress"})
      RETURNING id
    `) as any[];
    seed!.cleanupTaskIds.push(Number(task.id));

    const out = await bridge.failTask(Number(task.id), "lint setup absent");
    expect(out.status).toBe("failed");

    const [post] = (await sql`SELECT status FROM agent_tasks WHERE id = ${task.id}`) as any[];
    expect(post.status).toBe("failed");
  });

  test.skipIf(!HAS_DB)("idempotent on already-terminal status (does NOT flip done → failed)", async () => {
    const { sql, bridge } = await getCtx();
    const [task] = (await sql`
      INSERT INTO agent_tasks (agent_instance_id, title, status)
      VALUES (${seed!.agentId}, ${`already-done-${RUN_TAG}`}, ${"done"})
      RETURNING id
    `) as any[];
    seed!.cleanupTaskIds.push(Number(task.id));

    const out = await bridge.failTask(Number(task.id), "spurious");
    expect(out.status).toBe("done"); // unchanged

    // Audit event recorded as fail_task_noop.
    const events = (await sql`
      SELECT event_type FROM agent_events
      WHERE task_id = ${task.id} AND event_type = 'fail_task_noop'
    `) as any[];
    expect(events.length).toBe(1);
  });

  test.skipIf(!HAS_DB)("requires reason", async () => {
    const { bridge } = await getCtx();
    await expect(bridge.failTask(1, "")).rejects.toThrow(/reason required/);
  });
});

describe("getTaskResult (v1.45.0)", () => {
  test.skipIf(!HAS_DB)("returns full row + joined agent/definition names for done task", async () => {
    const { sql, bridge } = await getCtx();
    const [task] = (await sql`
      INSERT INTO agent_tasks (agent_instance_id, title, description, status, payload, result)
      VALUES (
        ${seed!.agentId},
        ${`get-result-${RUN_TAG}`},
        ${"the description"},
        ${"done"},
        ${sql.json({ source: "test" })},
        ${sql.json({ output: "review verdict: APPROVE" })}
      )
      RETURNING id
    `) as any[];
    seed!.cleanupTaskIds.push(Number(task.id));

    const view = await bridge.getTaskResult(Number(task.id));
    expect(view).not.toBeNull();
    expect(view!.id).toBe(Number(task.id));
    expect(view!.title).toBe(`get-result-${RUN_TAG}`);
    expect(view!.description).toBe("the description");
    expect(view!.status).toBe("done");
    expect(view!.agent_instance_id).toBe(seed!.agentId);
    expect(view!.agent_name).toBe(`mcp-agent-${RUN_TAG}`);
    expect(view!.definition_name).toBe(`mcp-def-${RUN_TAG}`);
    expect((view!.result as any).output).toBe("review verdict: APPROVE");
    expect((view!.payload as any).source).toBe("test");
    expect(view!.completed_at).toBeNull(); // we didn't set completed_at
    expect(typeof view!.created_at).toBe("string");
  });

  test.skipIf(!HAS_DB)("returns null for non-existent task id", async () => {
    const { bridge } = await getCtx();
    const view = await bridge.getTaskResult(999_999_999);
    expect(view).toBeNull();
  });

  test.skipIf(!HAS_DB)("works for tasks with NULL result (still pending or no-op done)", async () => {
    const { sql, bridge } = await getCtx();
    const [task] = (await sql`
      INSERT INTO agent_tasks (agent_instance_id, title, status)
      VALUES (${seed!.agentId}, ${`null-result-${RUN_TAG}`}, ${"pending"})
      RETURNING id
    `) as any[];
    seed!.cleanupTaskIds.push(Number(task.id));

    const view = await bridge.getTaskResult(Number(task.id));
    expect(view).not.toBeNull();
    expect(view!.result).toBeNull();
    expect(view!.status).toBe("pending");
  });

  test.skipIf(!HAS_DB)("rejects non-numeric task_id", async () => {
    const { bridge } = await getCtx();
    await expect(bridge.getTaskResult(NaN as any)).rejects.toThrow(/task_id required/);
  });

  test.skipIf(!HAS_DB)("returns parent_task_id for nested tasks", async () => {
    const { sql, bridge } = await getCtx();
    const [parent] = (await sql`
      INSERT INTO agent_tasks (agent_instance_id, title, status)
      VALUES (${seed!.agentId}, ${`parent-${RUN_TAG}`}, ${"done"})
      RETURNING id
    `) as any[];
    const [child] = (await sql`
      INSERT INTO agent_tasks (agent_instance_id, parent_task_id, title, status)
      VALUES (${seed!.agentId}, ${parent.id}, ${`child-${RUN_TAG}`}, ${"pending"})
      RETURNING id
    `) as any[];
    seed!.cleanupTaskIds.push(Number(parent.id), Number(child.id));

    const view = await bridge.getTaskResult(Number(child.id));
    expect(view!.parent_task_id).toBe(Number(parent.id));
  });
});

describe("end-to-end: claim → complete chain", () => {
  test.skipIf(!HAS_DB)("a freshly-pending task can be claimed and then completed", async () => {
    const { sql, bridge } = await getCtx();
    // Earlier tests left some pending tasks for this agent (priority test
    // created a `low-prio-…` row that's still pending). Clean slate so
    // claim returns OUR e2e task, not a leftover.
    await sql`
      DELETE FROM agent_tasks
      WHERE agent_instance_id = ${seed!.agentId} AND status = 'pending'
    `;

    const [task] = (await sql`
      INSERT INTO agent_tasks (agent_instance_id, title, status)
      VALUES (${seed!.agentId}, ${`e2e-${RUN_TAG}`}, ${"pending"})
      RETURNING id
    `) as any[];
    seed!.cleanupTaskIds.push(Number(task.id));

    const claimed = await bridge.claimNextPendingTask(seed!.agentId);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(Number(task.id));

    const completed = await bridge.completeTask(claimed!.id, "review ok");
    expect(completed.ok).toBe(true);

    // Subsequent claim must return null — no pending left.
    const second = await bridge.claimNextPendingTask(seed!.agentId);
    expect(second).toBeNull();
  });
});
