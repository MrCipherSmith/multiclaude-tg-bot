import { addMessage, getContext, getProjectHistory, getCachedMessages, clearCache, type Message } from "../memory/short-term.ts";
import { sql } from "../memory/db.ts";

export type { Message };

export class MessageService {
  /** Persist a message to DB and in-memory cache. */
  async add(msg: Message): Promise<void> {
    await addMessage(msg);
  }

  /** Get recent messages for a session/chat (respects SHORT_TERM_WINDOW). */
  async getContext(sessionId: number, chatId: string): Promise<Message[]> {
    return getContext(sessionId, chatId);
  }

  /** Get message history across all sessions for a project. */
  async getProjectHistory(projectPath: string, chatId: string, limit?: number): Promise<Message[]> {
    return getProjectHistory(projectPath, chatId, limit);
  }

  /** Get cached messages without DB fallback (returns undefined if not cached). */
  getCached(sessionId: number, chatId: string): Message[] | undefined {
    return getCachedMessages(sessionId, chatId);
  }

  /** Clear in-memory cache for a session/chat. */
  clearCache(sessionId: number, chatId: string): void {
    clearCache(sessionId, chatId);
  }

  /** Queue a message for delivery to a Claude Code session via channel.ts. */
  async queue(params: {
    sessionId: number;
    chatId: string;
    fromUser: string;
    content: string;
    messageId?: string;
    attachments?: unknown;
  }): Promise<void> {
    await sql`
      INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id, attachments)
      VALUES (
        ${params.sessionId},
        ${params.chatId},
        ${params.fromUser},
        ${params.content},
        ${params.messageId ?? ""},
        ${params.attachments ? JSON.stringify(params.attachments) : null}
      )
    `;
  }

  /** Get undelivered queue count for a session. */
  async pendingCount(sessionId: number): Promise<number> {
    const [{ count }] = await sql`
      SELECT count(*)::int FROM message_queue
      WHERE session_id = ${sessionId} AND delivered = false
    ` as { count: number }[];
    return count;
  }
}

export const messageService = new MessageService();
