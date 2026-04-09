import { sql } from "../memory/db.ts";
import { deleteSessionCascade } from "../sessions/delete.ts";

export interface Session {
  id: number;
  name: string;
  project_path: string | null;
  source: string;
  status: string;
  connected_at: Date | null;
  last_active: Date | null;
}

export interface SessionDetail extends Session {
  project: string | null;
  client_id: string | null;
  metadata: unknown;
  message_count: number;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    api_calls: number;
  };
  recent_tools: unknown[];
}

export class SessionService {
  async list(): Promise<Session[]> {
    return sql`
      SELECT id, name, project_path, source, status, connected_at, last_active
      FROM sessions WHERE id != 0 ORDER BY last_active DESC
    ` as unknown as Session[];
  }

  async get(id: number): Promise<Session | null> {
    const rows = await sql`
      SELECT id, name, project_path, source, status, connected_at, last_active
      FROM sessions WHERE id = ${id}
    ` as unknown as Session[];
    return rows[0] ?? null;
  }

  async getDetail(id: number): Promise<SessionDetail | null> {
    const sessions = await sql`
      SELECT id, name, project, project_path, source, client_id, status, metadata, connected_at, last_active
      FROM sessions WHERE id = ${id}
    ` as unknown as (Session & { project: string | null; client_id: string | null; metadata: unknown })[];
    const session = sessions[0];
    if (!session) return null;

    const [{ count }, tokenStats, recentTools] = await Promise.all([
      sql`SELECT count(*)::int FROM messages WHERE session_id = ${id}`.then((r) => r[0]),
      (sql`
        SELECT
          coalesce(sum(input_tokens), 0)::int AS input_tokens,
          coalesce(sum(output_tokens), 0)::int AS output_tokens,
          coalesce(sum(total_tokens), 0)::int AS total_tokens,
          count(*)::int AS api_calls
        FROM api_request_stats WHERE session_id = ${id}
      ` as unknown as Promise<{ input_tokens: number; output_tokens: number; total_tokens: number; api_calls: number }[]>).then((r) => r[0]),
      sql`
        SELECT tool_name, response, created_at
        FROM permission_requests
        WHERE session_id = ${id} AND archived_at IS NULL
        ORDER BY created_at DESC LIMIT 15
      `,
    ]);

    return {
      ...session,
      message_count: count,
      tokens: tokenStats,
      recent_tools: recentTools,
    };
  }

  async rename(id: number, name: string): Promise<Session | null> {
    const rows = await sql`
      UPDATE sessions SET name = ${name} WHERE id = ${id}
      RETURNING id, name, project_path, status, connected_at, last_active
    ` as unknown as Session[];
    return rows[0] ?? null;
  }

  async delete(id: number): Promise<void> {
    await deleteSessionCascade(id);
  }

  async getActiveForChat(chatId: string): Promise<number | null> {
    const [row] = await sql`SELECT active_session_id FROM chat_sessions WHERE chat_id = ${chatId}`;
    return row?.active_session_id ?? null;
  }

  async switchChat(chatId: string, sessionId: number): Promise<void> {
    await sql`
      INSERT INTO chat_sessions (chat_id, active_session_id)
      VALUES (${chatId}, ${sessionId})
      ON CONFLICT (chat_id) DO UPDATE SET active_session_id = ${sessionId}
    `;
  }

  async touchActivity(sessionId: number): Promise<void> {
    await sql`UPDATE sessions SET last_active = now() WHERE id = ${sessionId}`;
  }
}

export const sessionService = new SessionService();
