/**
 * Orchestrator — manages agent_tasks lifecycle and assigns work to agent_instances.
 *
 * Phase 7 MVP scope:
 *   - CRUD over agent_tasks (create, get, list, update status)
 *   - Hierarchy: parent_task_id linking, getTaskTree
 *   - Agent selection by capability matching
 *   - Audit events on every state change
 *
 * Phase 7v2 (deferred):
 *   - LLM-driven task decomposition (calls llm/client to split a description into subtasks)
 *   - Auto-approval workflows for waiting_approval state
 *   - Cross-agent task reassignment on failure
 */
import { z } from "zod";
import { sql } from "../memory/db.ts";
import { logger } from "../logger.ts";
import { agentManager, type AgentInstance } from "./agent-manager.ts";
import { resolveProfile, resolveSessionProvider } from "../llm/profile-resolver.ts";
import { generateResponse } from "../llm/client.ts";
import type { MessageParam, ResolvedProvider } from "../llm/types.ts";

export type TaskStatus =
  | "pending" | "in_progress" | "blocked" | "review" | "done" | "cancelled" | "failed";

export interface AgentTask {
  id: number;
  agentInstanceId: number | null;
  parentTaskId: number | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  priority: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  agentInstanceId?: number | null;  // explicit assignment, otherwise selectAgent is called
  parentTaskId?: number;
  /**
   * Free-form payload persisted as JSONB. Reserved keys honored by the
   * runtime layer:
   *  - `model_tier: "flash" | "pro"` — overrides the agent's default
   *    model_profile per-task in the standalone-llm worker. Unknown
   *    values are ignored (advisory). See llm/tier-resolver.ts.
   *  - `required_capabilities: string[]` — fallback used by
   *    handleFailure when the failing agent's definition is missing.
   */
  payload?: Record<string, unknown>;
  priority?: number;
  /** When provided AND agentInstanceId is omitted, selectAgent uses these to filter. */
  requiredCapabilities?: string[];
}

export interface TaskNode extends AgentTask {
  children: TaskNode[];
}

export interface HandleFailureOptions {
  /** Max number of reassignments before giving up. Default: 2. */
  maxReassignments?: number;
  /** Excluded agent IDs (e.g., the one that failed). Auto-includes failed agent. */
  excludeAgentIds?: number[];
  /** Reason message for the audit trail. */
  reason?: string;
}

export interface HandleFailureResult {
  task: AgentTask;
  outcome: "reassigned" | "no_alternative" | "limit_reached";
  newAgentInstanceId: number | null;
  attempts: number;
}

function rowToTask(r: any): AgentTask {
  return {
    id: r.id,
    agentInstanceId: r.agent_instance_id,
    parentTaskId: r.parent_task_id,
    title: r.title,
    description: r.description,
    status: r.status as TaskStatus,
    payload: r.payload ?? {},
    result: r.result ?? null,
    priority: r.priority ?? 0,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    updatedAt: r.updated_at,
  };
}

// ---------- LLM-driven decomposition (Phase 9) ----------

export interface DecomposeOptions {
  /** Specific model_profile_id to use. Defaults to env-based fallback. */
  modelProfileId?: number;
  /** Profile name lookup (e.g., 'deepseek-default'). Used if modelProfileId not provided. */
  modelProfileName?: string;
  /** Max number of subtasks to request. Default: 7. */
  maxSubtasks?: number;
  /** Min number of subtasks. Default: 2. */
  minSubtasks?: number;
  /** Override system prompt. Default: see DEFAULT_SYSTEM_PROMPT. */
  systemPrompt?: string;
}

export interface DecomposeResult {
  parentTask: AgentTask;
  subtasks: AgentTask[];
  rawLlmResponse: string;
  attempts: number;
}

const SubtaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  capabilities: z.array(z.string()).default([]),
  priority: z.number().int().min(0).max(10).default(0),
});

const DecompositionSchema = z.object({
  subtasks: z.array(SubtaskSchema).min(1).max(20),
});

