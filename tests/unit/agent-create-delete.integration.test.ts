/**
 * Integration tests for /agent_create + /agent_delete bot commands and
 * the underlying agentManager.deleteInstance helper.
 *
 * The bot handlers themselves take a grammy Context — we exercise the
 * core paths via direct agentManager calls (DB-level behavior) and a
 * minimal stub Context that captures replies. This lets us verify both
 * the manager API and the handler validation/error branches without
 * standing up a full bot.
 *
 * Requires DATABASE_URL.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const RUN_TAG = `agent-cd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function getCtx() {
  const { sql } = await import("../../memory/db.ts");
  const mgr = await import("../../agents/agent-manager.ts");
  const cmd = await import("../../bot/commands/agent-create.ts");
  return { sql, mgr, cmd };
}

interface SeedRow {
  defId: number;
  defName: string;
  cleanupInstanceIds: number[];
}

let seed: SeedRow | null = null;

beforeAll(async () => {
  if (!HAS_DB) return;
  const { sql } = await getCtx();
  const defName = `def-${RUN_TAG}`;
  const [def] = (await sql`
    INSERT INTO agent_definitions (name, description, runtime_type, runtime_driver, capabilities, enabled)
    VALUES (
      ${defName},
      'integration test definition for agent-create',
      'standalone-llm',
      'standalone',
      '[]'::jsonb,
      true
    )
    RETURNING id
  `) as any[];
  seed = { defId: Number(def.id), defName, cleanupInstanceIds: [] };
});

afterAll(async () => {
  if (!HAS_DB || !seed) return;
  const { sql } = await getCtx();
  if (seed.cleanupInstanceIds.length > 0) {
    await sql`DELETE FROM agent_events WHERE agent_instance_id IN ${sql(seed.cleanupInstanceIds)}`;
    await sql`DELETE FROM agent_instances WHERE id IN ${sql(seed.cleanupInstanceIds)}`;
  }
  await sql`DELETE FROM agent_definitions WHERE id = ${seed.defId}`;
});

/**
 * Minimal grammy Context stub. Captures the last reply payload so tests
 * can assert against it. `message.text` drives the command argument
 * parsing.
 */
function makeCtx(text: string) {
  const replies: Array<{ text: string; opts?: any }> = [];
  return {
    message: { text },
    reply: async (txt: string, opts?: any) => {
      replies.push({ text: txt, opts });
    },
    replies,
  } as any;
}

describe("agentManager.deleteInstance", () => {
  test.skipIf(!HAS_DB)("returns true when row exists, deletes it", async () => {
    const { mgr } = await getCtx();
    const inst = await mgr.agentManager.createInstance({
      definitionId: seed!.defId,
      projectId: null,
      name: `delete-target-${RUN_TAG}`,
      desiredState: "stopped",
    });
    seed!.cleanupInstanceIds.push(inst.id);

    const removed = await mgr.agentManager.deleteInstance(inst.id);
    expect(removed).toBe(true);
    expect(await mgr.agentManager.getInstance(inst.id)).toBeNull();
  });

  test.skipIf(!HAS_DB)("returns false when row does not exist (idempotent)", async () => {
    const { mgr } = await getCtx();
    const removed = await mgr.agentManager.deleteInstance(999_999_999);
    expect(removed).toBe(false);
  });
});

describe("/agent_create — argument validation", () => {
  test.skipIf(!HAS_DB)("missing args → usage message", async () => {
    const { cmd } = await getCtx();
    const ctx = makeCtx("/agent_create");
    await cmd.handleAgentCreate(ctx);
    expect(ctx.replies.length).toBe(1);
    expect(ctx.replies[0].text).toContain("Usage:");
  });

  test.skipIf(!HAS_DB)("only one arg → usage message", async () => {
    const { cmd } = await getCtx();
    const ctx = makeCtx("/agent_create only-name");
    await cmd.handleAgentCreate(ctx);
    expect(ctx.replies[0].text).toContain("Usage:");
  });

  test.skipIf(!HAS_DB)("unknown definition → 'not found' error", async () => {
    const { cmd } = await getCtx();
    const ctx = makeCtx(`/agent_create ${RUN_TAG}-x def-nonexistent-${RUN_TAG}`);
    await cmd.handleAgentCreate(ctx);
    expect(ctx.replies[0].text).toContain("not found");
  });

  test.skipIf(!HAS_DB)("unknown project → 'project not found' error", async () => {
    const { cmd } = await getCtx();
    const ctx = makeCtx(`/agent_create ${RUN_TAG}-p ${seed!.defName} project-nonexistent-${RUN_TAG}`);
    await cmd.handleAgentCreate(ctx);
    expect(ctx.replies[0].text).toContain("project");
    expect(ctx.replies[0].text).toContain("not found");
  });
});

