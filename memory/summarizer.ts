import { sql } from "./db.ts";
import { remember, rememberSmart } from "./long-term.ts";
import { getCachedMessages, clearCache, type Message } from "./short-term.ts";
import { summarizeConversation, generateResponse } from "../llm/client.ts";
import { CONFIG } from "../config.ts";
import { logger } from "../logger.ts";

/**
 * Extract durable project knowledge from session messages and work summary.
 * Saves facts that are true about the project in general, not session-specific events.
 */
export async function extractProjectKnowledge(
  sessionId: number,
  projectPath: string | null,
  workSummary: string,
  messages: { role: string; content: string }[],
): Promise<void> {
  if (!projectPath || messages.length < 4) return;

  const msgSample = messages
    .slice(-30)
    .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
    .join("\n");

  const prompt = `Given this Claude Code session, extract durable project knowledge facts.

Rules:
- Facts must be TRUE about the project in general, not this specific session
- Each fact under 150 characters, one per line, no bullets
- 0-6 facts maximum; return empty if nothing durable to extract
- Skip anything already in the work summary as session-specific

Good facts:
- "Auth uses Bearer token from DASHBOARD_AUTH_TOKEN env var (dashboard/auth.ts)"
- "Port 3847 serves both MCP and dashboard via the same HTTP server"
- "migrations must be append-only — never modify existing SQL"

Bad facts (session-specific — skip these):
- "Fixed voice download bug today"
- "Added react tool to channel.ts in this session"

## Work summary (what happened this session)
${workSummary.slice(0, 1000)}

## Session messages (sample)
${msgSample}`;

  try {
    const response = await generateResponse(
      [{ role: "user", content: prompt }],
      "You extract durable project knowledge. Output only fact lines, one per line. Empty output is valid.",
    );

    const lines = response.split("\n").filter((l) => l.trim().length > 10 && l.trim().length <= 200);
    if (lines.length === 0) return;

    for (const line of lines.slice(0, 6)) {
      await rememberSmart({
        source: "api",
        sessionId: null,
        chatId: "",
        type: "fact",
        content: line.trim(),
        tags: ["project", "learned"],
        projectPath,
      }).catch((err) => logger.error({ err }, "extractProjectKnowledge fact save failed"));
    }

    logger.info({ count: lines.length, projectPath }, "extracted project knowledge facts");
  } catch (err) {
    logger.error({ err }, "extractProjectKnowledge failed");
  }
}

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
      logger.error({ err, sessionId, chatId }, "idle timer error");
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

/** Heuristic: is the message content trivial (chit-chat, acks, noise)? */
function isContentTrivial(messages: { role: string; content: string }[]): boolean {
  const userMsgs = messages.filter((m) => m.role === "user");
  if (userMsgs.length < 2) return true;

  // If average user-message length < 25 chars it's likely pure chit-chat
  const avgLen = userMsgs.reduce((s, m) => s + m.content.trim().length, 0) / userMsgs.length;
  if (avgLen < 25) return true;

  // If fewer than 2 user messages are "substantial" (≥40 chars), skip
  const substantial = userMsgs.filter((m) => m.content.trim().length >= 40);
  if (substantial.length < 2) return true;

  return false;
}

