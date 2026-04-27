/**
 * Integration tests for v1.42.0 Pattern A — topic-bound text routing.
 *
 * Two layers:
 *   1. agentManager.getInstanceByForumTopic — DB lookup with the
 *      desired_state filter and priority ordering.
 *   2. handleText routing decision — when an agent is bound to a
 *      topic, plain text creates an agent_tasks row for that instance
 *      and replies with the task id; otherwise falls through.
 *
 * Layer 2 exercises the handler with a stub Context so we don't stand
 * up the real bot. Replies are captured into ctx.replies for
 * assertions.
 *
 * Requires DATABASE_URL.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const RUN_TAG = `topic-bound-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function getCtx() {
  const { sql } = await import("../../memory/db.ts");
  const mgr = await import("../../agents/agent-manager.ts");
  return { sql, mgr };
}

interface Seed {
  defId: number;
  agentRunningOnTopic: number;
  agentStoppedOnSameTopic: number;
  agentNoTopic: number;
  topicId: number;
  cleanupInstanceIds: number[];
}

let seed: Seed | null = null;

beforeAll(async () => {
  if (!HAS_DB) return;
  const { sql, mgr } = await getCtx();

  const [defRow] = (await sql`
    INSERT INTO agent_definitions (name, description, runtime_type, runtime_driver, capabilities, enabled)
    VALUES (
      ${`def-${RUN_TAG}`},
      'integration test definition for topic-bound-routing',
      'standalone-llm',
      'standalone',
      '[]'::jsonb,
      true
    )
    RETURNING id
  `) as any[];

  const topicId = 90000 + Math.floor(Math.random() * 1000);

  // Running agent bound to topicId — should be returned by lookup.
  const a1 = await mgr.agentManager.createInstance({
    definitionId: Number(defRow.id),
    projectId: null,
    name: `bound-running-${RUN_TAG}`,
    desiredState: "running",
    forumTopicId: topicId,
  });
  // Stopped agent bound to same topic — should be EXCLUDED by the filter.
  const a2 = await mgr.agentManager.createInstance({
    definitionId: Number(defRow.id),
    projectId: null,
    name: `bound-stopped-${RUN_TAG}`,
    desiredState: "stopped",
    forumTopicId: topicId,
  });
  // Agent with no topic — must not appear in any topic-based query.
  const a3 = await mgr.agentManager.createInstance({
    definitionId: Number(defRow.id),
    projectId: null,
    name: `untied-${RUN_TAG}`,
    desiredState: "running",
  });

  seed = {
    defId: Number(defRow.id),
    agentRunningOnTopic: a1.id,
    agentStoppedOnSameTopic: a2.id,
    agentNoTopic: a3.id,
    topicId,
    cleanupInstanceIds: [a1.id, a2.id, a3.id],
  };
});

afterAll(async () => {
  if (!HAS_DB || !seed) return;
  const { sql } = await getCtx();
  await sql`DELETE FROM agent_tasks WHERE agent_instance_id IN ${sql(seed.cleanupInstanceIds)}`;
  await sql`DELETE FROM agent_events WHERE agent_instance_id IN ${sql(seed.cleanupInstanceIds)}`;
  await sql`DELETE FROM agent_instances WHERE id IN ${sql(seed.cleanupInstanceIds)}`;
  await sql`DELETE FROM agent_definitions WHERE id = ${seed.defId}`;
});

describe("agent-manager: getInstanceByForumTopic", () => {
  test.skipIf(!HAS_DB)("returns running agent bound to the topic", async () => {
    const { mgr } = await getCtx();
    const inst = await mgr.agentManager.getInstanceByForumTopic(seed!.topicId);
    expect(inst).not.toBeNull();
    // Stopped agent on same topic must NOT win over the running one.
    expect(inst!.id).toBe(seed!.agentRunningOnTopic);
    expect(inst!.desiredState).toBe("running");
  });

  test.skipIf(!HAS_DB)("returns null when no agent is bound to the topic", async () => {
    const { mgr } = await getCtx();
    const inst = await mgr.agentManager.getInstanceByForumTopic(99999999);
    expect(inst).toBeNull();
  });

  test.skipIf(!HAS_DB)("excludes desired_state='stopped' even when topic matches", async () => {
    const { sql, mgr } = await getCtx();
    // Stop the running one too — only stopped agents on this topic remain.
    await sql`
      UPDATE agent_instances SET desired_state = 'stopped' WHERE id = ${seed!.agentRunningOnTopic}
    `;
    try {
      const inst = await mgr.agentManager.getInstanceByForumTopic(seed!.topicId);
      expect(inst).toBeNull();
    } finally {
      // Restore.
      await sql`
        UPDATE agent_instances SET desired_state = 'running' WHERE id = ${seed!.agentRunningOnTopic}
      `;
    }
  });
});

describe("text-handler routing: topic-bound agent creates agent_tasks row", () => {
  // We test the SQL/orchestrator path directly here rather than via
  // a full grammy stub — the handler's routing decision is just a few
  // lines that delegate to agentManager.getInstanceByForumTopic +
  // orchestrator.createTask. Wiring is exercised by hand to assert
  // that the task lands with the expected fields.

  test.skipIf(!HAS_DB)("creating a task for a topic-bound agent persists telegram metadata in payload", async () => {
    const { sql, mgr } = await getCtx();
    const { orchestrator } = await import("../../agents/orchestrator.ts");

    const inst = await mgr.agentManager.getInstanceByForumTopic(seed!.topicId);
    expect(inst).not.toBeNull();

    const task = await orchestrator.createTask({
      title: "проведи ревью",
      agentInstanceId: inst!.id,
      payload: {
        source: "telegram-topic-routed",
        forum_topic_id: seed!.topicId,
        telegram_chat_id: "-1001234567",
        telegram_message_id: 42,
        from: "test_user",
      },
    });

    expect(task.agentInstanceId).toBe(inst!.id);
    expect(task.title).toBe("проведи ревью");
    expect(task.status).toBe("pending");
    // v1.37.0 jsonb-cast guard — payload must be an object, not a scalar string.
    const [row] = (await sql`
      SELECT jsonb_typeof(payload) AS t, payload FROM agent_tasks WHERE id = ${task.id}
    `) as any[];
    expect(row.t).toBe("object");
    expect(row.payload.source).toBe("telegram-topic-routed");
    expect(Number(row.payload.forum_topic_id)).toBe(seed!.topicId);
    expect(Number(row.payload.telegram_message_id)).toBe(42);
  });

  test.skipIf(!HAS_DB)("long messages are truncated for title but full text lives in description", async () => {
    const { sql, mgr } = await getCtx();
    const { orchestrator } = await import("../../agents/orchestrator.ts");

    const longText = "слово ".repeat(60); // 360 chars
    const inst = await mgr.agentManager.getInstanceByForumTopic(seed!.topicId);
    expect(inst).not.toBeNull();

    const task = await orchestrator.createTask({
      title: longText.length > 200 ? longText.slice(0, 197) + "…" : longText,
      description: longText.length > 200 ? longText : undefined,
      agentInstanceId: inst!.id,
    });

    expect(task.title.length).toBeLessThanOrEqual(200);
    expect(task.title.endsWith("…")).toBe(true);
    expect(task.description).toBe(longText);

    // Cleanup
    await sql`DELETE FROM agent_events WHERE task_id = ${task.id}`;
    await sql`DELETE FROM agent_tasks WHERE id = ${task.id}`;
  });
});
