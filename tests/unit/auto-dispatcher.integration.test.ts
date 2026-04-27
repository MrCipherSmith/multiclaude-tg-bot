/**
 * Integration tests for v1.40.0 Pattern B — auto-dispatch from
 * orchestrator JSON output.
 *
 * Verifies:
 *  - tryParseDecomposition: handles plain JSON, fenced JSON,
 *    malformed input, schema-invalid input.
 *  - maybeDispatchOrchestration:
 *      * skips when agent definition lacks 'orchestrate' capability
 *      * skips when result is unparseable
 *      * skips when result fails schema validation
 *      * dispatches subtasks (with FK to parent) when agent IS
 *        orchestrate-capable AND output parses
 *      * records orchestration_dispatched audit event
 *
 * Requires DATABASE_URL.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const RUN_TAG = `auto-dispatch-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function getCtx() {
  const { sql } = await import("../../memory/db.ts");
  const dispatcher = await import("../../agents/auto-dispatcher.ts");
  const orch = await import("../../agents/orchestrator.ts");
  const mgr = await import("../../agents/agent-manager.ts");
  return { sql, dispatcher, orch, mgr };
}

interface Seed {
  orchDefId: number;
  plainDefId: number;
  orchAgentId: number;
  plainAgentId: number;
  cleanupTaskIds: number[];
  cleanupInstanceIds: number[];
  cleanupDefIds: number[];
}

let seed: Seed | null = null;

beforeAll(async () => {
  if (!HAS_DB) return;
  const { sql, mgr } = await getCtx();

  // Definition WITH orchestrate capability — eligible for auto-dispatch.
  const [orchDef] = (await sql`
    INSERT INTO agent_definitions (name, description, runtime_type, runtime_driver, capabilities, enabled)
    VALUES (
      ${`orch-def-${RUN_TAG}`},
      'integration test orchestrator definition',
      'standalone-llm',
      'standalone',
      ${sql.json(["orchestrate", "plan"])},
      true
    )
    RETURNING id
  `) as any[];

  // Definition WITHOUT orchestrate — generic agent, must NOT auto-dispatch.
  const [plainDef] = (await sql`
    INSERT INTO agent_definitions (name, description, runtime_type, runtime_driver, capabilities, enabled)
    VALUES (
      ${`plain-def-${RUN_TAG}`},
      'integration test plain definition',
      'standalone-llm',
      'standalone',
      ${sql.json(["code", "review"])},
      true
    )
    RETURNING id
  `) as any[];

  const orchAgent = await mgr.agentManager.createInstance({
    definitionId: Number(orchDef.id),
    projectId: null,
    name: `orch-agent-${RUN_TAG}`,
    desiredState: "running",
  });
  const plainAgent = await mgr.agentManager.createInstance({
    definitionId: Number(plainDef.id),
    projectId: null,
    name: `plain-agent-${RUN_TAG}`,
    desiredState: "running",
  });

  // We also need a TARGET agent that has the capabilities the
  // dispatched subtasks request, so selectAgent has a candidate.
  // Otherwise createTask succeeds but agentInstanceId is null
  // (no_match) — still valid, the FK linkage to the parent is what
  // we care about for these tests.
  // Tests below seed extra capabilities only when needed.

  seed = {
    orchDefId: Number(orchDef.id),
    plainDefId: Number(plainDef.id),
    orchAgentId: orchAgent.id,
    plainAgentId: plainAgent.id,
    cleanupTaskIds: [],
    cleanupInstanceIds: [orchAgent.id, plainAgent.id],
    cleanupDefIds: [Number(orchDef.id), Number(plainDef.id)],
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
  await sql`DELETE FROM agent_definitions WHERE id IN ${sql(seed.cleanupDefIds)}`;
});

describe("auto-dispatcher — tryParseDecomposition (pure)", () => {
  test("parses plain JSON", async () => {
    const { dispatcher } = await getCtx();
    const result = dispatcher.tryParseDecomposition(
      JSON.stringify({
        subtasks: [
          { title: "first", capabilities: ["code"], priority: 0 },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.subtasks.length).toBe(1);
      expect(result.value.subtasks[0]!.title).toBe("first");
    }
  });

  test("strips ```json fenced markdown wrapper", async () => {
    const { dispatcher } = await getCtx();
    const result = dispatcher.tryParseDecomposition(
      '```json\n{"subtasks":[{"title":"x","capabilities":[],"priority":0}]}\n```',
    );
    expect(result.ok).toBe(true);
  });

  test("returns unparseable_output for malformed JSON", async () => {
    const { dispatcher } = await getCtx();
    const result = dispatcher.tryParseDecomposition("this is not JSON at all");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unparseable_output");
    }
  });

  test("returns schema_invalid for valid JSON that fails schema", async () => {
    const { dispatcher } = await getCtx();
    const result = dispatcher.tryParseDecomposition(
      JSON.stringify({ subtasks: [{ title: "" /* empty title fails */, capabilities: [] }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema_invalid");
    }
  });

  test("returns schema_invalid for empty subtasks array (min 1 enforced)", async () => {
    const { dispatcher } = await getCtx();
    const result = dispatcher.tryParseDecomposition(JSON.stringify({ subtasks: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema_invalid");
    }
  });
});

