/**
 * /interrupt — send Escape to the Claude session bound to the current context.
 *
 * In a forum topic: interrupts the project mapped to that topic.
 * In a DM:         interrupts the user's active session.
 *
 * Never shows a session picker or switches sessions.
 */

import type { Context } from "grammy";
import { sql } from "../../memory/db.ts";
import { sessionManager } from "../../sessions/manager.ts";
import { getForumChatId } from "../forum-cache.ts";

export async function handleInterrupt(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const threadId = ctx.message?.message_thread_id ?? (ctx.callbackQuery?.message as any)?.message_thread_id;
  const forumChatId = await getForumChatId();
  const isForumTopic = forumChatId !== null && chatId === forumChatId && !!threadId && threadId > 1;

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
      await ctx.reply("No active session to interrupt.");
      return;
    }
  }

  await sql`
    INSERT INTO admin_commands (command, payload)
    VALUES ('tmux_send_keys', ${sql.json({ project, action: "esc" })})
  `;
  await ctx.reply(`⚡ Interrupt sent to <b>${project}</b>.`, { parse_mode: "HTML" });
}
