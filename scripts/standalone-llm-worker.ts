/**
 * Standalone-LLM agent worker (PRD §10.4).
 *
 * Long-running loop that:
 *   1. Polls agent_tasks for tasks assigned to this agent_instance with
 *      status='pending'
 *   2. Atomically claims one (UPDATE … RETURNING with FOR UPDATE)
 *   3. Builds a chat prompt from the task title + description + payload
 *   4. Calls generateResponse() through the agent's model_profile
 *   5. Writes the result + status='completed' on success, status='failed' on error
 *   6. Emits agent_events for traceability
 *   7. Sleeps a short interval and repeats
 *
 * This is the "MVP" version of the standalone-llm adapter:
 *   - No tool execution (the model can only generate text)
 *   - No streaming (whole response at once)
 *   - No multi-turn (one task = one prompt + one response)
 *   - No structured output / schema enforcement
 *
 * The model_profile_id binding lives on agent_definitions; this worker
 * looks up its own definition by agent_instance_id passed in via env or
 * argv. Heartbeat is updated on every poll so the watchdog can detect
 * a wedged worker.
 */

import { sql } from "../memory/db.ts";
import { generateResponse, type MessageParam, type StreamContext } from "../llm/client.ts";
import { resolveProfile, resolveSessionProvider } from "../llm/profile-resolver.ts";
import { logger } from "../logger.ts";

const POLL_INTERVAL_MS = Number(process.env.STANDALONE_LLM_POLL_MS ?? "3000");
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_TASK_RETRIES = 1; // task gets one retry before going to handleFailure path

const agentInstanceId = Number(process.env.AGENT_INSTANCE_ID ?? process.argv[2] ?? "");
if (!agentInstanceId || !Number.isFinite(agentInstanceId)) {
  console.error(
    "[standalone-llm-worker] AGENT_INSTANCE_ID env var or argv[2] required (numeric)",
  );
  process.exit(2);
}

console.log(`[standalone-llm-worker] starting for agent_instance_id=${agentInstanceId}`);

let running = true;
process.on("SIGTERM", () => { running = false; });
process.on("SIGINT", () => { running = false; });

/**
 * Resolve the agent's model profile from its definition. Falls back to
 * env-driven defaults when the definition has no profile bound (legacy
 * compatibility). Returns null on hard failure (definition missing) so
 * the worker can exit cleanly.
 */
interface AgentContext {
  defName: string;
  systemPrompt: string | null;
  provider: Awaited<ReturnType<typeof resolveProfile>>;
}

/**
 * Single roundtrip to the DB to fetch everything processOneTask needs:
 * the agent's definition (name + system_prompt) and the resolved
 * provider config. F-021 from PR #7 review collapsed two separate
 * queries into one.
 *
 * Returns null on hard failure (definition missing) so the worker can
 * skip the task without crashing.
 */
async function resolveAgentContext(agentId: number): Promise<AgentContext | null> {
  // `ad.enabled = true` filter (F-008-followup): if an operator disables
  // the definition while the worker is running, processOneTask should
  // fail the next task rather than continue silently with the disabled
  // config. The worker exits its loop on subsequent claim failures since
  // `failTask` correctly fires regardless.
  const rows = (await sql`
    SELECT ad.id AS def_id, ad.name AS def_name, ad.system_prompt, ad.model_profile_id, ad.enabled
    FROM agent_instances ai
    JOIN agent_definitions ad ON ad.id = ai.definition_id
    WHERE ai.id = ${agentId} AND ad.enabled = true
    LIMIT 1
  `) as { def_id: number; def_name: string; system_prompt: string | null; model_profile_id: number | null }[];
  if (rows.length === 0) return null;
  const row = rows[0]!;
  const provider = row.model_profile_id
    ? await resolveProfile(row.model_profile_id)
    : await resolveSessionProvider(null);
  return {
    defName: row.def_name,
    systemPrompt: row.system_prompt,
    provider,
  };
}

async function setActualState(state: "running" | "idle" | "busy" | "stopping" | "failed", message?: string) {
  await sql`
    UPDATE agent_instances
    SET actual_state = ${state}, last_health_at = now(), updated_at = now()
    WHERE id = ${agentInstanceId}
  `;
  if (message) {
    await sql`
      INSERT INTO agent_events (agent_instance_id, event_type, to_state, message)
      VALUES (${agentInstanceId}, 'actual_state_change', ${state}, ${message})
    `;
  }
}

