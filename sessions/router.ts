import { sessionManager } from "./manager.ts";
import { sql } from "../memory/db.ts";
import { logger } from "../logger.ts";
import type { CliConfig } from "../adapters/types.ts";

export type RouteTarget =
  | { mode: "standalone"; sessionId: 0; projectPath?: null; agentInstanceId?: number | null }
  | { mode: "cli"; sessionId: number; clientId: string; cliConfig: CliConfig; projectPath?: string | null; agentInstanceId?: number | null }
  | { mode: "disconnected"; sessionId: number; sessionName: string | null; projectPath?: string | null; agentInstanceId?: number | null };

/**
 * Resolve the route for an incoming message.
 *
 * @param chatId      The Telegram chat_id (DM or forum supergroup).
 * @param forumTopicId  Optional message_thread_id from a forum topic message.
 *                    When set and > 1, route is resolved by forum_topic_id → project.
 *                    topic_id=1 (General topic) falls through to chat_sessions lookup.
 *
 * Phase 4 / Wave 3 (additive agent layer):
 *   When the project resolved via forum has a `default_agent_instance_id` set,
 *   the agent_instance.session_id column is backfilled to the resolved session
 *   as a side effect. Reads still use the legacy `sessions` table — this only
 *   makes sure the new agent_instances row points at the live session so
 *   future agent-layer consumers (watchdog snapshot mirror, reconciler) can
 *   find it. Backfill is best-effort: failures are logged and never break
 *   routing.
 *
 * TODO(phase-4+): detect `@agent_name` prefix in message text and route to a
 * named agent_instance under the same project. For now, all messages route to
 * the project's default_agent_instance_id.
 */
export async function routeMessage(chatId: string, forumTopicId?: number): Promise<RouteTarget> {
  // Forum routing: topic > 1 → look up project by forum_topic_id
  if (forumTopicId !== undefined && forumTopicId > 1) {
    const rows = await sql`
      SELECT p.id      AS project_id,
             p.path, p.name,
             p.default_agent_instance_id,
             s.id    AS session_id,
             s.status,
             s.client_id,
             s.cli_config
      FROM projects p
      LEFT JOIN sessions s ON s.project_id = p.id AND s.source = 'remote'
      WHERE p.forum_topic_id = ${forumTopicId}
      LIMIT 1
    `;

    if (rows.length > 0) {
      const row = rows[0];
      const agentInstanceId = (row.default_agent_instance_id as number | null) ?? null;
      const resolvedSessionId = (row.session_id as number | null) ?? null;

      // Side-effect: backfill agent_instances.session_id when it's missing or stale.
      // Best-effort, additive — does not affect the return value semantics.
      if (agentInstanceId && resolvedSessionId) {
        try {
          await sql`
            UPDATE agent_instances
            SET session_id = ${resolvedSessionId}, updated_at = now()
            WHERE id = ${agentInstanceId}
              AND (session_id IS NULL OR session_id != ${resolvedSessionId})
          `;
        } catch (err) {
          logger.warn(
            { agentInstanceId, sessionId: resolvedSessionId, err: String(err) },
            "router: agent_instances.session_id backfill failed (non-fatal)",
          );
        }
      }

      if (!row.session_id || row.status !== "active") {
        return {
          mode: "disconnected",
          sessionId: row.session_id ?? 0,
          sessionName: row.name as string,
          projectPath: row.path as string,
          agentInstanceId,
        };
      }
      return {
        mode: "cli",
        sessionId: row.session_id as number,
        clientId: row.client_id as string,
        cliConfig: row.cli_config as CliConfig,
        projectPath: row.path as string,
        agentInstanceId,
      };
    }
    // No project mapped to this topic → fall through to DM routing
  }

  // Existing DM routing: look up active session via chat_sessions
  const sessionId = await sessionManager.getActiveSession(chatId);

  if (sessionId === 0) {
    return { mode: "standalone", sessionId: 0 };
  }

  const session = await sessionManager.get(sessionId);

  if (!session) {
    // Session was deleted, reset to standalone
    await sessionManager.switchSession(chatId, 0);
    return { mode: "standalone", sessionId: 0 };
  }

  if (session.status !== "active") {
    return { mode: "disconnected", sessionId, sessionName: session.name, projectPath: session.projectPath };
  }

  return {
    mode: "cli",
    sessionId,
    clientId: session.clientId,
    cliConfig: session.cliConfig as CliConfig,
    projectPath: session.projectPath,
  };
}