describe("/agent_create — happy path", () => {
  test.skipIf(!HAS_DB)("creates project-less instance with desired=running", async () => {
    const { sql, cmd } = await getCtx();
    const name = `create-running-${RUN_TAG}`;
    const ctx = makeCtx(`/agent_create ${name} ${seed!.defName}`);
    await cmd.handleAgentCreate(ctx);

    expect(ctx.replies[0].text).toContain("✅ Created");

    const [row] = (await sql`SELECT id, desired_state FROM agent_instances WHERE name = ${name}`) as any[];
    expect(row).toBeDefined();
    expect(row.desired_state).toBe("running");
    seed!.cleanupInstanceIds.push(Number(row.id));
  });

  test.skipIf(!HAS_DB)("--stopped flag creates instance with desired=stopped", async () => {
    const { sql, cmd } = await getCtx();
    const name = `create-stopped-${RUN_TAG}`;
    const ctx = makeCtx(`/agent_create ${name} ${seed!.defName} --stopped`);
    await cmd.handleAgentCreate(ctx);

    expect(ctx.replies[0].text).toContain("✅ Created");

    const [row] = (await sql`SELECT id, desired_state FROM agent_instances WHERE name = ${name}`) as any[];
    expect(row).toBeDefined();
    expect(row.desired_state).toBe("stopped");
    seed!.cleanupInstanceIds.push(Number(row.id));
  });

  test.skipIf(!HAS_DB)("emits 'instance_created' agent_event with metadata as object", async () => {
    const { sql, cmd } = await getCtx();
    const name = `create-event-${RUN_TAG}`;
    const ctx = makeCtx(`/agent_create ${name} ${seed!.defName}`);
    await cmd.handleAgentCreate(ctx);

    const [row] = (await sql`SELECT id FROM agent_instances WHERE name = ${name}`) as any[];
    seed!.cleanupInstanceIds.push(Number(row.id));

    const events = (await sql`
      SELECT jsonb_typeof(metadata) AS t, metadata
      FROM agent_events
      WHERE agent_instance_id = ${Number(row.id)} AND event_type = 'instance_created'
    `) as any[];
    expect(events.length).toBe(1);
    // Regression guard for the v1.37.0 systemic jsonb fix — must be 'object'.
    expect(events[0].t).toBe("object");
    expect((events[0].metadata as any).source).toBe("telegram");
    expect((events[0].metadata as any).definition_name).toBe(seed!.defName);
  });

  test.skipIf(!HAS_DB)("rejects duplicate name (project_id IS NULL uniqueness)", async () => {
    const { sql, cmd } = await getCtx();
    const name = `create-dup-${RUN_TAG}`;
    // First create succeeds.
    await cmd.handleAgentCreate(makeCtx(`/agent_create ${name} ${seed!.defName}`));
    const [row] = (await sql`SELECT id FROM agent_instances WHERE name = ${name}`) as any[];
    seed!.cleanupInstanceIds.push(Number(row.id));

    // Second call must surface a 'already exists' error rather than
    // letting the DB throw a duplicate-key. Pre-flight check is in the
    // handler.
    const ctx2 = makeCtx(`/agent_create ${name} ${seed!.defName}`);
    await cmd.handleAgentCreate(ctx2);
    expect(ctx2.replies[0].text).toContain("already exists");
  });
});

