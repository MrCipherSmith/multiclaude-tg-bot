/**
 * MCP-driven task pull/complete operations (v1.44.0 Pattern C).
 *
 * Lets a claude-code session participate in the orchestrator pipeline
 * by pulling tasks assigned to its agent_instance via MCP tools instead
 * of polling. The standalone-llm worker has its own poll loop; claude-
 * code is interactive, so we expose pull semantics over MCP.
 *
 * Tools wired in `channel/tools.ts`:
 *  - take_next_task → claimNextPendingTask
 *  - complete_task  → completeTask
 *  - fail_task      → failTask
 *
 * Extracted into a separate module so the SQL logic is unit-testable
 * without standing up the full MCP transport (Server, stdio pipe, etc).
 */

import { sql as defaultSql } from "../memory/db.ts";
import { agentManager } from "./agent-manager.ts";
import { routeTaskResultToTopic } from "./result-router.ts";

export interface ClaimedTask {
  id: number;
  title: string;
  description: string | null;
  payload: Record<string, unknown>;
  parentTaskId: number | null;
  priority: number;
}

export interface CompleteResult {
  ok: true;
  taskId: number;
  postedToTopic: boolean;
}

export interface TaskResultView {
  id: number;
  title: string;
  description: string | null;
  status: string;
  agent_instance_id: number | null;
  parent_task_id: number | null;
  agent_name: string | null;
  definition_name: string | null;
  result: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  created_at: string;
  completed_at: string | null;
}

/**
 * Read a task by id with joined agent/definition metadata. Used by
 * claude-code agents (via MCP `get_task_result`) to follow up on
 * earlier work — e.g. "implement fixes from review #443" needs the
 * implementer to read 443's findings before applying them.
 *
 * Returns the row and the joined names. Returns null when the task
 * is missing. Does NOT walk the parent chain (separate concern —
 * caller can pull `parent_task_id` and call again).
 *
 * No auth check: helyx is single-tenant and any agent in the system
 * can already see any agent_event for any task. Limiting result
 * reads would be inconsistent.
 */
export async function getTaskResult(
  taskId: number,
  sql: any = defaultSql,
): Promise<TaskResultView | null> {
  if (!Number.isFinite(taskId)) throw new Error("task_id required (number)");
  const rows = (await sql`
    SELECT t.id, t.title, t.description, t.status, t.agent_instance_id,
           t.parent_task_id, t.result, t.payload, t.created_at, t.completed_at,
           ai.name AS agent_name,
           ad.name AS definition_name
    FROM agent_tasks t
    LEFT JOIN agent_instances ai ON ai.id = t.agent_instance_id
    LEFT JOIN agent_definitions ad ON ad.id = ai.definition_id
    WHERE t.id = ${taskId}
    LIMIT 1
  `) as any[];
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    id: Number(r.id),
    title: r.title,
    description: r.description,
    status: r.status,
    agent_instance_id: r.agent_instance_id != null ? Number(r.agent_instance_id) : null,
    parent_task_id: r.parent_task_id != null ? Number(r.parent_task_id) : null,
    agent_name: r.agent_name ?? null,
    definition_name: r.definition_name ?? null,
    result: r.result ?? null,
    payload: r.payload ?? {},
    created_at: (r.created_at as Date).toISOString(),
    completed_at: r.completed_at ? (r.completed_at as Date).toISOString() : null,
  };
}

/**
 * Atomically claim the next pending task for an agent_instance.
 * Returns null when no pending task exists.
 *
 * Locking: `FOR UPDATE SKIP LOCKED` mirrors `standalone-llm-worker.ts:claimTask`,
 * so concurrent callers (multiple claude sessions for the same instance,
 * defensive) cannot double-claim.
 *
 * Side effects on success:
 *  - status: pending → in_progress
 *  - started_at = now()
 *  - agent_events row: type=task_status_change, message=via MCP take_next_task
 */
export async function claimNextPendingTask(
  agentInstanceId: number,
  sql: any = defaultSql,
): Promise<ClaimedTask | null> {
  return await sql.begin(async (tx: any) => {
    const rows = await tx`
      SELECT id, title, description, payload, parent_task_id, priority
      FROM agent_tasks
      WHERE agent_instance_id = ${agentInstanceId}
        AND status = 'pending'
      ORDER BY priority ASC, id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    ` as any[];
    if (rows.length === 0) return null;
    const t = rows[0]!;
    await tx`
      UPDATE agent_tasks
      SET status = 'in_progress', started_at = now(), updated_at = now()
      WHERE id = ${t.id}
    `;
    await tx`
      INSERT INTO agent_events (agent_instance_id, task_id, event_type, from_state, to_state, message)
      VALUES (${agentInstanceId}, ${t.id}, 'task_status_change', 'pending', 'in_progress', 'claimed via MCP take_next_task')
    `;
    return {
      id: Number(t.id),
      title: t.title,
      description: t.description,
      payload: t.payload ?? {},
      parentTaskId: t.parent_task_id != null ? Number(t.parent_task_id) : null,
      priority: Number(t.priority),
    };
  });
}