export class Orchestrator {
  private static readonly DEFAULT_SYSTEM_PROMPT = `You are a task decomposition assistant. Given a high-level task description, break it down into concrete actionable subtasks.

Output ONLY a JSON object in this exact format:
{
  "subtasks": [
    {
      "title": "<short imperative title, max 200 chars>",
      "description": "<optional details, max 2000 chars>",
      "capabilities": ["<capability1>", "<capability2>"],
      "priority": <integer 0-10, higher = more urgent>
    }
  ]
}

Rules:
- Produce {{MIN_SUBTASKS}} to {{MAX_SUBTASKS}} subtasks
- capabilities must be drawn from: code, review, plan, debug, test, design, document, orchestrate
- Each subtask should be independently actionable (a single agent can complete it)
- Output ONLY the JSON. No markdown fences, no preamble, no commentary.`;

  // ---------- Task CRUD ----------

  /**
   * Insert one task row + audit event inside the caller's transaction.
   * Used by `createTask` (own tx) and by callers that need to bundle several
   * task creations atomically (e.g. `decomposeTask`, `addSubtasks`).
   *
   * Note: agent selection (`selectAgent`) uses the raw `sql` handle and is
   * NOT part of this transaction. This is acceptable — selection is a
   * read-only filter; worst case a concurrent agent registration isn't
   * visible and we pick from the slightly older snapshot.
   */
  private async createTaskTx(tx: any, input: CreateTaskInput): Promise<AgentTask> {
    let agentInstanceId = input.agentInstanceId ?? null;

    if (agentInstanceId === null && input.requiredCapabilities && input.requiredCapabilities.length > 0) {
      const selected = await this.selectAgent(input.requiredCapabilities);
      if (selected) agentInstanceId = selected.id;
    }

    const [r] = await tx`
      INSERT INTO agent_tasks (agent_instance_id, parent_task_id, title, description, status, payload, priority)
      VALUES (
        ${agentInstanceId},
        ${input.parentTaskId ?? null},
        ${input.title},
        ${input.description ?? null},
        'pending',
        ${JSON.stringify(input.payload ?? {})}::jsonb,
        ${input.priority ?? 0}
      )
      RETURNING *
    ` as any[];

    if (agentInstanceId !== null) {
      await tx`
        INSERT INTO agent_events (agent_instance_id, task_id, event_type, message, metadata)
        VALUES (
          ${agentInstanceId},
          ${r.id},
          'task_assigned',
          ${`task #${r.id}: ${r.title}`},
          ${JSON.stringify({ priority: r.priority, parent_task_id: r.parent_task_id })}::jsonb
        )
      `;
    }
    return rowToTask(r);
  }

  async createTask(input: CreateTaskInput): Promise<AgentTask> {
    return (await sql.begin((tx) => this.createTaskTx(tx, input))) as AgentTask;
  }

  async getTask(id: number): Promise<AgentTask | null> {
    const [r] = await sql`SELECT * FROM agent_tasks WHERE id = ${id} LIMIT 1` as any[];
    return r ? rowToTask(r) : null;
  }

  /**
   * List tasks with an optional filter.
   *
   * Filters are AND-combined: passing `{status: 'pending', agentInstanceId: 5}`
   * returns tasks matching BOTH. Each filter field is independently optional —
   * pass `undefined` (or omit) to skip that dimension.
   *
   * `parentTaskId` has tri-state semantics:
   *   - `undefined` → no parent filter
   *   - `null` → only root tasks (parent_task_id IS NULL)
   *   - `number` → only direct children of that parent
   *
   * When all filters are unset, returns the most recent 100 tasks ordered
   * by id DESC. When any filter is set, returns the full filtered set
   * ordered by priority DESC, id ASC.
   */
  async listTasks(filter?: {
    status?: TaskStatus;
    agentInstanceId?: number;
    parentTaskId?: number | null;  // null = root tasks only, undefined = no filter
  }): Promise<AgentTask[]> {
    const noFilter = !filter || (
      filter.status === undefined &&
      filter.agentInstanceId === undefined &&
      filter.parentTaskId === undefined
    );

    if (noFilter) {
      const rows = await sql`SELECT * FROM agent_tasks ORDER BY id DESC LIMIT 100` as any[];
      return rows.map(rowToTask);
    }

    // AND-combine filter fragments. We use postgres.js's "match-if-set" idiom:
    // each clause is `(${param}::T IS NULL OR col = ${param})` — a NULL parameter
    // collapses the predicate to TRUE so the dimension is effectively skipped.
    const status = filter!.status ?? null;
    const agentInstanceId = filter!.agentInstanceId ?? null;
    // parentTaskId tri-state: undefined → no filter, null → IS NULL, number → equality.
    const parentFilterMode: "any" | "null" | "value" =
      filter!.parentTaskId === undefined ? "any" :
      filter!.parentTaskId === null ? "null" : "value";
    const parentTaskIdValue = parentFilterMode === "value" ? (filter!.parentTaskId as number) : null;

    const rows = await sql`
      SELECT * FROM agent_tasks
      WHERE
        (${status}::text IS NULL OR status = ${status})
        AND (${agentInstanceId}::int IS NULL OR agent_instance_id = ${agentInstanceId})
        AND (
          ${parentFilterMode}::text = 'any'
          OR (${parentFilterMode}::text = 'null' AND parent_task_id IS NULL)
          OR (${parentFilterMode}::text = 'value' AND parent_task_id = ${parentTaskIdValue})
        )
      ORDER BY priority DESC, id
    ` as any[];
    return rows.map(rowToTask);
  }

  async getTaskTree(rootId: number): Promise<TaskNode | null> {
    // Recursive fetch of all descendants. Bound by depth cap to prevent runaway recursion.
    const root = await this.getTask(rootId);
    if (!root) return null;

    const buildNode = async (task: AgentTask, depth: number): Promise<TaskNode> => {
      if (depth >= 10) return { ...task, children: [] }; // cap recursion
      const childRows = await sql`SELECT * FROM agent_tasks WHERE parent_task_id = ${task.id} ORDER BY priority DESC, id` as any[];
      const children = await Promise.all(childRows.map((r) => buildNode(rowToTask(r), depth + 1)));
      return { ...task, children };
    };
    return await buildNode(root, 0);
  }

  // ---------- State transitions ----------

  /**
   * Set task status. Records an event. Returns the updated task.
   * Side effects:
   *   - status='in_progress' → set started_at
   *   - status='done' | 'cancelled' | 'failed' → set completed_at
   */
  async setStatus(taskId: number, status: TaskStatus, message?: string): Promise<AgentTask> {
    return await sql.begin(async (tx) => {
      const [before] = await tx`SELECT * FROM agent_tasks WHERE id = ${taskId} FOR UPDATE` as any[];
      if (!before) throw new Error(`agent_task ${taskId} not found`);
      if (before.status === status) return rowToTask(before);

      // Compute timestamp side effects
      const startTs = status === "in_progress" && !before.started_at ? sql`now()` : sql`started_at`;
      const completeTs = (status === "done" || status === "cancelled" || status === "failed") ? sql`now()` : sql`completed_at`;

      const [after] = await tx`
        UPDATE agent_tasks
        SET status = ${status},
            started_at = ${startTs},
            completed_at = ${completeTs},
            updated_at = now()
        WHERE id = ${taskId}
        RETURNING *
      ` as any[];

      // Always emit audit event — agent_events.agent_instance_id is nullable per
      // migration v23, so unassigned tasks get NULL agent in their status history.
      await tx`
        INSERT INTO agent_events (agent_instance_id, task_id, event_type, from_state, to_state, message)
        VALUES (
          ${before.agent_instance_id ?? null},
          ${taskId},
          'task_status_change',
          ${before.status},
          ${status},
          ${message ?? null}
        )
      `;
      logger.info({ taskId, fromStatus: before.status, toStatus: status, message }, "task status changed");
      return rowToTask(after);
    }) as AgentTask;
  }

  /** Reassign a task to a different agent. Records event on both old and new agents. */
  async assignTask(taskId: number, agentInstanceId: number | null): Promise<AgentTask> {
    return await sql.begin(async (tx) => {
      const [before] = await tx`SELECT * FROM agent_tasks WHERE id = ${taskId} FOR UPDATE` as any[];
      if (!before) throw new Error(`agent_task ${taskId} not found`);
      if (before.agent_instance_id === agentInstanceId) return rowToTask(before);

      const [after] = await tx`
        UPDATE agent_tasks
        SET agent_instance_id = ${agentInstanceId}, updated_at = now()
        WHERE id = ${taskId}
        RETURNING *
      ` as any[];

      // Event on old agent (unassigned)
      if (before.agent_instance_id) {
        await tx`
          INSERT INTO agent_events (agent_instance_id, task_id, event_type, message)
          VALUES (${before.agent_instance_id}, ${taskId}, 'task_unassigned', ${`task #${taskId}: ${before.title}`})
        `;
      }
      // Event on new agent (assigned)
      if (agentInstanceId) {
        await tx`
          INSERT INTO agent_events (agent_instance_id, task_id, event_type, message)
          VALUES (${agentInstanceId}, ${taskId}, 'task_assigned', ${`task #${taskId}: ${before.title}`})
        `;
      }
      return rowToTask(after);
    }) as AgentTask;
  }

  /** Set task result (final output). Emits a `task_result_set` audit event. */
  async setResult(taskId: number, result: Record<string, unknown>): Promise<AgentTask> {
    return await sql.begin(async (tx) => {
      const [before] = await tx`SELECT agent_instance_id FROM agent_tasks WHERE id = ${taskId} FOR UPDATE` as any[];
      if (!before) throw new Error(`agent_task ${taskId} not found`);

      const [after] = await tx`
        UPDATE agent_tasks
        SET result = ${JSON.stringify(result)}::jsonb, updated_at = now()
        WHERE id = ${taskId}
        RETURNING *
      ` as any[];

      await tx`
        INSERT INTO agent_events (agent_instance_id, task_id, event_type, metadata)
        VALUES (
          ${before.agent_instance_id ?? null},
          ${taskId},
          'task_result_set',
          ${JSON.stringify({ result_keys: Object.keys(result) })}::jsonb
        )
      `;
      return rowToTask(after);
    }) as AgentTask;
  }

  // ---------- Subtask helpers ----------

  /**
   * Add multiple subtasks inside the caller's transaction. Calls
   * `createTaskTx` for each subtask so all inserts share one transaction.
   */
  private async addSubtasksTx(tx: any, parentTaskId: number, subtasks: CreateTaskInput[]): Promise<AgentTask[]> {
    const results: AgentTask[] = [];
    for (const sub of subtasks) {
      const created = await this.createTaskTx(tx, { ...sub, parentTaskId });
      results.push(created);
    }
    return results;
  }

  /** Add multiple subtasks under a parent. Useful after manual decomposition. */
  async addSubtasks(parentTaskId: number, subtasks: CreateTaskInput[]): Promise<AgentTask[]> {
    return (await sql.begin((tx) =>
      this.addSubtasksTx(tx, parentTaskId, subtasks),
    )) as AgentTask[];
  }

  // ---------- LLM-driven decomposition (Phase 9) ----------

  /**
   * Decompose a task by asking an LLM to split its description into concrete
   * subtasks, then create them via addSubtasks(). Up to 3 attempts to coerce
   * valid JSON from the model. Records a `task_decomposed` audit event on the
   * parent task with provider/model/attempts metadata.
   */
  async decomposeTask(taskId: number, options: DecomposeOptions = {}): Promise<DecomposeResult> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`agent_task ${taskId} not found`);

    const minSubtasks = options.minSubtasks ?? 2;
    const maxSubtasks = options.maxSubtasks ?? 7;

    // Resolve provider: explicit profileId > profileName lookup > env fallback
    let provider: ResolvedProvider;
    if (options.modelProfileId) {
      provider = await resolveProfile(options.modelProfileId);
    } else if (options.modelProfileName) {
      const rows = await sql`
        SELECT id FROM model_profiles WHERE name = ${options.modelProfileName} LIMIT 1
      ` as any[];
      const row = rows[0];
      if (!row) throw new Error(`model_profile "${options.modelProfileName}" not found`);
      provider = await resolveProfile(Number(row.id));
    } else {
      provider = await resolveSessionProvider(null);
    }

    const system = (options.systemPrompt ?? Orchestrator.DEFAULT_SYSTEM_PROMPT)
      .replaceAll("{{MIN_SUBTASKS}}", String(minSubtasks))
      .replaceAll("{{MAX_SUBTASKS}}", String(maxSubtasks));

    const userMessage =
      `Task title: ${task.title}\n` +
      (task.description ? `Task description: ${task.description}\n` : "") +
      `\nDecompose this task into ${minSubtasks}-${maxSubtasks} subtasks. Output JSON only.`;

    const messages: MessageParam[] = [{ role: "user", content: userMessage }];

    // Try up to 3 times: 1 initial + 2 retries on parse failure
    const MAX_ATTEMPTS = 3;
    let attempts = 0;
    let lastError: string | null = null;
    let rawResponse = "";
    let parsed: z.infer<typeof DecompositionSchema> | null = null;

    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      const retryHint = lastError
        ? `\n\nIMPORTANT: Your previous response had this error: ${lastError}. Fix it. Output JSON only.`
        : "";
      const finalUser = userMessage + retryHint;
      messages[0] = { role: "user", content: finalUser };

      rawResponse = await generateResponse(messages, system, {
        provider,
        operation: "decompose-task",
      } as any);

      // Strip optional markdown code fences
      let text = rawResponse.trim();
      if (text.startsWith("```json")) text = text.slice(7);
      else if (text.startsWith("```")) text = text.slice(3);
      if (text.endsWith("```")) text = text.slice(0, -3);
      text = text.trim();

      try {
        const json = JSON.parse(text);
        parsed = DecompositionSchema.parse(json);
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message.slice(0, 300) : String(err);
        logger.warn(
          { taskId, attempt: attempts, err: lastError },
          "decomposeTask: parse/validate failed, retrying",
        );
      }
    }