describe("auto-dispatcher — maybeDispatchOrchestration", () => {
  test.skipIf(!HAS_DB)("skips when agent definition lacks 'orchestrate' capability", async () => {
    const { sql, dispatcher, orch } = await getCtx();
    const task = await orch.orchestrator.createTask({
      title: `parent-plain-${RUN_TAG}`,
      agentInstanceId: seed!.plainAgentId,
    });
    seed!.cleanupTaskIds.push(task.id);

    const validJson = JSON.stringify({
      subtasks: [{ title: "child", capabilities: ["code"], priority: 0 }],
    });
    const result = await dispatcher.maybeDispatchOrchestration(task, validJson);

    expect(result.dispatched).toBe(false);
    expect(result.skipReason).toBe("no_orchestrate_capability");
    expect(result.subtaskIds.length).toBe(0);

    // No children should have been created.
    const children = (await sql`SELECT id FROM agent_tasks WHERE parent_task_id = ${task.id}`) as any[];
    expect(children.length).toBe(0);
  });

  test.skipIf(!HAS_DB)("skips when output is unparseable", async () => {
    const { dispatcher, orch } = await getCtx();
    const task = await orch.orchestrator.createTask({
      title: `parent-unparse-${RUN_TAG}`,
      agentInstanceId: seed!.orchAgentId,
    });
    seed!.cleanupTaskIds.push(task.id);

    const result = await dispatcher.maybeDispatchOrchestration(task, "totally not JSON");
    expect(result.dispatched).toBe(false);
    expect(result.skipReason).toBe("unparseable_output");
  });

  test.skipIf(!HAS_DB)("skips when output fails schema (e.g., empty title)", async () => {
    const { dispatcher, orch } = await getCtx();
    const task = await orch.orchestrator.createTask({
      title: `parent-schema-${RUN_TAG}`,
      agentInstanceId: seed!.orchAgentId,
    });
    seed!.cleanupTaskIds.push(task.id);

    const invalid = JSON.stringify({ subtasks: [{ title: "", capabilities: [] }] });
    const result = await dispatcher.maybeDispatchOrchestration(task, invalid);
    expect(result.dispatched).toBe(false);
    expect(result.skipReason).toBe("schema_invalid");
  });

  test.skipIf(!HAS_DB)("dispatches subtasks with parent FK for orchestrate-capable agent + valid output", async () => {
    const { sql, dispatcher, orch } = await getCtx();
    const task = await orch.orchestrator.createTask({
      title: `parent-success-${RUN_TAG}`,
      agentInstanceId: seed!.orchAgentId,
    });
    seed!.cleanupTaskIds.push(task.id);

    const plan = {
      subtasks: [
        { title: "step 1: analyze", capabilities: ["analyze"], priority: 0 },
        { title: "step 2: plan", capabilities: ["plan"], priority: 1 },
        { title: "step 3: review", capabilities: ["review"], priority: 5 },
      ],
    };
    const result = await dispatcher.maybeDispatchOrchestration(task, JSON.stringify(plan));

    expect(result.dispatched).toBe(true);
    expect(result.skipReason).toBeNull();
    expect(result.subtaskIds.length).toBe(3);
    seed!.cleanupTaskIds.push(...result.subtaskIds);

    // Verify FK linkage and persisted fields.
    const children = (await sql`
      SELECT id, title, parent_task_id, priority, payload
      FROM agent_tasks WHERE parent_task_id = ${task.id}
      ORDER BY priority ASC, id ASC
    `) as any[];
    expect(children.length).toBe(3);
    for (const c of children) {
      expect(Number(c.parent_task_id)).toBe(task.id);
      expect(c.payload.source).toBe("auto-dispatch");
      expect(Number(c.payload.parent_orchestrator_task_id)).toBe(task.id);
      expect(Array.isArray(c.payload.required_capabilities)).toBe(true);
    }
    expect(children[0]!.title).toBe("step 1: analyze");
    expect(children[1]!.title).toBe("step 2: plan");
    expect(children[2]!.title).toBe("step 3: review");
  });

  test.skipIf(!HAS_DB)("records orchestration_dispatched audit event with subtask metadata", async () => {
    const { sql, dispatcher, orch } = await getCtx();
    const task = await orch.orchestrator.createTask({
      title: `parent-audit-${RUN_TAG}`,
      agentInstanceId: seed!.orchAgentId,
    });
    seed!.cleanupTaskIds.push(task.id);

    const plan = {
      subtasks: [{ title: "single", capabilities: [], priority: 0 }],
    };
    const result = await dispatcher.maybeDispatchOrchestration(task, JSON.stringify(plan));
    expect(result.dispatched).toBe(true);
    seed!.cleanupTaskIds.push(...result.subtaskIds);

    const events = (await sql`
      SELECT event_type, jsonb_typeof(metadata) AS meta_t, metadata
      FROM agent_events
      WHERE task_id = ${task.id} AND event_type = 'orchestration_dispatched'
      ORDER BY id DESC LIMIT 1
    `) as any[];
    expect(events.length).toBe(1);
    // v1.37.0 jsonb-cast guard — must be 'object' not 'string'.
    expect(events[0]!.meta_t).toBe("object");
    expect(events[0]!.metadata.subtask_count).toBe(1);
    expect(events[0]!.metadata.requested_count).toBe(1);
    expect(Array.isArray(events[0]!.metadata.subtask_ids)).toBe(true);
    expect(events[0]!.metadata.subtask_ids[0]).toBe(result.subtaskIds[0]);
  });
});
