import { sql } from "./db.ts";
import { remember } from "./long-term.ts";
import { getCachedMessages, clearCache, type Message } from "./short-term.ts";
import { summarizeConversation } from "../claude/client.ts";
import { CONFIG } from "../config.ts";

// Idle timers: "sessionId:chatId" -> timeout handle
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function timerKey(sessionId: number, chatId: string): string {
  return `${sessionId}:${chatId}`;
}

/**
 * Reset the idle timer for a session/chat.
 * Called after each new message.
 */
export function touchIdleTimer(sessionId: number, chatId: string, projectPath?: string | null): void {
  const key = timerKey(sessionId, chatId);

  // Clear existing timer
  const existing = idleTimers.get(key);
  if (existing) clearTimeout(existing);

  // Set new timer
  const timer = setTimeout(async () => {
    idleTimers.delete(key);
    await trySummarize(sessionId, chatId, "idle", projectPath);
  }, CONFIG.IDLE_TIMEOUT_MS);

  idleTimers.set(key, timer);
}

/**
 * Check if message count exceeds threshold and summarize if needed.
 */
export async function checkOverflow(
  sessionId: number,
  chatId: string,
  projectPath?: string | null,
): Promise<void> {
  const messages = getCachedMessages(sessionId, chatId);
  if (!messages || messages.length < CONFIG.SHORT_TERM_WINDOW * 2) return;
  await trySummarize(sessionId, chatId, "overflow", projectPath);
}

/**
 * Force summarize current conversation.
 */
export async function forceSummarize(
  sessionId: number,
  chatId: string,
  projectPath?: string | null,
): Promise<string | null> {
  return trySummarize(sessionId, chatId, "manual", projectPath);
}

/**
 * Summarize on session disconnect — saves context before session dies.
 */
export async function summarizeOnDisconnect(
  sessionId: number,
  projectPath?: string | null,
): Promise<void> {
  // Find all chats that have messages for this session
  const chats = await sql`
    SELECT DISTINCT chat_id FROM messages
    WHERE session_id = ${sessionId}
    ORDER BY chat_id
  `;
  for (const row of chats) {
    await trySummarize(sessionId, row.chat_id, "disconnect", projectPath);
  }
}

async function trySummarize(
  sessionId: number,
  chatId: string,
  trigger: "idle" | "overflow" | "manual" | "disconnect",
  projectPath?: string | null,
): Promise<string | null> {
  // Get messages to summarize
  const rows = await sql`
    SELECT role, content FROM messages
    WHERE session_id = ${sessionId} AND chat_id = ${chatId}
    ORDER BY created_at DESC
    LIMIT ${CONFIG.SHORT_TERM_WINDOW * 2}
  `;

  if (rows.length < 4) return null; // Too few messages to summarize

  const messages = rows.reverse().map((r) => ({
    role: r.role as string,
    content: r.content as string,
  }));

  // Resolve project_path if not provided
  if (!projectPath) {
    const sess = await sql`SELECT project_path FROM sessions WHERE id = ${sessionId}`;
    if (sess.length > 0) projectPath = sess[0].project_path;
  }

  try {
    console.log(`[summarizer] summarizing ${messages.length} messages, trigger=${trigger}, project=${projectPath ?? "none"}`);

    const { summary, facts } = await summarizeConversation(messages);

    // Save summary to long-term memory (scoped by project, not session)
    await remember({
      source: "telegram",
      sessionId,
      projectPath,
      chatId,
      type: "summary",
      content: summary,
      tags: [trigger],
    });

    // Save extracted facts
    for (const fact of facts) {
      await remember({
        source: "telegram",
        sessionId,
        projectPath,
        chatId,
        type: "fact",
        content: fact,
      });
    }

    console.log(`[summarizer] saved summary + ${facts.length} facts`);
    return summary;
  } catch (err) {
    console.error("[summarizer] failed:", err);
    return null;
  }
}

/**
 * Stop all idle timers (for graceful shutdown).
 */
export function stopAllTimers(): void {
  for (const timer of idleTimers.values()) {
    clearTimeout(timer);
  }
  idleTimers.clear();
}
