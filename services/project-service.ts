import { sql } from "../memory/db.ts";
import { deleteSessionCascade } from "../sessions/delete.ts";

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
      LEFT JOIN sessions s ON s.project_id = p.id AND s.source = 'remote'
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
    const [project] = await sql`SELECT id, name, path, tmux_session_name FROM projects WHERE id = ${id}`;
    if (!project) return { ok: false, error: "Project not found" };
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
