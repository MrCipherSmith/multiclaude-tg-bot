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
  payload?: Record<string, unknown>;
  priority?: number;
  /** When provided AND agentInstanceId is omitted, selectAgent uses these to filter. */
  requiredCapabilities?: string[];
}

export interface TaskNode extends AgentTask {
  children: TaskNode[];
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

  async createTask(input: CreateTaskInput): Promise<AgentTask> {
    let agentInstanceId = input.agentInstanceId ?? null;

    // If no explicit assignment, try to find an agent matching required capabilities
    if (agentInstanceId === null && input.requiredCapabilities && input.requiredCapabilities.length > 0) {
      const selected = await this.selectAgent(input.requiredCapabilities);
      if (selected) agentInstanceId = selected.id;
    }

    return await sql.begin(async (tx) => {
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

      // Audit event on the assigned agent (if any)
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
    }) as AgentTask;
  }

  async getTask(id: number): Promise<AgentTask | null> {
    const [r] = await sql`SELECT * FROM agent_tasks WHERE id = ${id} LIMIT 1` as any[];
    return r ? rowToTask(r) : null;
  }

  /**
   * List tasks with an optional filter.
   *
   * NOTE: filter is single-dimension first-wins. Priority order:
   *   status > agentInstanceId > parentTaskId.
   * Pass exactly one field per call. Combining multiple filters in one call
   * silently keeps only the highest-priority field — pass `undefined` for
   * fields you do not want to filter on.
   */
  async listTasks(filter?: {
    status?: TaskStatus;
    agentInstanceId?: number;
    parentTaskId?: number | null;  // null = root tasks only
  }): Promise<AgentTask[]> {
    let rows: any[];
    if (filter?.status) {
      rows = await sql`SELECT * FROM agent_tasks WHERE status = ${filter.status} ORDER BY priority DESC, id` as any[];
    } else if (filter?.agentInstanceId !== undefined) {
      rows = await sql`SELECT * FROM agent_tasks WHERE agent_instance_id = ${filter.agentInstanceId} ORDER BY priority DESC, id` as any[];
    } else if (filter?.parentTaskId === null) {
      rows = await sql`SELECT * FROM agent_tasks WHERE parent_task_id IS NULL ORDER BY priority DESC, id` as any[];
    } else if (filter?.parentTaskId !== undefined) {
      rows = await sql`SELECT * FROM agent_tasks WHERE parent_task_id = ${filter.parentTaskId} ORDER BY priority DESC, id` as any[];
    } else {
      rows = await sql`SELECT * FROM agent_tasks ORDER BY id DESC LIMIT 100` as any[];
    }
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

  /** Add multiple subtasks under a parent. Useful after manual decomposition. */
  async addSubtasks(parentTaskId: number, subtasks: CreateTaskInput[]): Promise<AgentTask[]> {
    const results: AgentTask[] = [];
    for (const sub of subtasks) {
      const created = await this.createTask({ ...sub, parentTaskId });
      results.push(created);
    }
    return results;
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
      .replace("{{MIN_SUBTASKS}}", String(minSubtasks))
      .replace("{{MAX_SUBTASKS}}", String(maxSubtasks));

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

      rawResponse = await generateResponse(messages, system, { provider } as any);

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

    const created = await this.addSubtasks(taskId, subtaskInputs);

    // Audit event on the parent task
    await sql`
      INSERT INTO agent_events (agent_instance_id, task_id, event_type, message, metadata)
      VALUES (
        ${task.agentInstanceId ?? null},
        ${taskId},
        'task_decomposed',
        ${`Decomposed into ${created.length} subtasks via LLM (${provider.providerType}/${provider.model})`},
        ${JSON.stringify({
          provider_type: provider.providerType,
          model: provider.model,
          attempts,
          subtask_count: created.length,
        })}::jsonb
      )
    `;

    return {
      parentTask: task,
      subtasks: created,
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
    // Use jsonb @> (contains) operator: capabilities @> '["a","b"]'
    const requiredJson = JSON.stringify(required);
    const rows = await sql`
      SELECT ai.*, ad.capabilities, ad.runtime_type, ai.actual_state
      FROM agent_instances ai
      JOIN agent_definitions ad ON ad.id = ai.definition_id
      WHERE ad.enabled = true
        AND ai.desired_state != 'stopped'
        AND ad.capabilities @> ${requiredJson}::jsonb
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
}

export const orchestrator = new Orchestrator();