async function heartbeat() {
  await sql`
    UPDATE agent_instances SET last_health_at = now() WHERE id = ${agentInstanceId}
  `;
}

/**
 * Atomically claim one pending task assigned to this agent. Uses FOR
 * UPDATE SKIP LOCKED so multiple worker instances on the same agent
 * (shouldn't happen, but defense-in-depth) don't double-process the
 * same row.
 */
async function claimTask(): Promise<{ id: number; title: string; description: string | null; payload: any } | null> {
  return await sql.begin(async (tx) => {
    const rows = (await tx`
      SELECT id, title, description, payload
      FROM agent_tasks
      WHERE agent_instance_id = ${agentInstanceId}
        AND status = 'pending'
      ORDER BY priority DESC, id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `) as any[];
    if (rows.length === 0) return null;
    const task = rows[0]!;
    await tx`
      UPDATE agent_tasks
      SET status = 'in_progress', started_at = now(), updated_at = now()
      WHERE id = ${task.id}
    `;
    await tx`
      INSERT INTO agent_events (agent_instance_id, task_id, event_type, from_state, to_state, message)
      VALUES (${agentInstanceId}, ${task.id}, 'task_status_change', 'pending', 'in_progress', 'standalone-llm worker picked up task')
    `;
    return task;
  }) as any;
}

/**
 * Cap a string so its JSON-encoded form fits within `byteLimit` bytes.
 * Naive `slice(0, N)` counts characters; after JSON.stringify escapes
 * non-ASCII to `\uXXXX` (6 bytes each) the encoded result can be 2–6×
 * longer. Loop-truncates the input until the encoded payload fits.
 */
function capJsonOutput(s: string, byteLimit = 50_000): { output: string } {
  let raw = s;
  for (let i = 0; i < 5; i++) {
    const encoded = JSON.stringify({ output: raw });
    if (Buffer.byteLength(encoded, "utf8") <= byteLimit) return { output: raw };
    // Halve until it fits or we hit the iteration cap.
    raw = raw.slice(0, Math.floor(raw.length / 2));
  }
  return { output: raw };
}

async function completeTask(taskId: number, result: string) {
  await sql.begin(async (tx) => {
    // status='done' matches the agent_tasks CHECK constraint from migration v23
    // (allowed: pending|in_progress|blocked|review|done|cancelled|failed).
    // Earlier versions of this worker wrote 'completed' which the constraint
    // rejected — every task crashed after a successful LLM call.
    const payload = capJsonOutput(result, 50_000);
    await tx`
      UPDATE agent_tasks
      SET status = 'done', completed_at = now(), updated_at = now(),
          result = ${JSON.stringify(payload)}::jsonb
      WHERE id = ${taskId}
    `;
    await tx`
      INSERT INTO agent_events (agent_instance_id, task_id, event_type, from_state, to_state, message)
      VALUES (${agentInstanceId}, ${taskId}, 'task_status_change', 'in_progress', 'done', 'standalone-llm worker finished task')
    `;
  });
}

