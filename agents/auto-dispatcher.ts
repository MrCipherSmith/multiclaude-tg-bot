/**
 * Pattern B (v1.40.0) — auto-dispatch from orchestrator agent output.
 *
 * When a standalone-llm worker completes a task AND the agent's
 * definition carries the `orchestrate` capability AND the result
 * parses as a valid `Decomposition`, this module creates the
 * subtasks via `orchestrator.createTask` automatically. Each subtask
 * routes to a candidate agent through `selectAgent(capabilities)` —
 * no operator action required.
 *
 * Pattern A (advisory) is the fallback: if the result doesn't parse
 * (e.g. the agent ignored the schema, the LLM rambled), this module
 * silently does nothing. The result is still in agent_tasks.result
 * for the operator to read and dispatch manually via `/task <id>
 * decompose` or `/task <id> sub`.
 *
 * Failures are LOGGED, never raised — auto-dispatch is a convenience,
 * not a correctness gate. The parent task already completed
 * successfully when this module runs.
 */

import { sql } from "../memory/db.ts";
import { logger } from "../logger.ts";
import { orchestrator, DecompositionSchema, type AgentTask } from "./orchestrator.ts";

const ORCHESTRATE_CAPABILITY = "orchestrate";

/**
 * Maximum depth of the parent_task_id chain that auto-dispatch will
 * traverse. Beyond this, dispatch is refused — protects against
 * runaway recursion if the exclusion guard somehow misses (e.g. a
 * second orchestrator with overlapping capabilities exists, and the
 * specialist for the consolidate step happens to be orchestrator-
 * capable).
 *
 * 4 covers any realistic pipeline:
 *   user → orchestrator → analyzer → reviewer → consolidator
 */
const MAX_DISPATCH_DEPTH = 4;

export interface AutoDispatchResult {
  /** True iff at least one subtask was created. */
  dispatched: boolean;
  /** Subtask ids actually created (empty when not dispatched). */
  subtaskIds: number[];
  /** Reason for skipping when dispatched=false; null on success. */
  skipReason:
    | "no_orchestrate_capability"
    | "unparseable_output"
    | "schema_invalid"
    | "create_failed"
    | "depth_limit_reached"
    | null;
}

/**
 * Decide whether the agent's definition opts into auto-dispatch by
 * carrying the `orchestrate` capability tag. Generic LLM agents
 * (planner, reviewer) MUST not dispatch — only orchestrator roles do,
 * because:
 *   1. Orchestrator prompts are explicitly designed to emit the
 *      DecompositionSchema JSON.
 *   2. A generic agent might output JSON-like text that happens to
 *      match the shape but isn't an intentional plan.
 */
/**
 * Walk the `parent_task_id` chain upward from a task, collecting:
 *  - `ancestorAgentIds` — the set of agent_instance_ids that produced
 *    each ancestor task (used as `excludeAgentIds` to break recursion)
 *  - `depth` — how many ancestors we walked (caller compares to
 *    `MAX_DISPATCH_DEPTH`)
 *
 * Includes the task itself in the count and the agent set: a subtask
 * created from this task must NOT route back to the task's own agent.
 * Walks at most MAX_DISPATCH_DEPTH + 1 hops to bound DB load.
 */
async function collectAncestorContext(
  taskId: number,
): Promise<{ ancestorAgentIds: number[]; depth: number }> {
  const agentIds = new Set<number>();
  let currentId: number | null = taskId;
  let depth = 0;
  // +1 to read self + ancestors up to the cap (depth uses the count of
  // ancestors NOT including self, so reading depth=4 ancestors is OK
  // and the dispatch is refused only when depth >= MAX_DISPATCH_DEPTH).
  while (currentId !== null && depth <= MAX_DISPATCH_DEPTH + 1) {
    const rows = (await sql`
      SELECT agent_instance_id, parent_task_id
      FROM agent_tasks
      WHERE id = ${currentId}
      LIMIT 1
    `) as { agent_instance_id: number | null; parent_task_id: number | null }[];
    if (rows.length === 0) break;
    const row = rows[0]!;
    if (row.agent_instance_id != null) agentIds.add(Number(row.agent_instance_id));
    if (row.parent_task_id == null) break;
    currentId = Number(row.parent_task_id);
    depth++;
  }
  return { ancestorAgentIds: Array.from(agentIds), depth };
}

async function definitionHasOrchestrateCapability(agentInstanceId: number): Promise<boolean> {
  const rows = (await sql`
    SELECT ad.capabilities
    FROM agent_instances ai
    JOIN agent_definitions ad ON ad.id = ai.definition_id
    WHERE ai.id = ${agentInstanceId}
    LIMIT 1
  `) as { capabilities: string[] }[];
  if (rows.length === 0) return false;
  const caps = rows[0]!.capabilities;
  if (!Array.isArray(caps)) return false;
  return caps.includes(ORCHESTRATE_CAPABILITY);
}

/**
 * Strip a markdown JSON fence (```json … ```) if present, then trim.
 * Mirrors the same logic decomposeTask uses, kept inline so we don't
 * cross-import private helpers.
 */
function stripFences(raw: string): string {
  let t = raw.trim();
  if (t.startsWith("```json")) t = t.slice(7);
  else if (t.startsWith("```")) t = t.slice(3);
  if (t.endsWith("```")) t = t.slice(0, -3);
  return t.trim();
}

/**
 * Parse a string output as a Decomposition. Returns null on parse
 * error or schema mismatch — the caller distinguishes the cases via
 * AutoDispatchResult.skipReason if needed for the audit event.
 */
