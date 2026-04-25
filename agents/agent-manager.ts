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

  async listInstances(filter?: { projectId?: number; desiredState?: DesiredState; actualState?: ActualState }): Promise<AgentInstance[]> {
    // Build dynamic WHERE without sql injection
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

  /** Create a new agent_instance. Returns the inserted row. */
  async createInstance(input: {
    definitionId: number;
    projectId: number | null;
    name: string;
    runtimeHandle?: Record<string, unknown>;
    desiredState?: DesiredState;
  }): Promise<AgentInstance> {
    const handle = input.runtimeHandle ?? {};
    const desired = input.desiredState ?? "stopped";
    const [r] = await sql`
      INSERT INTO agent_instances (definition_id, project_id, name, desired_state, actual_state, runtime_handle)
      VALUES (
        ${input.definitionId},
        ${input.projectId},
        ${input.name},
        ${desired},
        'new',
        ${JSON.stringify(handle)}::jsonb
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

  /** Update runtime_handle (driver may add fields after start). */
  async updateRuntimeHandle(id: number, handle: Record<string, unknown>): Promise<void> {
    await sql`
      UPDATE agent_instances
      SET runtime_handle = ${JSON.stringify(handle)}::jsonb, updated_at = now()
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
        ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
    `;
  }
}

export const agentManager = new AgentManager();
