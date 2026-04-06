import { sql } from "../memory/db.ts";

export interface Session {
  id: number;
  name: string | null;
  projectPath: string | null;
  clientId: string;
  status: "active" | "disconnected";
  metadata: Record<string, unknown>;
  connectedAt: Date;
  lastActive: Date;
  cliType: "claude" | "opencode";
  cliConfig: Record<string, unknown>;
}

export class SessionManager {
  // Map of SSE client_id -> session_id for quick lookup
  private activeClients = new Map<string, number>();

  async register(
    clientId: string,
    name?: string,
    projectPath?: string,
    metadata?: Record<string, unknown>,
    cliType?: "claude" | "opencode",
    cliConfig?: Record<string, unknown>,
  ): Promise<Session> {
    // Deduplicate: if a session with the same name and project_path already exists, adopt it
    if (projectPath && name && !name.startsWith("cli-")) {
      const existing = await sql`
        SELECT id, name, client_id FROM sessions
        WHERE project_path = ${projectPath} AND name = ${name} AND id != 0
        LIMIT 1
      `;
      if (existing.length > 0) {
        const old = existing[0];
        this.activeClients.delete(old.client_id);
        const [row] = await sql`
          UPDATE sessions
          SET client_id = ${clientId}, status = 'active', last_active = now(),
              cli_type = ${cliType ?? "claude"}, cli_config = ${JSON.stringify(cliConfig ?? {})}
          WHERE id = ${old.id}
          RETURNING id, name, project_path, client_id, status, metadata, connected_at, last_active, cli_type, cli_config
        `;
        const session = this.rowToSession(row);
        this.activeClients.set(clientId, session.id);
        console.log(`[session] reused existing session #${session.id} (${session.name}) for ${projectPath}`);
        return session;
      }
    }

    const [row] = await sql`
      INSERT INTO sessions (name, project_path, client_id, status, metadata, cli_type, cli_config)
      VALUES (
        ${name ?? null},
        ${projectPath ?? null},
        ${clientId},
        'active',
        ${JSON.stringify(metadata ?? {})},
        ${cliType ?? "claude"},
        ${JSON.stringify(cliConfig ?? {})}
      )
      ON CONFLICT (client_id) DO UPDATE SET
        status = 'active',
        name = COALESCE(EXCLUDED.name, sessions.name),
        project_path = COALESCE(EXCLUDED.project_path, sessions.project_path),
        metadata = COALESCE(EXCLUDED.metadata, sessions.metadata),
        cli_type = EXCLUDED.cli_type,
        cli_config = EXCLUDED.cli_config,
        last_active = now()
      RETURNING id, name, project_path, client_id, status, metadata, connected_at, last_active, cli_type, cli_config
    `;

    const session = this.rowToSession(row);
    this.activeClients.set(clientId, session.id);
    console.log(`[session] registered: ${session.id} (${session.name ?? clientId})`);
    return session;
  }

  /**
   * Adopt a named session: if a session with this name already exists,
   * update it with the new client_id (so it keeps its ID and memory).
   * If not, rename the current session.
   * Returns the final session ID.
   */
  async adoptOrRename(
    currentClientId: string,
    name: string,
    projectPath?: string,
  ): Promise<Session> {
    // Find existing named session (not the current one)
    const existing = await sql`
      SELECT id, client_id FROM sessions
      WHERE name = ${name} AND client_id != ${currentClientId} AND id != 0
      LIMIT 1
    `;

    if (existing.length > 0) {
      // Existing named session found — adopt it: update its client_id
      const oldId = existing[0].id;
      const oldClientId = existing[0].client_id;

      // Delete the unnamed session we just created
      const currentSession = await sql`
        SELECT id FROM sessions WHERE client_id = ${currentClientId}
      `;
      if (currentSession.length > 0) {
        await sql`DELETE FROM sessions WHERE id = ${currentSession[0].id} AND name LIKE 'cli-%'`;
      }

      // Update the existing named session with new client_id
      const [row] = await sql`
        UPDATE sessions
        SET client_id = ${currentClientId}, status = 'active', last_active = now(),
            project_path = COALESCE(${projectPath ?? null}, project_path)
        WHERE id = ${oldId}
        RETURNING id, name, project_path, client_id, status, metadata, connected_at, last_active, cli_type, cli_config
      `;

      if (!row) throw new Error(`[session] adoptOrRename: session #${oldId} not found for update`);
      const session = this.rowToSession(row);
      this.activeClients.delete(oldClientId);
      this.activeClients.set(currentClientId, session.id);
      console.log(`[session] adopted existing session #${session.id} (${name})`);
      return session;
    } else {
      // No existing session with this name — just rename current
      const [row] = await sql`
        UPDATE sessions
        SET name = ${name}, project_path = COALESCE(${projectPath ?? null}, project_path)
        WHERE client_id = ${currentClientId}
        RETURNING id, name, project_path, client_id, status, metadata, connected_at, last_active, cli_type, cli_config
      `;
      if (!row) throw new Error(`[session] adoptOrRename: session not found for clientId ${currentClientId}`);
      const session = this.rowToSession(row);
      console.log(`[session] renamed session #${session.id} to ${name}`);
      return session;
    }
  }