    if (!parsed) {
      throw new Error(
        `decomposeTask failed after ${MAX_ATTEMPTS} attempts: ${lastError}\n\nRaw LLM output:\n${rawResponse}`,
      );
    }

    // Create subtasks via existing addSubtasks (each call selects an agent by capability)
    const subtaskInputs: CreateTaskInput[] = parsed.subtasks.map((s) => ({
      title: s.title,
      description: s.description,
      payload: { source: "llm-decomposition", capabilities: s.capabilities },
      priority: s.priority,
      requiredCapabilities: s.capabilities.length > 0 ? s.capabilities : undefined,
    }));

    // Atomic: subtask inserts + parent audit event share one transaction.
    // Previously the audit event was a separate `sql` call after addSubtasks;
    // a crash between the two would leave subtasks orphaned (no record of
    // who decomposed them or via which model).
    const txResult = (await sql.begin(async (tx) => {
      // F-018 + H-1: refresh the FULL task row inside the tx — between
      // the initial getTask() at line ~410 and now, a concurrent
      // handleFailure could have reassigned the task. Using the stale
      // id in the audit event would mis-attribute the decomposition,
      // AND returning the stale `task` object as parentTask would mislead
      // downstream callers (the original H-1 review finding). Refresh
      // both the column used in the audit event AND the task object
      // returned from this function.
      const taskRows = (await tx`
        SELECT * FROM agent_tasks WHERE id = ${taskId} LIMIT 1
      `) as any[];
      const refreshedTask = taskRows[0] ? rowToTask(taskRows[0]) : task;
      const currentAgentInstanceId = refreshedTask.agentInstanceId ?? task.agentInstanceId ?? null;

      const subs = await this.addSubtasksTx(tx, taskId, subtaskInputs);
      await tx`
        INSERT INTO agent_events (agent_instance_id, task_id, event_type, message, metadata)
        VALUES (
          ${currentAgentInstanceId},
          ${taskId},
          'task_decomposed',
          ${`Decomposed into ${subs.length} subtasks via LLM (${provider.providerType}/${provider.model})`},
          ${JSON.stringify({
            provider_type: provider.providerType,
            model: provider.model,
            attempts,
            subtask_count: subs.length,
          })}::jsonb
        )
      `;
      return { subs, parentTask: refreshedTask };
    })) as { subs: AgentTask[]; parentTask: AgentTask };

