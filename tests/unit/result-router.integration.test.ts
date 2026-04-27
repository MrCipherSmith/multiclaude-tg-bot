/**
 * Integration tests — agents/result-router.ts (v1.39.0 Gap 4).
 *
 * Verifies the no-op semantics: getForumTopicId returns the bound id,
 * routeTaskResultToTopic short-circuits when the topic / chat / token
 * is missing. Does NOT actually call the Telegram API — that would
 * spam a real chat. The truthy "posted" path is left to live testing.
 *
 * Requires DATABASE_URL.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const RUN_TAG = `result-router-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function getCtx() {
  const { sql } = await import("../../memory/db.ts");
  const router = await import("../../agents/result-router.ts");
  const mgr = await import("../../agents/agent-manager.ts");
  return { sql, router, mgr };
}

interface Seed {
  defId: number;
  agentNoTopic: number;
  agentWithTopic: number;
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
      'integration test definition for result-router',
      'standalone-llm',
      'standalone',
      '[]'::jsonb,
      true
    )
    RETURNING id
  `) as any[];

  const a1 = await mgr.agentManager.createInstance({
    definitionId: Number(defRow.id),
    projectId: null,
    name: `no-topic-${RUN_TAG}`,
    desiredState: "stopped",
    forumTopicId: null,
  });
  const a2 = await mgr.agentManager.createInstance({
    definitionId: Number(defRow.id),
    projectId: null,
    name: `with-topic-${RUN_TAG}`,
    desiredState: "stopped",
    forumTopicId: 12345, // arbitrary, never actually posted to
  });

  seed = {
    defId: Number(defRow.id),
    agentNoTopic: a1.id,
    agentWithTopic: a2.id,
    cleanupInstanceIds: [a1.id, a2.id],
  };
});

afterAll(async () => {
  if (!HAS_DB || !seed) return;
  const { sql } = await getCtx();
  await sql`DELETE FROM agent_events WHERE agent_instance_id IN ${sql(seed.cleanupInstanceIds)}`;
  await sql`DELETE FROM agent_instances WHERE id IN ${sql(seed.cleanupInstanceIds)}`;
  await sql`DELETE FROM agent_definitions WHERE id = ${seed.defId}`;
});

describe("result-router — getForumTopicId", () => {
  test.skipIf(!HAS_DB)("returns null when agent has no forum_topic_id", async () => {
    const { router } = await getCtx();
    expect(await router.getForumTopicId(seed!.agentNoTopic)).toBeNull();
  });

  test.skipIf(!HAS_DB)("returns the bound topic id when set", async () => {
    const { router } = await getCtx();
    expect(await router.getForumTopicId(seed!.agentWithTopic)).toBe(12345);
  });

  test.skipIf(!HAS_DB)("returns null for non-existent agent", async () => {
    const { router } = await getCtx();
    expect(await router.getForumTopicId(999_999_999)).toBeNull();
  });
});

describe("result-router — routeTaskResultToTopic no-op cases", () => {
  test.skipIf(!HAS_DB)("returns false when agent has no forum_topic_id", async () => {
    const { router } = await getCtx();
    const posted = await router.routeTaskResultToTopic({
      agentInstanceId: seed!.agentNoTopic,
      agentName: "test",
      taskId: 1,
      taskTitle: "test",
      resultText: "hello",
    });
    expect(posted).toBe(false);
  });

  test.skipIf(!HAS_DB)("returns false when bot_config.forum_chat_id is unset (likely)", async () => {
    const { sql, router } = await getCtx();
    // Snapshot existing forum_chat_id to restore after the test.
    const [configRow] = (await sql`SELECT value FROM bot_config WHERE key = 'forum_chat_id'`) as any[];
    const previous = configRow?.value as string | undefined;
    // Force-clear so we can assert the no-op path. If a forum_chat_id IS
    // set in this DB (live ops), we still test the no-op behavior by
    // temporarily clearing it.
    await sql`DELETE FROM bot_config WHERE key = 'forum_chat_id'`;
    try {
      const posted = await router.routeTaskResultToTopic({
        agentInstanceId: seed!.agentWithTopic,
        agentName: "test",
        taskId: 1,
        taskTitle: "test",
        resultText: "hello",
      });
      expect(posted).toBe(false);
    } finally {
      if (previous != null) {
        await sql`INSERT INTO bot_config (key, value) VALUES ('forum_chat_id', ${previous})`;
      }
    }
  });
});
