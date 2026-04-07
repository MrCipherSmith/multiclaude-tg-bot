import { sql } from "../memory/db.ts";
import { normalizeCLIConfig } from "../utils/cli-config.ts";
import { basename } from "path";

export interface Session {
  id: number;
  name: string | null;
  project: string | null;
  source: "remote" | "local" | "standalone";
  projectPath: string | null;
  clientId: string;
  status: "active" | "inactive" | "terminated" | "disconnected";
  projectId: number | null;
  metadata: Record<string, unknown>;
  connectedAt: Date;
  lastActive: Date;
  cliType: "claude";
  cliConfig: Record<string, unknown>;
}

/** Display name shown in Telegram: "keryx · remote", "goodai-base · local", "standalone" */
export function sessionDisplayName(s: Pick<Session, "id" | "project" | "source" | "name" | "clientId">): string {
  if (s.id === 0) return "standalone";
  if (s.project) return `${s.project} · ${s.source}`;
  return s.name ?? s.clientId;
}

export class SessionManager {
  // Map of SSE client_id -> session_id for quick lookup
  private activeClients = new Map<string, number>();

  async register(
    clientId: string,
    name?: string,
    projectPath?: string,
    metadata?: Record<string, unknown>,
    cliConfig?: Record<string, unknown>,
  ): Promise<Session> {
    const project = projectPath ? basename(projectPath) : null;
    const [row] = await sql`
      INSERT INTO sessions (name, project, source, project_path, client_id, status, metadata, cli_type, cli_config)
      VALUES (
        ${name ?? null},
        ${project},
        ${'local'},
        ${projectPath ?? null},
        ${clientId},
        'active',
        ${JSON.stringify(metadata ?? {})}::jsonb,
        'claude',
        ${JSON.stringify(cliConfig ?? {})}::jsonb
      )
      ON CONFLICT (client_id) DO UPDATE SET
        status = 'active',
        name = COALESCE(EXCLUDED.name, sessions.name),
        project = COALESCE(EXCLUDED.project, sessions.project),
        project_path = COALESCE(EXCLUDED.project_path, sessions.project_path),
        metadata = COALESCE(EXCLUDED.metadata, sessions.metadata),
        cli_type = EXCLUDED.cli_type,
        cli_config = EXCLUDED.cli_config,
        last_active = now()
      RETURNING id, name, project, source, project_path, project_id, client_id, status, metadata, connected_at, last_active, cli_type, cli_config
    `;

    const session = this.rowToSession(row);
    this.activeClients.set(clientId, session.id);
    console.log(`[session] registered: ${session.id} (${session.name ?? clientId})`);
    return session;
  }

  async registerRemote(
    projectId: number,
    projectPath: string,
    name: string,
  ): Promise<Session> {
    const [row] = await sql`
      INSERT INTO sessions (name, project, source, project_path, project_id, client_id, status, metadata, cli_type, cli_config)
      VALUES (
        ${name},
        ${name},
        'remote',
        ${projectPath},
        ${projectId},
        ${'remote-' + projectId},
        'inactive',
        '{}'::jsonb,
        'claude',
        '{}'::jsonb
      )
      ON CONFLICT (project_id) WHERE source = 'remote' DO UPDATE SET
        name = EXCLUDED.name,
        project_path = EXCLUDED.project_path,
        last_active = now()
      RETURNING id, name, project, source, project_path, project_id, client_id, status, metadata, connected_at, last_active, cli_type, cli_config
    `;
    const session = this.rowToSession(row);
    console.log(`[session] remote registered: #${session.id} (${name})`);
    return session;
  }