/** Heuristic: reject generated summary if it looks like garbage output */
function isSummaryWorthSaving(summary: string): boolean {
  if (!summary || summary.trim().length < 50) return false;
  const trivialPatterns = [
    /^(ok|yes|no|sure|thanks|hello|hi|bye)/i,
    /nothing (significant|important|notable|relevant|useful)/i,
    /casual conversation/i,
    /no (tasks?|work|code|changes|questions)/i,
  ];
  return !trivialPatterns.some((p) => p.test(summary.trim()));
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

  // Pre-check: skip trivial/chit-chat sessions (avoid polluting long-term memory)
  // Allow "manual" trigger to bypass — user explicitly requested it
  if (trigger !== "manual" && isContentTrivial(messages)) {
    logger.info({ sessionId, chatId, trigger }, "summarize skipped: trivial content");
    return null;
  }

  // Resolve project_path if not provided
  if (!projectPath) {
    const sess = await sql`SELECT project_path FROM sessions WHERE id = ${sessionId}`;
    if (sess.length > 0) projectPath = sess[0].project_path;
  }

  try {
    logger.info({ sessionId, chatId, messageCount: messages.length, trigger, projectPath: projectPath ?? null }, "summarizing");

    const { summary, facts } = await summarizeConversation(messages);

    // Post-check: validate the generated summary before saving
    if (!isSummaryWorthSaving(summary)) {
      logger.info({ sessionId, chatId, trigger }, "summarize skipped: low-quality summary output");
      return null;
    }

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

    // Save extracted facts (filter out trivial/too-short ones)
    const validFacts = facts.filter((f) => f.trim().length >= 30 && f.trim().length <= 300);
    for (const fact of validFacts) {
      await remember({
        source: "telegram",
        sessionId,
        projectPath,
        chatId,
        type: "fact",
        content: fact,
      });
    }

    logger.info({ sessionId, chatId, factCount: validFacts.length, filteredFacts: facts.length - validFacts.length }, "saved summary and facts");

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
    logger.error({ err, sessionId, chatId }, "summarize failed");
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
    logger.info({ sessionId, messageCount: messages.length }, "summarizeWork skipped: too few messages");
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
    logger.warn({ sessionId }, "summarizeWork: api error/timeout, using fallback summary");
    summary = messages
      .map((r) => `${r.role}: ${String(r.content).slice(0, 200)}`)
      .join("\n");
  }

  // 5. Save to memories with smart reconciliation (outside transaction — acceptable)
  let memId: number | undefined;
  try {
    const mem = await rememberSmart({
      source: "api",
      sessionId: null,
      chatId: "",
      type: "project_context",
      content: summary,
      tags: ["exit"],
      projectPath,
    });
    memId = mem.id;
    logger.info({ sessionId, action: mem.action, memoryId: mem.id }, "project_context saved");
  } catch (memErr) {
    logger.error({ err: memErr, sessionId }, "failed to save memory");
  }

  // 5b. Extract durable project knowledge (non-blocking, best-effort)
  extractProjectKnowledge(
    sessionId,
    projectPath,
    summary,
    messages.map((r) => ({ role: r.role as string, content: r.content as string })),
  ).catch((err) => logger.error({ err, sessionId }, "extractProjectKnowledge error"));

  // 6-8. Archive messages/tool calls and mark session terminated atomically
  try {
    await sql.begin(async (tx) => {
      // 6. Mark messages and permission_requests archived
      await tx`
        UPDATE messages SET archived_at = now()
        WHERE session_id = ${sessionId} AND archived_at IS NULL
      `;
      await tx`
        UPDATE permission_requests SET archived_at = now()
        WHERE session_id = ${sessionId} AND archived_at IS NULL
      `;

      // 7. Set session status = 'terminated'
      await tx`UPDATE sessions SET status = 'terminated', last_active = now() WHERE id = ${sessionId}`;

      logger.info({ sessionId, memoryId: memId }, "messages archived, session terminated");
    });
  } catch (txErr) {
    // Transaction failed — at minimum, mark session terminated
    logger.error({ err: txErr, sessionId }, "transaction failed, forcing termination");
    await sql`UPDATE sessions SET status = 'terminated', last_active = now() WHERE id = ${sessionId}`.catch(() => {});
    await sql`UPDATE messages SET archived_at = now() WHERE session_id = ${sessionId} AND archived_at IS NULL`.catch(() => {});
    await sql`UPDATE permission_requests SET archived_at = now() WHERE session_id = ${sessionId} AND archived_at IS NULL`.catch(() => {});
  }

  return true;
}

/**
 * Extract project facts from a Claude Code transcript file (.jsonl).
 * Called by the Stop hook at session end.
 * Parses the transcript, extracts assistant/user turns, and saves durable facts.
 */
export async function extractFactsFromTranscript(
  transcriptPath: string,
  projectPath: string,
): Promise<number> {
  const { readFileSync, existsSync } = await import("fs");

  if (!existsSync(transcriptPath)) {
    logger.warn({ transcriptPath }, "extractFactsFromTranscript: file not found");
    return 0;
  }

  // Parse JSONL transcript — extract user/assistant turns
  const lines = readFileSync(transcriptPath, "utf-8").split("\n").filter(Boolean);
  const turns: { role: string; content: string }[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const type = entry.type;
      if (type !== "user" && type !== "assistant") continue;

      const msg = entry.message ?? {};
      const content = msg.content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text ?? "")
          .join("\n");
      }
      if (text.trim().length > 10) {
        turns.push({ role: type, content: text.trim() });
      }
    } catch {
      // skip malformed lines
    }
  }

  if (turns.length < 4) {
    logger.info({ transcriptPath, turns: turns.length }, "extractFactsFromTranscript: too few turns");
    return 0;
  }

  // Call extractProjectKnowledge with the transcript turns
  const workSummary = turns
    .slice(-10)
    .map((t) => `${t.role}: ${t.content.slice(0, 200)}`)
    .join("\n");

  await extractProjectKnowledge(0, projectPath, workSummary, turns.slice(-40));
  logger.info({ transcriptPath, projectPath, turns: turns.length }, "extractFactsFromTranscript: done");
  return turns.length;
}