async function failTask(taskId: number, errorMsg: string) {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE agent_tasks
      SET status = 'failed', completed_at = now(), updated_at = now()
      WHERE id = ${taskId}
    `;
    await tx`
      INSERT INTO agent_events (agent_instance_id, task_id, event_type, from_state, to_state, message)
      VALUES (${agentInstanceId}, ${taskId}, 'task_status_change', 'in_progress', 'failed', ${errorMsg.slice(0, 1000)})
    `;
  });
}

async function processOneTask(task: { id: number; title: string; description: string | null; payload: any }) {
  // F-021: single resolveAgentContext call replaces two separate
  // queries — provider resolve + definition lookup — collapsed.
  const agentCtx = await resolveAgentContext(agentInstanceId);
  if (!agentCtx) {
    await failTask(task.id, "agent_definition lookup failed");
    return;
  }
  const { provider, defName, systemPrompt } = agentCtx;

  // Build a prompt that gives the model context about its role + the task.
  // Roles are inferred from the agent definition name (planner/reviewer/orchestrator).
  const role = defName.includes("planner")
    ? "an implementation planner"
    : defName.includes("reviewer")
      ? "a code reviewer"
      : defName.includes("orchestrator")
        ? "a task orchestrator"
        : "an autonomous agent";

  const system = systemPrompt ?? `You are ${role}. You receive a task description and produce a clear, actionable response. Be concise and structured.`;

  const userMessage = [
    `Task #${task.id}: ${task.title}`,
    task.description ? `\nDescription:\n${task.description}` : "",
    task.payload && Object.keys(task.payload).length > 0
      ? `\nPayload:\n${JSON.stringify(task.payload, null, 2)}`
      : "",
  ].filter(Boolean).join("\n");

  const messages: MessageParam[] = [{ role: "user", content: userMessage }];
  // F-007: agent_events writes go through the onFallbackEvent callback
  // owned by this worker — the LLM client no longer knows about
  // task_id / agent_instance_id directly.
  const ctx: StreamContext = {
    operation: `standalone-llm:${defName}`,
    provider,
    onFallbackEvent: async (eventType, metadata) => {
      try {
        await sql`
          INSERT INTO agent_events (agent_instance_id, task_id, event_type, message, metadata)
          VALUES (
            ${agentInstanceId},
            ${task.id},
            ${eventType},
            ${typeof metadata.message === "string" ? metadata.message : null},
            ${JSON.stringify(metadata)}::jsonb
          )
        `;
      } catch (err) {
        console.error("[standalone-llm-worker] onFallbackEvent insert failed:", String(err));
      }
    },
  };

  await setActualState("busy");
  try {
    const result = await generateResponse(messages, system, ctx);
    await completeTask(task.id, result);
    logger.info({ agentInstanceId, taskId: task.id, defName, len: result.length }, "standalone-llm task completed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ agentInstanceId, taskId: task.id, err: msg }, "standalone-llm task failed");
    await failTask(task.id, `LLM error: ${msg}`);
  } finally {
    await setActualState("idle");
  }
}

/**
 * Crash-recovery sweep on worker startup: any task assigned to this
 * agent_instance still in `in_progress` was claimed by a previous worker
 * incarnation that died (SIGKILL, OOM, crash) without writing the
 * terminal status update. Reset them to `pending` so the next claim
 * cycle picks them up.
 *
 * orchestrator.handleFailure could also pick these up via its
 * reassignment path, but that requires explicit invocation. The
 * self-healing sweep here covers the common case where the same agent
 * just restarts.
 */
async function recoverInflightTasks() {
  const rows = (await sql`
    UPDATE agent_tasks
    SET status = 'pending', started_at = NULL, updated_at = now()
    WHERE agent_instance_id = ${agentInstanceId}
      AND status = 'in_progress'
    RETURNING id
  `) as { id: number }[];
  if (rows.length === 0) return;
  console.log(`[standalone-llm-worker] recovered ${rows.length} stuck in_progress task(s) → pending`);
  for (const r of rows) {
    await sql`
      INSERT INTO agent_events (agent_instance_id, task_id, event_type, from_state, to_state, message)
      VALUES (${agentInstanceId}, ${r.id}, 'task_status_change', 'in_progress', 'pending',
              'startup recovery: previous worker did not finish this task')
    `.catch(() => {}); // best-effort audit; never block worker start
  }
}

async function main() {
  await recoverInflightTasks().catch((err) => {
    logger.warn({ err: String(err) }, "recoverInflightTasks failed; continuing");
  });
  await setActualState("running", "standalone-llm worker started");

  let lastHeartbeat = 0;
  while (running) {
    const now = Date.now();
    if (now - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
      await heartbeat().catch(() => {});
      lastHeartbeat = now;
    }

    let task: any = null;
    try {
      task = await claimTask();
    } catch (err) {
      logger.error({ err: String(err) }, "standalone-llm: claimTask failed");
      // Transient DB error — back off briefly, don't crash.
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    if (!task) {
      // No work — sleep + heartbeat continues.
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    try {
      await processOneTask(task);
    } catch (err) {
      // processOneTask catches its own errors; this is for unexpected ones.
      logger.error({ err: String(err), taskId: task.id }, "standalone-llm: unexpected error in processOneTask");
    }
  }

  await setActualState("stopping", "standalone-llm worker received shutdown signal");
  console.log("[standalone-llm-worker] exited cleanly");
  process.exit(0);
}

main().catch((err) => {
  console.error("[standalone-llm-worker] fatal:", err);
  setActualState("failed", `worker crashed: ${String(err)}`).catch(() => {});
  process.exit(1);
});