  /**
   * Adopt a named session: if a session with this name already exists,
   * update it with the new client_id (so it keeps its ID and memory).
   * If not, rename the current session.
   * Returns the final session ID.
   */
  /**
   * Called by Claude Code's set_session_name MCP tool.
   * Finds the channel.ts session for this project_path (any source) and links
   * the current HTTP MCP client_id to it — so both share the same session ID.
   * Falls back to renaming the current cli session if no channel session exists.
   */
  async adoptOrRename(
    currentClientId: string,
    name: string,
    projectPath?: string,
  ): Promise<Session> {
    // Look for an existing channel.ts session for this project (by project_path + source)
    const channelSession = projectPath ? await sql`
      SELECT id, client_id FROM sessions
      WHERE project_path = ${projectPath}
        AND source IN ('remote', 'local')
        AND client_id != ${currentClientId}
        AND id != 0
      ORDER BY last_active DESC
      LIMIT 1
    ` : [];

    if (channelSession.length > 0) {
      const targetId = channelSession[0].id;
      const oldClientId = channelSession[0].client_id;

      // Delete the temporary cli-xxx session Claude Code registered with
      const currentSession = await sql`SELECT id FROM sessions WHERE client_id = ${currentClientId}`;
      if (currentSession.length > 0) {
        await sql`DELETE FROM sessions WHERE id = ${currentSession[0].id} AND name LIKE 'cli-%'`;
      }

      // Link current HTTP client to the channel.ts session
      const [row] = await sql`
        UPDATE sessions
        SET client_id = ${currentClientId}, status = 'active', last_active = now()
        WHERE id = ${targetId}
        RETURNING id, name, project, source, project_path, project_id, client_id, status, metadata, connected_at, last_active, cli_type, cli_config
      `;

      if (!row) throw new Error(`[session] adoptOrRename: session #${targetId} not found`);
      const session = this.rowToSession(row);
      this.activeClients.delete(oldClientId);
      this.activeClients.set(currentClientId, session.id);
      console.log(`[session] linked Claude Code to channel session #${session.id} (${sessionDisplayName(session)})`);
      return session;
    }

    // No channel.ts session found — rename the current cli session
    const [row] = await sql`
      UPDATE sessions
      SET name = ${name},
          project = ${name},
          source = 'local',
          project_path = COALESCE(${projectPath ?? null}, project_path)
      WHERE client_id = ${currentClientId}
      RETURNING id, name, project, source, project_path, project_id, client_id, status, metadata, connected_at, last_active, cli_type, cli_config
    `;
    if (!row) throw new Error(`[session] adoptOrRename: session not found for clientId ${currentClientId}`);
    const session = this.rowToSession(row);
    console.log(`[session] renamed session #${session.id} to ${sessionDisplayName(session)}`);
    return session;
  }

  async disconnect(clientId: string): Promise<void> {
    const rows = await sql`SELECT id, name, source, project FROM sessions WHERE client_id = ${clientId}`;
    if (rows.length === 0) { this.activeClients.delete(clientId); return; }

    const { id, name, source, project } = rows[0];
    // Ephemeral: unnamed cli sessions OR sessions without a project (HTTP MCP temp registrations)
    const isEphemeral = name?.startsWith("cli-") || !project;

    if (isEphemeral) {
      await sql`DELETE FROM sessions WHERE client_id = ${clientId}`;
      await this.resetSequence();
      console.log(`[session] removed ephemeral session: ${clientId}`);
    } else {
      // Named/channel session — set status based on source
      const newStatus = source === 'remote' ? 'inactive' : 'terminated';
      await sql`UPDATE sessions SET status = ${newStatus}, last_active = now() WHERE id = ${id}`;
      console.log(`[session] disconnected: #${id} (${name ?? source}) -> ${newStatus}`);
    }
    this.activeClients.delete(clientId);
  }

  async cleanup(): Promise<number> {
    const result = await sql`
      DELETE FROM sessions
      WHERE id != 0
        AND source != 'remote'
        AND status IN ('disconnected', 'terminated')
      RETURNING id
    `;
    return result.length;
  }

  /**
   * Mark "active" sessions as disconnected if last_active is older than maxAge
   * and there's no live transport (client not in activeClients map).
   */
  async markStale(maxAgeSeconds: number = 600): Promise<number> {
    // Get all DB-active sessions
    const rows = await sql`
      SELECT id, client_id, source FROM sessions
      WHERE status = 'active' AND id != 0
        AND last_active < now() - make_interval(secs => ${maxAgeSeconds})
    `;
    let count = 0;
    for (const row of rows) {
      // If client is not tracked in-memory, it's a zombie
      if (!this.activeClients.has(row.client_id)) {
        const newStatus = row.source === 'remote' ? 'inactive' : 'terminated';
        await sql`UPDATE sessions SET status = ${newStatus} WHERE id = ${row.id}`;
        console.log(`[session] marked stale: #${row.id} (${row.client_id.slice(0, 8)}) -> ${newStatus}`);
        count++;
      }
    }
    return count;
  }