describe("/agent_create — v1.39.0 flags (--prompt, --topic)", () => {
  test.skipIf(!HAS_DB)("--prompt sets system_prompt_override on the instance", async () => {
    const { sql, cmd } = await getCtx();
    const name = `create-prompt-${RUN_TAG}`;
    const promptText = "Be concise. Always respond in JSON.";
    const ctx = makeCtx(`/agent_create ${name} ${seed!.defName} --prompt "${promptText}"`);
    await cmd.handleAgentCreate(ctx);

    expect(ctx.replies[0].text).toContain("✅ Created");
    expect(ctx.replies[0].text).toContain("prompt override");

    const [row] = (await sql`
      SELECT id, system_prompt_override FROM agent_instances WHERE name = ${name}
    `) as any[];
    expect(row.system_prompt_override).toBe(promptText);
    seed!.cleanupInstanceIds.push(Number(row.id));
  });

  test.skipIf(!HAS_DB)("--topic sets forum_topic_id on the instance", async () => {
    const { sql, cmd } = await getCtx();
    const name = `create-topic-${RUN_TAG}`;
    const ctx = makeCtx(`/agent_create ${name} ${seed!.defName} --topic 42`);
    await cmd.handleAgentCreate(ctx);

    expect(ctx.replies[0].text).toContain("✅ Created");
    expect(ctx.replies[0].text).toContain("forum_topic_id=42");

    const [row] = (await sql`
      SELECT id, forum_topic_id FROM agent_instances WHERE name = ${name}
    `) as any[];
    expect(Number(row.forum_topic_id)).toBe(42);
    seed!.cleanupInstanceIds.push(Number(row.id));
  });

  test.skipIf(!HAS_DB)("--topic without numeric value → parse error", async () => {
    const { cmd } = await getCtx();
    const ctx = makeCtx(`/agent_create x ${seed!.defName} --topic not-a-number`);
    await cmd.handleAgentCreate(ctx);
    expect(ctx.replies[0].text).toContain("--topic requires a numeric");
  });

  test.skipIf(!HAS_DB)("--prompt without value → parse error", async () => {
    const { cmd } = await getCtx();
    const ctx = makeCtx(`/agent_create x ${seed!.defName} --prompt`);
    await cmd.handleAgentCreate(ctx);
    expect(ctx.replies[0].text).toContain("--prompt requires a value");
  });

  test.skipIf(!HAS_DB)("unknown --flag → parse error", async () => {
    const { cmd } = await getCtx();
    const ctx = makeCtx(`/agent_create x ${seed!.defName} --whatever`);
    await cmd.handleAgentCreate(ctx);
    expect(ctx.replies[0].text).toContain("unknown flag");
  });

  test.skipIf(!HAS_DB)("--prompt + --topic + project name combine correctly", async () => {
    const { sql, cmd } = await getCtx();
    const name = `create-combo-${RUN_TAG}`;
    const ctx = makeCtx(`/agent_create ${name} ${seed!.defName} --topic 99 --prompt "combined"`);
    await cmd.handleAgentCreate(ctx);
    expect(ctx.replies[0].text).toContain("✅ Created");

    const [row] = (await sql`
      SELECT id, system_prompt_override, forum_topic_id FROM agent_instances WHERE name = ${name}
    `) as any[];
    expect(row.system_prompt_override).toBe("combined");
    expect(Number(row.forum_topic_id)).toBe(99);
    seed!.cleanupInstanceIds.push(Number(row.id));
  });
});

describe("/agent_delete — argument validation", () => {
  test.skipIf(!HAS_DB)("non-numeric id → usage", async () => {
    const { cmd } = await getCtx();
    const ctx = makeCtx("/agent_delete not-a-number");
    await cmd.handleAgentDelete(ctx);
    expect(ctx.replies[0].text).toContain("Usage:");
  });

  test.skipIf(!HAS_DB)("missing id → usage", async () => {
    const { cmd } = await getCtx();
    const ctx = makeCtx("/agent_delete");
    await cmd.handleAgentDelete(ctx);
    expect(ctx.replies[0].text).toContain("Usage:");
  });

  test.skipIf(!HAS_DB)("unknown id → 'not found'", async () => {
    const { cmd } = await getCtx();
    const ctx = makeCtx("/agent_delete 999999999");
    await cmd.handleAgentDelete(ctx);
    expect(ctx.replies[0].text).toContain("not found");
  });

  test.skipIf(!HAS_DB)("valid id → confirmation prompt with inline buttons", async () => {
    const { mgr, cmd } = await getCtx();
    const inst = await mgr.agentManager.createInstance({
      definitionId: seed!.defId,
      projectId: null,
      name: `delete-confirm-${RUN_TAG}`,
      desiredState: "stopped",
    });
    seed!.cleanupInstanceIds.push(inst.id);

    const ctx = makeCtx(`/agent_delete ${inst.id}`);
    await cmd.handleAgentDelete(ctx);
    expect(ctx.replies[0].text).toContain("Delete");
    expect(ctx.replies[0].text).toContain(inst.name);
    // Inline keyboard must be present.
    expect(ctx.replies[0].opts.reply_markup).toBeDefined();
  });
});
