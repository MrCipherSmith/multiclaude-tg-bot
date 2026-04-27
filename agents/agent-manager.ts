/**
 * AgentManager — CRUD and desired-state mutation for agent_instances.
 *
 * Responsibilities:
 *   - Create / read / list agent_instances and agent_definitions
 *   - Mutate desired_state (the user-facing knob)
 *   - Record state transitions in agent_events
 *
 * NOT responsible for:
 *   - Reconciling actual_state to desired_state — that's RuntimeManager.startReconcileLoop
 *   - Calling driver.start / stop — that's the reconciler's job
 */
import { sql } from "../memory/db.ts";
import { logger } from "../logger.ts";

export type DesiredState = "running" | "stopped" | "paused";
export type ActualState =
  | "new" | "starting" | "running" | "idle" | "busy"
  | "waiting_approval" | "stuck" | "stopping" | "stopped" | "failed";

export interface AgentDefinition {
  id: number;
  name: string;
  description: string | null;
  runtimeType: string;
  runtimeDriver: string;
  modelProfileId: number | null;
  systemPrompt: string | null;
  capabilities: string[];
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface AgentInstance {
  id: number;
  definitionId: number;
  projectId: number | null;
  name: string;
  desiredState: DesiredState;
  actualState: ActualState;
  runtimeHandle: Record<string, unknown>;
  lastSnapshot: string | null;
  lastSnapshotAt: Date | null;
  lastHealthAt: Date | null;
  restartCount: number;
  lastRestartAt: Date | null;
  sessionId: number | null;
  /**
   * Optional per-instance override of the definition's `system_prompt`.
   * When non-null, the standalone-llm worker uses this verbatim instead
   * of falling back to `agent_definitions.system_prompt`. Lets operators
   * specialize a shared role (e.g. one planner tuned for helyx
   * conventions, another for a different project) without cloning the
   * whole definition. Added in migration v33.
   */
  systemPromptOverride: string | null;
  /**
   * Optional Telegram forum topic id this instance is bound to. When
   * set, the standalone-llm worker routes task results to this topic
   * via the bot API after task completion. Use case: pin an
   * orchestrator/planner agent to its project's discussion topic so
   * results land where the team is already watching. Added in migration
   * v33.
   */
  forumTopicId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

function rowToInstance(r: any): AgentInstance {
  return {
    id: r.id,
    definitionId: r.definition_id,
    projectId: r.project_id,
    name: r.name,
    desiredState: r.desired_state as DesiredState,
    actualState: r.actual_state as ActualState,
    runtimeHandle: r.runtime_handle ?? {},
    lastSnapshot: r.last_snapshot,
    lastSnapshotAt: r.last_snapshot_at,
    lastHealthAt: r.last_health_at,
    restartCount: r.restart_count,
    lastRestartAt: r.last_restart_at,
    sessionId: r.session_id,
    systemPromptOverride: r.system_prompt_override ?? null,
    forumTopicId: r.forum_topic_id != null ? Number(r.forum_topic_id) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToDefinition(r: any): AgentDefinition {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    runtimeType: r.runtime_type,
    runtimeDriver: r.runtime_driver,
    modelProfileId: r.model_profile_id,
    systemPrompt: r.system_prompt,
    capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
    config: r.config ?? {},
    enabled: r.enabled,
  };
}

export class AgentManager {
  // ---------- Definitions ----------

  async listDefinitions(): Promise<AgentDefinition[]> {
    const rows = await sql`
      SELECT * FROM agent_definitions WHERE enabled = true ORDER BY name
    ` as any[];
    return rows.map(rowToDefinition);
  }

  async getDefinition(id: number): Promise<AgentDefinition | null> {
    const [r] = await sql`SELECT * FROM agent_definitions WHERE id = ${id} LIMIT 1` as any[];
    return r ? rowToDefinition(r) : null;
  }

  async getDefinitionByName(name: string): Promise<AgentDefinition | null> {
    const [r] = await sql`SELECT * FROM agent_definitions WHERE name = ${name} LIMIT 1` as any[];
    return r ? rowToDefinition(r) : null;
  }

  // ---------- Instances ----------

  /**
   * List agent_instances with optional filter.
   * NOTE: filter is single-dimension first-wins (projectId > desiredState > actualState).
   * If multiple fields are passed, only the highest-priority one is applied.
   * Pass exactly one field, or none to list all.
   */
  async listInstances(filter?: { projectId?: number; desiredState?: DesiredState; actualState?: ActualState }): Promise<AgentInstance[]> {
    let rows: any[];
    if (filter?.projectId !== undefined) {
      rows = await sql`SELECT * FROM agent_instances WHERE project_id = ${filter.projectId} ORDER BY name` as any[];
    } else if (filter?.desiredState) {
      rows = await sql`SELECT * FROM agent_instances WHERE desired_state = ${filter.desiredState} ORDER BY id` as any[];
    } else if (filter?.actualState) {
      rows = await sql`SELECT * FROM agent_instances WHERE actual_state = ${filter.actualState} ORDER BY id` as any[];
    } else {
      rows = await sql`SELECT * FROM agent_instances ORDER BY id` as any[];
    }
    return rows.map(rowToInstance);
  }

  /**
   * Enriched listing for the dashboard / CLI: returns each instance
   * joined with its agent_definition (name, runtime_type, capabilities,
   * enabled flag) and project (name). Saves the consumer a per-row
   * roundtrip and keeps the schema-coupling JOIN inside this service so
   * dashboard-api / cli.ts no longer need to issue raw SQL — F-006 from
   * the PR #7 review.
   *
   * Filter semantics match `listInstances`. Returns rows in snake_case
   * for the joined columns (definition_name, runtime_type,
   * capabilities, definition_enabled, project_name) and nests the core
   * AgentInstance under the same shape as listInstances.
   */
  async listInstancesEnriched(filter?: { projectId?: number; desiredState?: DesiredState; actualState?: ActualState }): Promise<Array<AgentInstance & {
    definition_name: string;
    runtime_type: string;
    capabilities: string[];
    definition_enabled: boolean;
    project_name: string | null;
  }>> {
    const projectId = filter?.projectId ?? null;
    const desiredState = filter?.desiredState ?? null;
    const actualState = filter?.actualState ?? null;
    const rows = (await sql`
      SELECT ai.*,
             ad.name AS definition_name,
             ad.runtime_type,
             ad.capabilities,
             ad.enabled AS definition_enabled,
             p.name AS project_name
      FROM agent_instances ai
      JOIN agent_definitions ad ON ad.id = ai.definition_id
      LEFT JOIN projects p ON p.id = ai.project_id
      WHERE (${projectId}::int IS NULL OR ai.project_id = ${projectId})
        AND (${desiredState}::text IS NULL OR ai.desired_state = ${desiredState})
        AND (${actualState}::text IS NULL OR ai.actual_state = ${actualState})
      ORDER BY ai.id ASC
    `) as any[];
    return rows.map((r) => ({
      ...rowToInstance(r),
      definition_name: r.definition_name,
      runtime_type: r.runtime_type,
      capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
      definition_enabled: r.definition_enabled,
      project_name: r.project_name ?? null,
    }));
  }

  async getInstance(id: number): Promise<AgentInstance | null> {
    const [r] = await sql`SELECT * FROM agent_instances WHERE id = ${id} LIMIT 1` as any[];
    return r ? rowToInstance(r) : null;
  }

  async getInstanceByName(projectId: number, name: string): Promise<AgentInstance | null> {
    const [r] = await sql`
      SELECT * FROM agent_instances WHERE project_id = ${projectId} AND name = ${name} LIMIT 1
    ` as any[];
    return r ? rowToInstance(r) : null;
  }

  /**
   * Find a running agent_instance bound to a Telegram forum topic via
   * `forum_topic_id`. Used by `bot/text-handler.ts` to route plain-text
   * messages in a topic into agent_tasks for the bound agent (Pattern A
   * v1.42.0).
   *
   * Returns null when:
   *  - no instance binds to this topic, OR
   *  - the instance exists but `desired_state='stopped'` (operator
   *    has disabled it; messages should not pile up as queued tasks).
   *
   * If multiple instances claim the same topic, returns the one with
   * the highest priority for routing (running > others, lowest id as
   * tiebreaker for determinism). The UI / migration ideally prevents
   * multi-binding, but the handler must be deterministic regardless.
   */
  async getInstanceByForumTopic(topicId: number): Promise<AgentInstance | null> {
    // `desired_state` is NOT NULL per schema (CHECK constraint, default
    // 'stopped' — see migration v6). The `IS NULL OR` clause below is
    // defense-in-depth: if a future migration ever drops the NOT NULL,
    // SQL three-valued logic would silently exclude NULL rows from
    // `!= 'stopped'` and they'd never route. Explicit form survives
    // schema drift without changing behavior today.
    const rows = (await sql`
      SELECT * FROM agent_instances
      WHERE forum_topic_id = ${topicId}
        AND (desired_state IS NULL OR desired_state != 'stopped')
      ORDER BY
        CASE actual_state
          WHEN 'running' THEN 0
          WHEN 'idle' THEN 0
          WHEN 'busy' THEN 1
          WHEN 'starting' THEN 2
          ELSE 3
        END,
        id
      LIMIT 1
    `) as any[];
    return rows.length > 0 ? rowToInstance(rows[0]) : null;
  }

  /** Create a new agent_instance. Returns the inserted row. */
  async createInstance(input: {
    definitionId: number;
    projectId: number | null;
    name: string;
    runtimeHandle?: Record<string, unknown>;
    desiredState?: DesiredState;
    /** Optional per-instance system prompt override (v33+). */
    systemPromptOverride?: string | null;
    /** Optional Telegram forum topic to route results to (v33+). */
    forumTopicId?: number | null;
  }): Promise<AgentInstance> {
    const handle = input.runtimeHandle ?? {};
    const desired = input.desiredState ?? "stopped";
    // sql.json() forces JSONB encoding at the wire-protocol layer.
    // The previous `${JSON.stringify(handle)}::jsonb` form was silently
    // stripped by postgres.js v3, binding the parameter as TEXT and
    // storing it as a JSONB scalar string (not a parsed object).
    // See v1.37.0 systemic fix.
    const [r] = await sql`
      INSERT INTO agent_instances (
        definition_id, project_id, name, desired_state, actual_state,
        runtime_handle, system_prompt_override, forum_topic_id
      )
      VALUES (
        ${input.definitionId},
        ${input.projectId},
        ${input.name},
        ${desired},
        'new',
        ${sql.json(handle)},
        ${input.systemPromptOverride ?? null},
        ${input.forumTopicId ?? null}
      )
      RETURNING *
    ` as any[];
    return rowToInstance(r);
  }

  // ---------- State transitions ----------

  /**
   * Set desired_state. Records an event. Returns the updated instance.
   * The reconciler will pick this up on its next tick.
   */
  async setDesiredState(id: number, state: DesiredState, reason?: string): Promise<AgentInstance> {
    return await sql.begin(async (tx) => {
      const [before] = await tx`
        SELECT * FROM agent_instances WHERE id = ${id} FOR UPDATE
      ` as any[];
      if (!before) throw new Error(`agent_instance ${id} not found`);
      const fromState = before.desired_state;
      if (fromState === state) {
        return rowToInstance(before);  // no-op
      }
      const [after] = await tx`
        UPDATE agent_instances
        SET desired_state = ${state}, updated_at = now()
        WHERE id = ${id}
        RETURNING *
      ` as any[];
      await tx`
        INSERT INTO agent_events (agent_instance_id, event_type, from_state, to_state, message)
        VALUES (${id}, 'desired_state_change', ${fromState}, ${state}, ${reason ?? null})
      `;
      logger.info({ agentInstanceId: id, fromState, toState: state, reason }, "desired_state changed");
      return rowToInstance(after);
    }) as AgentInstance;
  }

  /**
   * Set actual_state. Used by the reconcile loop.
   * Records a state_change event when from != to.
   */
  async setActualState(id: number, state: ActualState, message?: string): Promise<void> {
    await sql.begin(async (tx) => {
      const [before] = await tx`
        SELECT actual_state FROM agent_instances WHERE id = ${id} FOR UPDATE
      ` as any[];
      if (!before) return;
      if (before.actual_state === state) {
        // No transition — just touch updated_at and last_health_at
        await tx`
          UPDATE agent_instances SET last_health_at = now(), updated_at = now() WHERE id = ${id}
        `;
        return;
      }
      await tx`
        UPDATE agent_instances
        SET actual_state = ${state}, last_health_at = now(), updated_at = now()
        WHERE id = ${id}
      `;
      await tx`
        INSERT INTO agent_events (agent_instance_id, event_type, from_state, to_state, message)
        VALUES (${id}, 'actual_state_change', ${before.actual_state}, ${state}, ${message ?? null})
      `;
    });
  }

  /** Increment restart counter. Used by reconciler when restarting after failure. */
  async incrementRestartCount(id: number): Promise<void> {
    await sql`
      UPDATE agent_instances
      SET restart_count = restart_count + 1, last_restart_at = now(), updated_at = now()
      WHERE id = ${id}
    `;
  }

  /**
   * Delete an agent_instance row. Caller is responsible for stopping the
   * instance first (set desired_state='stopped', wait for actual_state to
   * settle) — this method does not interact with the runtime driver and
   * will leave orphan tmux windows / processes if invoked on a running
   * instance.
   *
   * FK behavior:
   *  - agent_tasks.agent_instance_id ON DELETE SET NULL — tasks survive,
   *    become unassigned. Caller should reassign or cancel beforehand.
   *  - agent_events.agent_instance_id ON DELETE CASCADE — events purged.
   *  - sessions.id linkage cleared via ON DELETE SET NULL.
   *
   * Idempotent: deleting a non-existent id returns false without throwing.
   */
  async deleteInstance(id: number): Promise<boolean> {
    const result = (await sql`
      DELETE FROM agent_instances WHERE id = ${id}
    `) as unknown as { count: number };
    return Number(result?.count ?? 0) > 0;
  }

  /** Update runtime_handle (driver may add fields after start). */
  async updateRuntimeHandle(id: number, handle: Record<string, unknown>): Promise<void> {
    await sql`
      UPDATE agent_instances
      SET runtime_handle = ${sql.json(handle)}, updated_at = now()
      WHERE id = ${id}
    `;
  }

  /** Update last snapshot (called by watchdog or reconciler). */
  async updateSnapshot(id: number, snapshot: string): Promise<void> {
    // Truncate to ~4KB to avoid bloat
    const truncated = snapshot.length > 4096 ? snapshot.slice(-4096) : snapshot;
    await sql`
      UPDATE agent_instances
      SET last_snapshot = ${truncated}, last_snapshot_at = now(), updated_at = now()
      WHERE id = ${id}
    `;
  }

  /** Link a session to an agent_instance (set on session register). */
  async linkSession(id: number, sessionId: number | null): Promise<void> {
    await sql`
      UPDATE agent_instances SET session_id = ${sessionId}, updated_at = now() WHERE id = ${id}
    `;
  }

  // ---------- Events ----------

  async logEvent(input: {
    agentInstanceId: number;
    eventType: string;
    taskId?: number;
    message?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await sql`
      INSERT INTO agent_events (agent_instance_id, task_id, event_type, message, metadata)
      VALUES (
        ${input.agentInstanceId},
        ${input.taskId ?? null},
        ${input.eventType},
        ${input.message ?? null},
        ${sql.json(input.metadata ?? {})}
      )
    `;
  }
}

export const agentManager = new AgentManager();