  /** Reset the sessions_id_seq to current MAX(id) to avoid gaps after deletions */
  async resetSequence(): Promise<void> {
    await sql`SELECT setval('sessions_id_seq', GREATEST((SELECT MAX(id) FROM sessions), 1))`;
  }

  async touchActivity(sessionId: number): Promise<void> {
    await sql`UPDATE sessions SET last_active = now() WHERE id = ${sessionId}`;
  }

  async updateCliConfig(sessionId: number, patch: Record<string, unknown>): Promise<void> {
    const rows = await sql`SELECT cli_config FROM sessions WHERE id = ${sessionId}`;
    const current = normalizeCLIConfig(rows[0]?.cli_config);
    const updated = { ...current, ...patch };
    await sql`UPDATE sessions SET cli_config = ${JSON.stringify(updated)}::jsonb WHERE id = ${sessionId}`;
  }

  async list(includeUnnamed = false): Promise<Session[]> {
    const rows = includeUnnamed
      ? await sql`
          SELECT id, name, project, source, project_path, project_id, client_id, status, metadata, connected_at, last_active, cli_type, cli_config
          FROM sessions ORDER BY id
        `
      : await sql`
          SELECT id, name, project, source, project_path, project_id, client_id, status, metadata, connected_at, last_active, cli_type, cli_config
          FROM sessions
          WHERE id = 0 OR (name NOT LIKE 'cli-%' OR project IS NOT NULL)
          ORDER BY id
        `;
    return rows.map(this.rowToSession);
  }

  async get(sessionId: number): Promise<Session | null> {
    const rows = await sql`
      SELECT id, name, project, source, project_path, project_id, client_id, status, metadata, connected_at, last_active, cli_type, cli_config
      FROM sessions WHERE id = ${sessionId}
    `;
    return rows.length > 0 ? this.rowToSession(rows[0]) : null;
  }

  async getActiveSession(chatId: string): Promise<number> {
    const rows = await sql`
      SELECT active_session_id FROM chat_sessions WHERE chat_id = ${chatId}
    `;
    return rows.length > 0 ? rows[0].active_session_id : 0;
  }

  async switchSession(chatId: string, sessionId: number): Promise<void> {
    await sql`
      INSERT INTO chat_sessions (chat_id, active_session_id)
      VALUES (${chatId}, ${sessionId})
      ON CONFLICT (chat_id) DO UPDATE SET active_session_id = ${sessionId}
    `;
  }

  getSessionIdByClient(clientId: string): number | undefined {
    return this.activeClients.get(clientId);
  }


  async getByClientId(clientId: string): Promise<Session | null> {
    const rows = await sql`
      SELECT id, name, project, source, project_path, project_id, client_id, status, metadata, connected_at, last_active, cli_type, cli_config
      FROM sessions WHERE client_id = ${clientId}
    `;
    return rows.length > 0 ? this.rowToSession(rows[0]) : null;
  }

  /** Delete all orphaned cli-xxx sessions (no live transport) — call on startup */
  async deleteOrphanCliSessions(): Promise<number> {
    const result = await sql`
      DELETE FROM sessions
      WHERE name LIKE 'cli-%' AND project IS NULL
      RETURNING id
    `;
    return result.length;
  }

  private rowToSession(r: Record<string, any>): Session {
    return {
      id: r.id,
      name: r.name,
      project: r.project ?? null,
      source: (r.source as Session["source"]) ?? "standalone",
      projectPath: r.project_path,
      projectId: r.project_id ?? null,
      clientId: r.client_id,
      status: r.status,
      metadata: r.metadata ?? {},
      connectedAt: r.connected_at,
      lastActive: r.last_active,
      cliType: "claude" as const,
      cliConfig: normalizeCLIConfig(r.cli_config),
    };
  }
}

export const sessionManager = new SessionManager();