const RESULT_CAP = 50_000;

/**
 * Mark a task as 'done' with the produced result.
 *
 * Refuses tasks whose status is not 'in_progress' — that gate prevents
 * an agent from "completing" a task it never claimed via take_next_task,
 * AND prevents double-completion races. Throws on:
 *  - task not found
 *  - status mismatch (pending / done / failed / cancelled)
 *
 * After persisting, calls `routeTaskResultToTopic` which uses the
 * v1.43.0 chain-walk to find a forum topic and posts the result there
 * if found. Routing failures are logged inside the router and never
 * thrown — task stays 'done' regardless.
 *
 * Result text is capped at 50KB to bound JSONB column growth.
 */
export async function completeTask(
  taskId: number,
  result: string,
  sql: any = defaultSql,
): Promise<CompleteResult> {
  if (!Number.isFinite(taskId)) throw new Error("task_id required (number)");
  if (typeof result !== "string" || result.length === 0) {
    throw new Error("result required (non-empty string)");
  }
  const capped = result.length > RESULT_CAP
    ? result.slice(0, RESULT_CAP - 100) + "\n…(truncated)"
    : result;

  const updated = await sql.begin(async (tx: any) => {
    const rows = await tx`
      SELECT id, title, agent_instance_id, status FROM agent_tasks
      WHERE id = ${taskId} FOR UPDATE
    ` as any[];
    if (rows.length === 0) throw new Error(`task ${taskId} not found`);
    const t = rows[0]!;
    if (t.status !== "in_progress") {
      throw new Error(`task ${taskId} status='${t.status}', expected 'in_progress' (call take_next_task first)`);
    }
    await tx`
      UPDATE agent_tasks
      SET status = 'done', completed_at = now(), updated_at = now(),
          result = ${tx.json({ output: capped })}
      WHERE id = ${taskId}
    `;
    await tx`
      INSERT INTO agent_events (agent_instance_id, task_id, event_type, from_state, to_state, message)
      VALUES (${t.agent_instance_id}, ${taskId}, 'task_status_change', 'in_progress', 'done', 'completed via MCP complete_task')
    `;
    return { taskId, agentInstanceId: t.agent_instance_id, title: t.title };
  });

  // Best-effort topic routing — failures logged in router, never raised.
  let postedToTopic = false;
  if (updated.agentInstanceId != null) {
    const inst = await agentManager.getInstance(Number(updated.agentInstanceId));
    postedToTopic = await routeTaskResultToTopic({
      agentInstanceId: Number(updated.agentInstanceId),
      agentName: inst?.name ?? `agent#${updated.agentInstanceId}`,
      taskId: updated.taskId,
      taskTitle: updated.title,
      resultText: capped,
    });
  }

  return { ok: true, taskId: updated.taskId, postedToTopic };
}

/**
 * Mark a task as 'failed' with a reason. Idempotent on already-terminal
 * states (done/failed/cancelled) — they're left as-is and we add an
 * audit event but don't change status.
 *
 * Use for unrecoverable errors (target file missing, lint setup absent).
 * Recoverable errors should re-raise — orchestrator.handleFailure can
 * pick those up and reassign.
 */
export async function failTask(
  taskId: number,
  reason: string,
  sql: any = defaultSql,
): Promise<{ ok: true; taskId: number; status: string }> {
  if (!Number.isFinite(taskId)) throw new Error("task_id required (number)");
  const trimmedReason = String(reason ?? "").slice(0, 1000);
  if (trimmedReason.length === 0) throw new Error("reason required");

  return await sql.begin(async (tx: any) => {
    const rows = await tx`
      SELECT agent_instance_id, status FROM agent_tasks WHERE id = ${taskId} FOR UPDATE
    ` as any[];
    if (rows.length === 0) throw new Error(`task ${taskId} not found`);
    const t = rows[0]!;
    // Already terminal — record an audit event but don't flip status.
    if (t.status === "done" || t.status === "failed" || t.status === "cancelled") {
      await tx`
        INSERT INTO agent_events (agent_instance_id, task_id, event_type, message)
        VALUES (${t.agent_instance_id}, ${taskId}, 'fail_task_noop', ${`fail_task ignored — task already in terminal status='${t.status}': ${trimmedReason}`})
      `;
      return { ok: true as const, taskId, status: t.status };
    }
    await tx`
      UPDATE agent_tasks
      SET status = 'failed', completed_at = now(), updated_at = now()
      WHERE id = ${taskId}
    `;
    await tx`
      INSERT INTO agent_events (agent_instance_id, task_id, event_type, from_state, to_state, message)
      VALUES (${t.agent_instance_id}, ${taskId}, 'task_status_change', ${t.status}, 'failed', ${trimmedReason})
    `;
    return { ok: true as const, taskId, status: "failed" };
  });
}