export function tryParseDecomposition(raw: string): { ok: true; value: import("./orchestrator.ts").Decomposition } | { ok: false; reason: "unparseable_output" | "schema_invalid" } {
  const stripped = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { ok: false, reason: "unparseable_output" };
  }
  const result = DecompositionSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: "schema_invalid" };
  }
  return { ok: true, value: result.data };
}

/**
 * Auto-dispatch entry point. Called by the standalone-llm worker
 * after a successful `completeTask`.
 *
 *  - parentTask: the task that just finished. Subtasks will reference
 *    its id via `parent_task_id`.
 *  - resultText: raw text the worker wrote to agent_tasks.result.output.
 *
 * Behavior:
 *  - Skip silently when the agent isn't orchestrate-capable.
 *  - Skip silently when the output doesn't parse / fails validation.
 *  - On success, createTask is called per subtask. Each subtask gets:
 *      parent_task_id = parentTask.id
 *      payload.source = "auto-dispatch"
 *      payload.required_capabilities = subtask.capabilities (so the
 *        handleFailure path has them too)
 *      requiredCapabilities = subtask.capabilities (drives selectAgent)
 *  - One `orchestration_dispatched` agent_event recorded on parent
 *    with metadata: { subtask_ids, count }.
 */
export async function maybeDispatchOrchestration(
  parentTask: AgentTask,
  resultText: string,
): Promise<AutoDispatchResult> {
  if (parentTask.agentInstanceId == null) {
    return { dispatched: false, subtaskIds: [], skipReason: "no_orchestrate_capability" };
  }
  const orchestrateCapable = await definitionHasOrchestrateCapability(parentTask.agentInstanceId);
  if (!orchestrateCapable) {
    return { dispatched: false, subtaskIds: [], skipReason: "no_orchestrate_capability" };
  }

  // v1.42.2 recursion guard: walk the parent_task_id chain to collect
  // ancestor agent_instance_ids. Pass them as `excludeAgentIds` to
  // selectAgent so a subtask whose capabilities match its own ancestor's
  // orchestrator never routes back to it. Cap depth at MAX_DISPATCH_DEPTH
  // so a runaway chain is broken even if the exclusion misses.
  const { ancestorAgentIds, depth } = await collectAncestorContext(parentTask.id);
  if (depth >= MAX_DISPATCH_DEPTH) {
    logger.warn(
      { taskId: parentTask.id, depth },
      "auto-dispatcher: depth limit reached, refusing further dispatch",
    );
    return { dispatched: false, subtaskIds: [], skipReason: "depth_limit_reached" };
  }

  const parsed = tryParseDecomposition(resultText);
  if (!parsed.ok) {
    // Pattern A fallback — orchestrator may have intentionally produced
    // human-readable output, or the LLM ignored the schema. Either way
    // we don't fail the task, just skip auto-dispatch silently.
    logger.info(
      { taskId: parentTask.id, reason: parsed.reason },
      "auto-dispatcher: result not parseable as decomposition, skipping",
    );
    return { dispatched: false, subtaskIds: [], skipReason: parsed.reason };
  }

  const subtaskIds: number[] = [];
  for (const sub of parsed.value.subtasks) {
    try {
      const created = await orchestrator.createTask({
        title: sub.title,
        description: sub.description,
        parentTaskId: parentTask.id,
        priority: sub.priority,
        // Stash capabilities in payload so handleFailure can fall back
        // to them if the assigned agent's definition is later disabled
        // / changed (defense-in-depth — selectAgent looked up the
        // current definition; payload preserves the operator intent).
        payload: {
          source: "auto-dispatch",
          parent_orchestrator_task_id: parentTask.id,
          required_capabilities: sub.capabilities,
          dispatch_depth: depth + 1,
        },
        requiredCapabilities: sub.capabilities.length > 0 ? sub.capabilities : undefined,
        // Recursion guard: never route back to any ancestor agent.
        excludeAgentIds: ancestorAgentIds,
      });
      subtaskIds.push(created.id);
    } catch (err) {
      // One failed createTask should not abort the rest — partial
      // dispatch is more useful than zero dispatch. Log and continue.
      logger.warn(
        { parentTaskId: parentTask.id, subtask: sub, err: String(err) },
        "auto-dispatcher: createTask failed for one subtask; continuing with remaining",
      );
    }
  }

  if (subtaskIds.length === 0) {
    return { dispatched: false, subtaskIds: [], skipReason: "create_failed" };
  }

  // Audit event on the parent so /task <id> shows the dispatch trail.
  // Best-effort — DB hiccup here doesn't change the outcome.
  await sql`
    INSERT INTO agent_events (agent_instance_id, task_id, event_type, message, metadata)
    VALUES (
      ${parentTask.agentInstanceId},
      ${parentTask.id},
      'orchestration_dispatched',
      ${`auto-dispatched ${subtaskIds.length} subtasks via Pattern B`},
      ${sql.json({
        subtask_ids: subtaskIds,
        subtask_count: subtaskIds.length,
        requested_count: parsed.value.subtasks.length,
      })}
    )
  `.catch((err) => {
    logger.warn({ parentTaskId: parentTask.id, err: String(err) }, "auto-dispatcher: audit event insert failed");
  });

  logger.info(
    { parentTaskId: parentTask.id, subtaskIds, count: subtaskIds.length },
    "auto-dispatcher: orchestration plan dispatched",
  );

  return { dispatched: true, subtaskIds, skipReason: null };
}
