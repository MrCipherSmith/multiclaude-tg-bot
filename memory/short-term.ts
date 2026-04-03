import { sql } from "./db.ts";
import { CONFIG } from "../config.ts";

export interface Message {
  id?: number;
  sessionId: number;
  chatId: string;
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

// In-memory cache: "sessionId:chatId" -> Message[]
const cache = new Map<string, Message[]>();

function cacheKey(sessionId: number, chatId: string): string {
  return `${sessionId}:${chatId}`;
}

export async function addMessage(msg: Message): Promise<void> {
  // Write to PostgreSQL
  const [row] = await sql`
    INSERT INTO messages (session_id, chat_id, role, content, metadata)
    VALUES (${msg.sessionId}, ${msg.chatId}, ${msg.role}, ${msg.content}, ${JSON.stringify(msg.metadata ?? {})})
    RETURNING id, created_at
  `;
  msg.id = row.id;
  msg.createdAt = row.created_at;

  // Update cache
  const key = cacheKey(msg.sessionId, msg.chatId);
  const messages = cache.get(key) ?? [];
  messages.push(msg);
  // Keep cache bounded at 2x window to allow summarization of older half
  if (messages.length > CONFIG.SHORT_TERM_WINDOW * 2) {
    messages.splice(0, messages.length - CONFIG.SHORT_TERM_WINDOW * 2);
  }
  cache.set(key, messages);
}

export async function getContext(
  sessionId: number,
  chatId: string,
): Promise<Message[]> {
  const key = cacheKey(sessionId, chatId);

  if (cache.has(key)) {
    const messages = cache.get(key)!;
    return messages.slice(-CONFIG.SHORT_TERM_WINDOW);
  }

  // Load from DB into cache
  const rows = await sql`
    SELECT id, session_id, chat_id, role, content, metadata, created_at
    FROM messages
    WHERE session_id = ${sessionId} AND chat_id = ${chatId}
    ORDER BY created_at DESC
    LIMIT ${CONFIG.SHORT_TERM_WINDOW * 2}
  `;

  const messages: Message[] = rows.reverse().map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    chatId: r.chat_id,
    role: r.role,
    content: r.content,
    metadata: r.metadata,
    createdAt: r.created_at,
  }));

  cache.set(key, messages);
  return messages.slice(-CONFIG.SHORT_TERM_WINDOW);
}

export function getCachedMessages(
  sessionId: number,
  chatId: string,
): Message[] | undefined {
  return cache.get(cacheKey(sessionId, chatId));
}

export function clearCache(sessionId: number, chatId: string): void {
  cache.delete(cacheKey(sessionId, chatId));
}

export function getCacheSize(): number {
  return cache.size;
}
