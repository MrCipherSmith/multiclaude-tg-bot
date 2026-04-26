import { sql } from "../memory/db.ts";
import { deleteSessionCascade } from "../sessions/delete.ts";
import { agentManager } from "../agents/agent-manager.ts";
import { logger } from "../logger.ts";

export interface Project {
  id: number;
  name: string;
  path: string;
  tmux_session_name: string;
  created_at: Date;
}

export interface ProjectWithSession extends Project {
  session_id: number | null;
  session_status: string | null;
}

export class ProjectService {
  async list(): Promise<ProjectWithSession[]> {
    return sql`
      SELECT p.id, p.name, p.path, p.tmux_session_name, p.created_at,
             s.id as session_id, s.status as session_status
      FROM projects p
      LEFT JOIN LATERAL (
        SELECT id, status FROM sessions
        WHERE project_id = p.id AND source = 'remote'
        ORDER BY (status = 'active') DESC, last_active DESC NULLS LAST
        LIMIT 1
      ) s ON true
      ORDER BY p.name
    ` as unknown as ProjectWithSession[];
  }

  async get(id: number): Promise<Project | null> {
    const rows = await sql`SELECT id, name, path, tmux_session_name, created_at FROM projects WHERE id = ${id}` as unknown as Project[];
    return rows[0] ?? null;
  }

  async getByPath(path: string): Promise<Project | null> {
    const rows = await sql`SELECT id, name, path, tmux_session_name, created_at FROM projects WHERE path = ${path}` as unknown as Project[];
    return rows[0] ?? null;
  }

  /**
   * Lookup by name. Used by dashboard / CLI handlers that accept a
   * project ref as either id or name. The `name` column is unique
   * (CREATE TABLE projects ... name TEXT NOT NULL UNIQUE) so this
   * always returns ≤ 1 row.
   */
  async getByName(name: string): Promise<Project | null> {
    const rows = await sql`SELECT id, name, path, tmux_session_name, created_at FROM projects WHERE name = ${name}` as unknown as Project[];
    return rows[0] ?? null;
  }

  async create(name: string, path: string): Promise<Project | null> {
    const tmuxName = name.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    const rows = await sql`
      INSERT INTO projects (name, path, tmux_session_name)
      VALUES (${name}, ${path}, ${tmuxName})
      ON CONFLICT (path) DO NOTHING
      RETURNING id, name, path, tmux_session_name, created_at
    `;
    if (rows.length === 0) return null; // already exists

    const project = rows[0] as Project;

    // Register remote session
    await sql`
      INSERT INTO sessions (project_id, name, project_path, source, status)
      VALUES (${project.id}, ${project.name}, ${project.path}, 'remote', 'inactive')
      ON CONFLICT DO NOTHING
    `.catch((err: unknown) => {
      console.error("[projects] failed to create remote session:", err);
    });

    return project;
  }

  async delete(id: number): Promise<{ ok: boolean; error?: string }> {
    const [project] = await sql`SELECT id FROM projects WHERE id = ${id}`;
    if (!project) return { ok: false, error: "Project not found" };

    const activeSessions = await sql`
      SELECT id FROM sessions WHERE project_id = ${id} AND status = 'active'
    `;
    if (activeSessions.length > 0) {
      return { ok: false, error: "Cannot delete project with active sessions" };
    }

    await sql`DELETE FROM projects WHERE id = ${id}`;
    return { ok: true };
  }

  async start(id: number): Promise<{ ok: boolean; error?: string }> {
    return this.action(id, "proj_start");
  }

  async stop(id: number): Promise<{ ok: boolean; error?: string }> {
    return this.action(id, "proj_stop");
  }

  private async action(id: number, command: string): Promise<{ ok: boolean; error?: string }> {
    const [project] = await sql`SELECT id, name, path, tmux_session_name, default_agent_instance_id FROM projects WHERE id = ${id}`;
    if (!project) return { ok: false, error: "Project not found" };

    // Idempotency: skip if a command for this project is already pending/processing
    const [existing] = await sql`
      SELECT id FROM admin_commands
      WHERE command = ${command}
        AND (payload->>'project_id')::int = ${id}
        AND status IN ('pending', 'processing')
      LIMIT 1
    `;
    if (existing) return { ok: true };

    // Additive: also set desired_state on the linked agent_instance.
    // The admin_commands path below remains the actuator — this is observe/write-through
    // for the new agent layer until reconciler takes over (Phase 5+).
    // Failures here are non-fatal: existing flow must keep working.
    if (project.default_agent_instance_id) {
      const desiredState = command === "proj_start" ? "running" : "stopped";
      try {
        await agentManager.setDesiredState(
          Number(project.default_agent_instance_id),
          desiredState,
          `project-service.${command === "proj_start" ? "start" : "stop"}`,
        );
      } catch (err) {
        logger.warn(
          { projectId: id, command, err: String(err) },
          "agentManager.setDesiredState failed (non-fatal, admin_commands path continues)",
        );
      }
    } else {
      logger.debug({ projectId: id, command }, "project has no default_agent_instance_id, skipping agent layer mirror");
    }

    await sql`INSERT INTO admin_commands (command, payload) VALUES (${command}, ${JSON.stringify({
      project_id: id,
      path: project.path,
      name: project.name,
      tmux_session_name: project.tmux_session_name,
    })}::jsonb)`;
    return { ok: true };
  }
}

export const projectService = new ProjectService();