    return {
      parentTask: txResult.parentTask,
      subtasks: txResult.subs,
      rawLlmResponse: rawResponse,
      attempts,
    };
  }

  // ---------- Agent selection ----------

  /**
   * Select an agent_instance whose definition.capabilities is a superset of `required`.
   * Prefers running agents over stopped, then highest-priority match.
   * Returns null if no agent matches.
   */
  async selectAgent(required: string[]): Promise<AgentInstance | null> {
    if (required.length === 0) return null;

    // Find agent_instances whose definition has ALL required capabilities.
    // Use jsonb @> (contains) operator with sql.json(...) — postgres.js v3
    // strips trailing `::jsonb` casts on parameter placeholders, so writing
    // `@> ${requiredJson}::jsonb` silently binds the parameter as TEXT and
    // never matches any row. sql.json() forces JSONB encoding at the wire
    // protocol level. This was discovered end-to-end during the v1.34.0
    // smoke test — capability routing had been silently broken since the
    // orchestrator MVP shipped.
    const rows = await sql`
      SELECT ai.*, ad.capabilities, ad.runtime_type, ai.actual_state
      FROM agent_instances ai
      JOIN agent_definitions ad ON ad.id = ai.definition_id
      WHERE ad.enabled = true
        AND ai.desired_state != 'stopped'
        AND ad.capabilities @> ${sql.json(required)}
      ORDER BY
        CASE ai.actual_state
          WHEN 'running' THEN 0
          WHEN 'idle' THEN 0
          WHEN 'busy' THEN 1
          WHEN 'starting' THEN 2
          ELSE 3
        END,
        ai.id
      LIMIT 1
    ` as any[];

    if (rows.length === 0) return null;

    // Build AgentInstance shape via agentManager.getInstance for canonical mapping
    return await agentManager.getInstance(Number(rows[0].id));
  }

  // ---------- Failure handling (Phase 10) ----------

  /**
   * Handle a task failure: reassign to an alternative agent with matching
   * capabilities, or mark as 'failed' permanently if no alternative exists.
   *
   * Reassignment limit prevents infinite ping-pong between failing agents.
   * Each reassignment is recorded as agent_events (task_unassigned + task_assigned),
   * plus an explicit `task_reassigned` event with previous/new agent metadata.
   */
  async handleFailure(taskId: number, options: HandleFailureOptions = {}): Promise<HandleFailureResult> {
    const maxReassignments = options.maxReassignments ?? 2;
    const reason = options.reason ?? "task failure — auto-reassign";
    const explicitExclusions = options.excludeAgentIds ?? [];

    // Single transaction with FOR UPDATE row lock so concurrent handleFailure
    // calls cannot both pass the reassignment-cap check and double-assign.
    // All DB ops use the `tx` handle — we cannot delegate to setStatus /
    // assignTask helpers here because those open their own sql.begin and
    // would deadlock or break atomicity.
    //
    // F-016 caveat: postgres.js runs at READ COMMITTED by default, and
    // FOR UPDATE only locks the agent_tasks row. The capability lookup
    // (step 5) and the candidate query (step 6) read from
    // agent_definitions / agent_instances which are NOT row-locked here.
    // A concurrent handleSetAgentProfile that re-points a definition
    // mid-transaction is invisible to this snapshot and could route the
    // task to an agent whose definition just changed. The race is narrow
    // (capability changes are rare, and the reassignment is still atomic
    // at the agent_tasks-row level) and fixing it would require
    // REPEATABLE READ or row-locking the joined tables — both costly.
    // Documented here so the next refactor doesn't quietly assume full
    // serializability.
    //
    // The transaction body returns a richer object than HandleFailureResult
    // — it carries `previousAgentId` (captured pre-UPDATE) so the post-tx
    // logger can report the real "before" agent. The public return strips
    // that field via the cast below.
    const txResult = await sql.begin(async (tx) => {
      // 1. Lock the task row for the duration of the transaction.
      const taskRows = (await tx`
        SELECT * FROM agent_tasks WHERE id = ${taskId} FOR UPDATE
      `) as any[];
      if (taskRows.length === 0) throw new Error(`agent_task ${taskId} not found`);
      const task = rowToTask(taskRows[0]);

      // 2. Count prior reassignments inside the transaction, after the lock.
      const eventRows = (await tx`
        SELECT COUNT(*)::int AS count
        FROM agent_events
        WHERE task_id = ${taskId} AND event_type = 'task_reassigned'
      `) as any[];
      const attempts = Number(eventRows[0]?.count ?? 0);

      // 3. Build excluded set (failed agent + caller exclusions).
      const excluded = new Set<number>(explicitExclusions);
      if (task.agentInstanceId) excluded.add(task.agentInstanceId);

      // Helper: terminal-failure path. UPDATE status='failed' + audit event +
      // refresh the row, all inside the current transaction. Used by all
      // non-reassigned outcomes (limit_reached, no_alternative). Closes M1
      // from the consolidated review — three identical inline blocks were
      // collapsed into one, so adding a new failure column / message field
      // requires a single edit instead of three.
      const inlineFail = async (
        outcome: "limit_reached" | "no_alternative",
        failureMessage: string,
      ) => {
        await tx`
          UPDATE agent_tasks
          SET status = 'failed', completed_at = now(), updated_at = now()
          WHERE id = ${taskId}
        `;
        await tx`
          INSERT INTO agent_events (agent_instance_id, task_id, event_type, from_state, to_state, message)
          VALUES (
            ${task.agentInstanceId ?? null},
            ${taskId},
            'task_status_change',
            ${task.status},
            'failed',
            ${failureMessage}
          )
        `;
        const updatedRows = (await tx`SELECT * FROM agent_tasks WHERE id = ${taskId}`) as any[];
        return {
          task: rowToTask(updatedRows[0]),
          outcome,
          newAgentInstanceId: null as number | null,
          attempts,
          previousAgentId: task.agentInstanceId,
        };
      };

      // 4. Reassignment-cap reached → terminal failure.
      if (attempts >= maxReassignments) {
        return inlineFail(
          "limit_reached",
          `${reason}: reassignment limit (${maxReassignments}) reached`,
        );
      }

      // 5. Resolve required capabilities — first from the failed agent's
      //    definition, then fall back to whatever was stashed in the payload
      //    by createTask/decomposeTask.
      let requiredCapabilities: string[] = [];
      if (task.agentInstanceId) {
        const defRows = (await tx`
          SELECT ad.capabilities
          FROM agent_instances ai
          JOIN agent_definitions ad ON ad.id = ai.definition_id
          WHERE ai.id = ${task.agentInstanceId}
          LIMIT 1
        `) as any[];
        const defRow = defRows[0];
        if (defRow?.capabilities && Array.isArray(defRow.capabilities)) {
          requiredCapabilities = defRow.capabilities as string[];
        }
      }
      if (requiredCapabilities.length === 0) {
        const payloadCaps =
          (task.payload?.required_capabilities ?? task.payload?.capabilities) as unknown;
        if (Array.isArray(payloadCaps)) requiredCapabilities = payloadCaps as string[];
      }

      if (requiredCapabilities.length === 0) {
        return inlineFail(
          "no_alternative",
          `${reason}: cannot determine required capabilities`,
        );
      }

      // M2: guard against non-string entries that may have slipped in via
      // task.payload (the source is untrusted). JSON.stringify will encode
      // anything, but the @>-containment check on jsonb only matches by
      // exact value+type — an integer or object in `required` silently
      // never matches and we'd burn a reassignment slot finding "no winner".
      // Reject up-front instead.
      if (!requiredCapabilities.every((c) => typeof c === "string")) {
        return inlineFail(
          "no_alternative",
          `${reason}: required_capabilities contains non-string entries`,
        );
      }

      // 6. Find candidate agents (filter excluded IDs in JS for SQL
      // robustness). sql.json(...) — see selectAgent for the rationale;
      // `${json}::jsonb` silently fails because postgres.js strips the cast.
      const candidates = (await tx`
        SELECT ai.id
        FROM agent_instances ai
        JOIN agent_definitions ad ON ad.id = ai.definition_id
        WHERE ad.enabled = true
          AND ai.desired_state != 'stopped'
          AND ad.capabilities @> ${tx.json(requiredCapabilities)}
        ORDER BY
          CASE ai.actual_state
            WHEN 'running' THEN 0
            WHEN 'idle' THEN 0
            WHEN 'busy' THEN 1
            WHEN 'starting' THEN 2
            ELSE 3
          END,
          ai.id
      `) as any[];
      const winner = candidates.find((c) => !excluded.has(Number(c.id)));

      if (!winner) {
        return inlineFail(
          "no_alternative",
          `${reason}: no alternative agent with capabilities ${requiredCapabilities.join(", ")}`,
        );
      }

      const newAgentId = Number(winner.id);

      // 7. Reassign + reset to pending atomically.
      await tx`
        UPDATE agent_tasks
        SET agent_instance_id = ${newAgentId},
            status = 'pending',
            started_at = NULL,
            completed_at = NULL,
            updated_at = now()
        WHERE id = ${taskId}
      `;
      // Audit trail: unassign-from-old (if any) + assign-to-new, mirroring
      // assignTask's event shape so existing consumers keep working.
      if (task.agentInstanceId) {
        await tx`
          INSERT INTO agent_events (agent_instance_id, task_id, event_type, message)
          VALUES (
            ${task.agentInstanceId},
            ${taskId},
            'task_unassigned',
            ${`task #${taskId}: ${task.title}`}
          )
        `;
      }
      await tx`
        INSERT INTO agent_events (agent_instance_id, task_id, event_type, message)
        VALUES (
          ${newAgentId},
          ${taskId},
          'task_assigned',
          ${`task #${taskId}: ${task.title}`}
        )
      `;
      // Reassignment-specific event — this is what `attempts` counts.
      await tx`
        INSERT INTO agent_events (agent_instance_id, task_id, event_type, message, metadata)
        VALUES (
          ${newAgentId},
          ${taskId},
          'task_reassigned',
          ${reason},
          ${JSON.stringify({
            previous_agent_id: task.agentInstanceId,
            attempts: attempts + 1,
            required_capabilities: requiredCapabilities,
          })}::jsonb
        )
      `;

      const updatedRows = (await tx`SELECT * FROM agent_tasks WHERE id = ${taskId}`) as any[];
      return {
        task: rowToTask(updatedRows[0]),
        outcome: "reassigned" as const,
        newAgentInstanceId: newAgentId as number | null,
        attempts: attempts + 1,
        previousAgentId: task.agentInstanceId,
      };
    });

    if (txResult.outcome === "reassigned") {
      logger.info(
        {
          taskId,
          previousAgentId: txResult.previousAgentId,
          newAgentId: txResult.newAgentInstanceId,
          attempts: txResult.attempts,
          reason,
        },
        "task reassigned after failure",
      );
    }

    // Strip the internal `previousAgentId` field — it is logging-only metadata
    // and is not part of the public HandleFailureResult contract.
    const { previousAgentId: _previousAgentId, ...result } = txResult;
    return result as HandleFailureResult;
  }
}

export const orchestrator = new Orchestrator();
