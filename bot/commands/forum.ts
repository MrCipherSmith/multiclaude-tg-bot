/**
 * Forum topic management commands.
 *
 * FR-1:  /forum_setup   — configure forum, create topics for all projects
 * FR-7:  /forum_sync    — re-sync topics (create missing)
 * FR-7:  /topic_rename  — rename current project topic
 * FR-7:  /topic_close   — close current project topic
 * FR-7:  /topic_reopen  — reopen current project topic
 */

import type { Context } from "grammy";
import { forumService } from "../../services/forum-service.ts";
import { replyInThread } from "../format.ts";
import { invalidateForumCache } from "../forum-cache.ts";
import { logger } from "../../logger.ts";

// --- /forum_setup ---

export async function handleForumSetup(ctx: Context): Promise<void> {
  const chat = ctx.chat;
  if (!chat) return;

  // Must be run in a supergroup
  if (chat.type !== "supergroup") {
    await ctx.reply("⚠️ Run this command in the forum supergroup.");
    return;
  }

  // Check is_forum flag
  if (!(chat as any).is_forum) {
    await ctx.reply("⚠️ This supergroup does not have Topics enabled.\n\nEnable Topics in group Settings → Group type → Topics.");
    return;
  }

  const chatId = String(chat.id);

  // Attempt setup — createForumTopic will fail if bot lacks can_manage_topics
  let result: { topicsCreated: number; errors: string[] };
  try {
    result = await forumService.setup(ctx.api, chatId);
  } catch (err: any) {
    logger.error({ err }, "forum_setup failed");
    const msg = err?.message ?? String(err);
    if (msg.includes("not enough rights") || msg.includes("MANAGE_TOPICS")) {
      await ctx.reply(
        "⚠️ Bot lacks <b>Manage Topics</b> permission.\n\nPromote the bot to admin and enable <i>Manage Topics</i>, then try again.",
        { parse_mode: "HTML" },
      );
    } else {
      await ctx.reply(`❌ Setup failed: ${msg}`);
    }
    return;
  }

  invalidateForumCache();

  const errorPart = result.errors.length > 0
    ? `\n\n⚠️ Errors:\n${result.errors.map((e) => `• ${e}`).join("\n")}`
    : "";

  await replyInThread(ctx, `✅ Forum configured. ${result.topicsCreated} topic(s) created.${errorPart}`);
}

// --- /forum_sync ---

export async function handleForumSync(ctx: Context): Promise<void> {
  const forumChatId = await forumService.getForumChatId();
  if (!forumChatId) {
    await replyInThread(ctx, "⚠️ Forum not configured. Run /forum_setup first.");
    return;
  }

  let result: { created: number; closed: number; errors: string[] };
  try {
    result = await forumService.sync(ctx.api, forumChatId);
  } catch (err: any) {
    logger.error({ err }, "forum_sync failed");
    await replyInThread(ctx, `❌ Sync failed: ${err?.message ?? String(err)}`);
    return;
  }

  const errorPart = result.errors.length > 0
    ? `\n⚠️ Errors:\n${result.errors.map((e) => `• ${e}`).join("\n")}`
    : "";

  await replyInThread(ctx, `✅ Sync complete. Created: ${result.created}${errorPart}`);
}

// --- /topic_rename <name> ---

export async function handleTopicRename(ctx: Context): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId || threadId === 1) {
    await ctx.reply("⚠️ Run this command from within a project topic.");
    return;
  }

  const text = ctx.message?.text ?? "";
  const newName = text.replace(/^\/topic_rename\s+/, "").trim();
  if (!newName) {
    await replyInThread(ctx, "Usage: /topic_rename <new name>");
    return;
  }

  const chatId = ctx.chat!.id;
  try {
    await ctx.api.editForumTopic(chatId, threadId, { name: newName });
    await replyInThread(ctx, `✅ Topic renamed to "${newName}".`);
  } catch (err: any) {
    await replyInThread(ctx, `❌ Failed: ${err?.message ?? String(err)}`);
  }
}

// --- /topic_close ---

export async function handleTopicClose(ctx: Context): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId || threadId === 1) {
    await ctx.reply("⚠️ Run this command from within a project topic.");
    return;
  }

  const chatId = ctx.chat!.id;
  try {
    await ctx.api.closeForumTopic(chatId, threadId);
    await replyInThread(ctx, "🔒 Topic closed.");
  } catch (err: any) {
    await replyInThread(ctx, `❌ Failed: ${err?.message ?? String(err)}`);
  }
}

// --- /topic_reopen ---

export async function handleTopicReopen(ctx: Context): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId || threadId === 1) {
    await ctx.reply("⚠️ Run this command from within a project topic.");
    return;
  }

  const chatId = ctx.chat!.id;
  try {
    await ctx.api.reopenForumTopic(chatId, threadId);
    await replyInThread(ctx, "🔓 Topic reopened.");
  } catch (err: any) {
    await replyInThread(ctx, `❌ Failed: ${err?.message ?? String(err)}`);
  }
}
