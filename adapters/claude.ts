import { sql } from "../memory/db.ts";
import type { CliAdapter, CliConfig, MessageMeta } from "./types.ts";

/**
 * ClaudeAdapter — wraps the existing message_queue INSERT mechanism.
 * channel.ts (stdio process) picks up messages from the queue and
 * delivers them to Claude Code via MCP notifications/claude/channel.
 * The response path is handled autonomously by channel.ts (passive).
 */
export class ClaudeAdapter implements CliAdapter {
  readonly type = "claude" as const;

  async send(sessionId: number, text: string, meta: MessageMeta): Promise<void> {
    await sql`
      INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
      VALUES (
        ${sessionId},
        ${meta.chatId},
        ${meta.fromUser},
        ${text},
        ${meta.messageId ?? ""}
      )
    `;
  }

  async isAlive(_config: CliConfig): Promise<boolean> {
    // Claude Code is "alive" if channel.ts is connected — i.e., the session is active in DB.
    // The session status check is done in router.ts before calling send().
    // channel.ts manages its own liveness via pg_advisory_lock.
    return true;
  }
}

export const claudeAdapter = new ClaudeAdapter();
