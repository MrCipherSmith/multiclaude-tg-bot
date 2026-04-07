import { sql } from "./db.ts";
import { remember } from "./long-term.ts";
import { getCachedMessages, clearCache, type Message } from "./short-term.ts";
import { summarizeConversation, generateResponse } from "../claude/client.ts";
import { embedSafe } from "./embeddings.ts";
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
    try {
      await trySummarize(sessionId, chatId, "idle", projectPath);
    } catch (err) {
      console.error("[summarizer] idle timer error:", err);
    }
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

    // Archive old messages, keep last SHORT_TERM_WINDOW for continuity
    await sql`
      UPDATE messages SET archived_at = now()
      WHERE session_id = ${sessionId}
        AND chat_id = ${chatId}
        AND archived_at IS NULL
        AND id NOT IN (
          SELECT id FROM messages
          WHERE session_id = ${sessionId} AND chat_id = ${chatId}
          ORDER BY created_at DESC
          LIMIT ${CONFIG.SHORT_TERM_WINDOW}
        )
    `;

    return summary;
  } catch (err) {
    console.error("[summarizer] failed:", err);
    return null;
  }
}

/**
 * Clean up idle timers for sessions that no longer exist.
 */
export async function cleanupStaleTimers(): Promise<void> {
  if (idleTimers.size === 0) return;
  const activeIds = new Set(
    (await sql`SELECT id FROM sessions WHERE status = 'active'`).map((r) => r.id),
  );
  for (const [key, timer] of idleTimers) {
    const sessionId = Number(key.split(":")[0]);
    if (!activeIds.has(sessionId)) {
      clearTimeout(timer);
      idleTimers.delete(key);
    }
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

// --- Work session summarization ---

function buildWorkSessionPrompt(
  messages: { role: string; content: string }[],
  toolCalls: { tool: string; description: string; response: string | null }[],
): string {
  const msgText = messages
    .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
    .join("\n");
  const toolText = toolCalls
    .map((t) => `[${t.tool}] ${t.description}${t.response ? " → " + String(t.response).slice(0, 200) : ""}`)
    .join("\n");

  return `You extract structured knowledge from a Claude Code work session for long-term AI-readable memory.
Output ONLY the sections below that have content. Use exact section headers. No preamble.
Max 2000 tokens. Omit obvious, routine, or trivial information.

[DECISIONS]
<decision_label>: <rationale>

[FILES]
<relative/path>: <change_description> | <reason>

[PROBLEMS]
<problem_description>: <solution_applied>

[PENDING]
<task_or_known_issue>

[CONTEXT]
<non_obvious_constraint_or_fact_future_sessions_must_know>

## Dialogue (user↔assistant)
${msgText}

## Tool Calls
${toolText}`;
}

async function generateWorkSummary(prompt: string): Promise<string> {
  const response = await generateResponse(
    [{ role: "user", content: prompt }],
    "You extract structured knowledge from work sessions. Output only the requested sections.",
  );
  return response.trim();
}

/**
 * Summarize a completed work session: fetches messages + tool calls, generates
 * a structured summary, embeds it, saves to memories, archives messages, and
 * marks the session terminated.
 */
export async function summarizeWork(sessionId: number): Promise<boolean> {
  // 1. Fetch all messages and permission_requests for this session
  const messages = await sql`
    SELECT role, content, created_at FROM messages
    WHERE session_id = ${sessionId}
    ORDER BY created_at ASC
  `;
  const toolCalls = await sql`
    SELECT tool_name, description, response, created_at FROM permission_requests
    WHERE session_id = ${sessionId}
    ORDER BY created_at ASC
  `;

  if (messages.length < 4) {
    console.log(`[summarizer] session #${sessionId}: skipped (too few messages: ${messages.length})`);
    return false;
  }

  // 2. Resolve project_path
  const [sess] = await sql`SELECT project_path FROM sessions WHERE id = ${sessionId}`;
  const projectPath = sess?.project_path ?? null;

  // 3. Build work-session prompt
  const prompt = buildWorkSessionPrompt(
    messages.map((r) => ({ role: r.role as string, content: r.content as string })),
    toolCalls.map((r) => ({
      tool: r.tool_name as string,
      description: r.description as string,
      response: r.response as string | null,
    })),
  );

  // 4. Call Claude API with 30s timeout
  let summary: string;
  try {
    const result = await Promise.race([
      generateWorkSummary(prompt),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 30_000),
      ),
    ]) as string;
    summary = result;
  } catch (err) {
    // Fallback: concatenate raw messages
    console.log(`[summarizer] session #${sessionId}: api error/timeout, using fallback summary`);
    summary = messages
      .map((r) => `${r.role}: ${String(r.content).slice(0, 200)}`)
      .join("\n");
  }

  // 5. Embed
  const embedding = await embedSafe(summary);
  const embeddingStr = embedding ? `[${embedding.join(",")}]` : null;

  // 6-8. Save memory, archive messages/tool calls, and mark session terminated atomically
  try {
    await sql.begin(async (tx) => {
      // 6. Save to memories (type='project_context', session_id=NULL)
      const [mem] = await tx`
        INSERT INTO memories (source, session_id, chat_id, type, content, tags, project_path, embedding)
        VALUES (
          'work_session',
          NULL,
          '',
          'project_context',
          ${summary},
          ${["exit"]},
          ${projectPath},
          ${embeddingStr}::vector
        )
        RETURNING id
      `;

      // 7. Mark messages and permission_requests archived
      await tx`
        UPDATE messages SET archived_at = now()
        WHERE session_id = ${sessionId} AND archived_at IS NULL
      `;
      await tx`
        UPDATE permission_requests SET archived_at = now()
        WHERE session_id = ${sessionId} AND archived_at IS NULL
      `;

      // 8. Set session status = 'terminated'
      await tx`UPDATE sessions SET status = 'terminated', last_active = now() WHERE id = ${sessionId}`;

      console.log(`[summarizer] session #${sessionId}: work summary saved id=${mem?.id}, messages archived`);
    });
  } catch (txErr) {
    // Transaction failed — at minimum, mark session terminated
    console.error(`[summarizer] session #${sessionId}: transaction failed, forcing termination:`, txErr);
    await sql`UPDATE sessions SET status = 'terminated', last_active = now() WHERE id = ${sessionId}`.catch(() => {});
    await sql`UPDATE messages SET archived_at = now() WHERE session_id = ${sessionId} AND archived_at IS NULL`.catch(() => {});
    await sql`UPDATE permission_requests SET archived_at = now() WHERE session_id = ${sessionId} AND archived_at IS NULL`.catch(() => {});
  }

  return true;
}