  async disconnect(clientId: string): Promise<void> {
    const rows = await sql`
      SELECT id, name FROM sessions WHERE client_id = ${clientId}
    `;
    if (rows.length > 0 && (rows[0].name?.startsWith("cli-") || rows[0].name?.endsWith(" · cli"))) {
      // CLI session — just delete and reset sequence
      await sql`DELETE FROM sessions WHERE client_id = ${clientId}`;
      await this.resetSequence();
      console.log(`[session] removed cli session: ${clientId}`);
    } else {
      // Named session — keep but mark disconnected
      await sql`
        UPDATE sessions SET status = 'disconnected', last_active = now()
        WHERE client_id = ${clientId}
      `;
      console.log(`[session] disconnected: ${clientId}`);
    }
    this.activeClients.delete(clientId);
  }

  async cleanup(): Promise<number> {
    const result = await sql`
      DELETE FROM sessions
      WHERE id != 0
        AND status = 'disconnected'
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
      SELECT id, client_id FROM sessions
      WHERE status = 'active' AND id != 0
        AND last_active < now() - make_interval(secs => ${maxAgeSeconds})
    `;
    let count = 0;
    for (const row of rows) {
      // If client is not tracked in-memory, it's a zombie
      if (!this.activeClients.has(row.client_id)) {
        await sql`UPDATE sessions SET status = 'disconnected' WHERE id = ${row.id}`;
        console.log(`[session] marked stale: #${row.id} (${row.client_id.slice(0, 8)})`);
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
    await sql`
      UPDATE sessions
      SET cli_config = cli_config || ${JSON.stringify(patch)}::jsonb
      WHERE id = ${sessionId}
    `;
  }

  async list(includeUnnamed = false): Promise<Session[]> {
    const rows = includeUnnamed
      ? await sql`
          SELECT id, name, project_path, client_id, status, metadata, connected_at, last_active, cli_type, cli_config
          FROM sessions ORDER BY id
        `
      : await sql`
          SELECT id, name, project_path, client_id, status, metadata, connected_at, last_active, cli_type, cli_config
          FROM sessions
          WHERE id = 0 OR name NOT LIKE 'cli-%'
          ORDER BY id
        `;
    return rows.map(this.rowToSession);
  }

  async get(sessionId: number): Promise<Session | null> {
    const rows = await sql`
      SELECT id, name, project_path, client_id, status, metadata, connected_at, last_active, cli_type, cli_config
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

  private rowToSession(r: Record<string, any>): Session {
    return {
      id: r.id,
      name: r.name,
      projectPath: r.project_path,
      clientId: r.client_id,
      status: r.status,
      metadata: r.metadata ?? {},
      connectedAt: r.connected_at,
      lastActive: r.last_active,
      cliType: (r.cli_type ?? "claude") as "claude" | "opencode",
      cliConfig: r.cli_config ?? {},
    };
  }
}

export const sessionManager = new SessionManager();
