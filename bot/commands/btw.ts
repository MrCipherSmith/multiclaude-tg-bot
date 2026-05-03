/**
 * /btw — ask Claude Code "what are you doing right now?" using the /btw overlay.
 *
 * In a forum topic: queries the project mapped to that topic.
 * In a DM:         queries the user's active session project.
 *
 * The host-side admin-daemon opens the /btw overlay, captures the response,
 * then dismisses it with ESC so Claude continues its main task uninterrupted.
 */

import type { Context } from "grammy";
import { sql } from "../../memory/db.ts";
import { sessionManager } from "../../sessions/manager.ts";
import { getForumChatId } from "../forum-cache.ts";

const DEFAULT_QUESTION = "Что сейчас делаешь? Кратко опиши прогресс.";
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 40_000;

export async function handleBtw(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const threadId = ctx.message?.message_thread_id;
  const forumChatId = await getForumChatId();
  const isForumGroup = forumChatId !== null && chatId === forumChatId && !!threadId;
  const isForumTopic = isForumGroup && threadId > 1;

  let project: string | null = null;

  if (isForumTopic) {
    const rows = await sql`
      SELECT name FROM projects WHERE forum_topic_id = ${threadId} LIMIT 1
    `;
    project = rows[0]?.name as string ?? null;
    if (!project) {
      await ctx.reply("No project mapped to this topic.");
      return;
    }
  } else {
    const sessionId = await sessionManager.getActiveSession(chatId);
    const session = sessionId ? await sessionManager.get(sessionId) : null;
    project = session?.project ?? null;
    if (!project) {
      await ctx.reply("No active session.");
      return;
    }
  }

  const question = (ctx.match as string | undefined)?.trim() || DEFAULT_QUESTION;

  const [row] = await sql`
    INSERT INTO admin_commands (command, payload)
    VALUES ('tmux_send_keys', ${sql.json({ project, action: "btw", question })})
    RETURNING id
  `;
  const cmdId = row.id as bigint;

  const sent = await ctx.reply("⏳ Спрашиваю Claude...");

  // Poll for result
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let answer: string | null = null;

  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
    const rows = await sql`
      SELECT status, result FROM admin_commands WHERE id = ${cmdId}
    `;
    const r = rows[0];
    if (!r) break;
    if (r.status === "done" || r.status === "error") {
      answer = r.status === "done" ? String(r.result ?? "") : null;
      break;
    }
  }

  const text = answer
    ? `💬 <b>${project}</b>:\n\n${answer}`
    : "❌ Нет ответа (таймаут или сессия не активна).";

  await ctx.api.editMessageText(
    chatId,
    sent.message_id,
    text,
    { parse_mode: "HTML", ...(isForumTopic ? { message_thread_id: threadId } : {}) },
  ).catch(() => ctx.reply(text, { parse_mode: "HTML" }));
}
