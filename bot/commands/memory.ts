import type { Context } from "grammy";
import { rememberSmart, recall, forget, listMemories } from "../../memory/long-term.ts";
import { clearCache } from "../../memory/short-term.ts";
import { forceSummarize } from "../../memory/summarizer.ts";
import { sessionManager } from "../../sessions/manager.ts";
import { sql } from "../../memory/db.ts";
import { setPendingInput } from "../handlers.ts";

export async function handleRemember(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const content = text.replace(/^\/remember\s*/, "").trim();
  const chatId = String(ctx.chat!.id);
  const activeSessionId = await sessionManager.getActiveSession(chatId);

  if (!content) {
    await ctx.reply("What to remember?");
    setPendingInput(chatId, async (replyCtx) => {
      const input = replyCtx.message?.text?.trim();
      if (!input) return;
      const session = await sessionManager.get(activeSessionId);
      const result = await rememberSmart({ source: "telegram", sessionId: activeSessionId, projectPath: session?.projectPath, chatId, type: "note", content: input });
      const label = result.action === "added" ? `Saved (#${result.id})` : result.action === "updated" ? `Updated #${result.id}` : `Already known (#${result.id})`;
      await replyCtx.reply(`${label}: ${result.content.slice(0, 100)}${result.content.length > 100 ? "..." : ""}`);
    });
    return;
  }

  const session = await sessionManager.get(activeSessionId);
  const result = await rememberSmart({
    source: "telegram",
    sessionId: activeSessionId,
    projectPath: session?.projectPath,
    chatId,
    type: "note",
    content,
  });

  const label = result.action === "added" ? `Saved (#${result.id})` : result.action === "updated" ? `Updated #${result.id}` : `Already known (#${result.id})`;
  await ctx.reply(`${label}: ${result.content.slice(0, 100)}${result.content.length > 100 ? "..." : ""}`);
}

export async function handleRecall(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const query = text.replace(/^\/recall\s*/, "").trim();
  const chatId = String(ctx.chat!.id);
  const activeSessionId = await sessionManager.getActiveSession(chatId);
  const session = await sessionManager.get(activeSessionId);
  const projectPath = session?.projectPath ?? null;

  if (!query) {
    await ctx.reply("What to search?");
    setPendingInput(chatId, async (replyCtx) => {
      const input = replyCtx.message?.text?.trim();
      if (!input) return;
      const results = await recall(input, { limit: 5, projectPath });
      if (results.length === 0) { await replyCtx.reply("Nothing found."); return; }
      const lines = results.map((r) => `#${r.id} [${r.type}] ${r.content.slice(0, 120)}${r.content.length > 120 ? "..." : ""}`);
      await replyCtx.reply("Found:\n\n" + lines.join("\n\n"));
    });
    return;
  }

  const results = await recall(query, { limit: 5, projectPath });

  if (results.length === 0) {
    await ctx.reply("Nothing found.");
    return;
  }

  const lines = results.map((r) => {
    return `#${r.id} [${r.type}] ${r.content.slice(0, 120)}${r.content.length > 120 ? "..." : ""}`;
  });

  await ctx.reply("Found:\n\n" + lines.join("\n\n"));
}

export async function handleMemories(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const activeSessionId = await sessionManager.getActiveSession(chatId);
  const session = await sessionManager.get(activeSessionId);
  const projectPath = session?.projectPath ?? null;
  const mems = await listMemories({ projectPath, limit: 10 });

  if (mems.length === 0) {
    // Also check global memories
    const globalMems = await listMemories({ limit: 10 });
    if (globalMems.length === 0) {
      await ctx.reply("Memory is empty.");
      return;
    }
    const lines = globalMems.map(
      (m) => `#${m.id} [${m.type}] s:${m.sessionId ?? "global"} ${m.content.slice(0, 70)}${m.content.length > 70 ? "..." : ""}`,
    );
    await ctx.reply("Memories (all sessions):\n\n" + lines.join("\n"));
    return;
  }

  const lines = mems.map(
    (m) => `#${m.id} [${m.type}] ${m.content.slice(0, 80)}${m.content.length > 80 ? "..." : ""}`,
  );

  await ctx.reply(`Memories (${session?.name ?? "global"}):\n\n` + lines.join("\n"));
}

export async function handleForget(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const idStr = text.replace(/^\/forget\s*/, "").trim();

  if (!idStr || isNaN(Number(idStr))) {
    await ctx.reply("Enter memory ID:");
    const chatId = String(ctx.chat!.id);
    setPendingInput(chatId, async (replyCtx) => {
      const id = Number(replyCtx.message?.text?.trim());
      if (isNaN(id)) { await replyCtx.reply("Invalid ID."); return; }
      const deleted = await forget(id);
      await replyCtx.reply(deleted ? `Deleted #${id}` : `#${id} not found`);
    });
    return;
  }

  const deleted = await forget(Number(idStr));
  await ctx.reply(deleted ? `Deleted #${idStr}` : `#${idStr} not found`);
}

export async function handleSummarize(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const sessionId = await sessionManager.getActiveSession(chatId);
  const session = await sessionManager.get(sessionId);

  await ctx.reply("Summarizing...");
  const summary = await forceSummarize(sessionId, chatId, session?.projectPath);

  if (summary) {
    await ctx.reply(`Saved to long-term memory:\n\n${summary}`);
  } else {
    await ctx.reply("Not enough messages to summarize.");
  }
}

export async function handleClear(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const sessionId = await sessionManager.getActiveSession(chatId);

  clearCache(sessionId, chatId);
  await sql`DELETE FROM messages WHERE session_id = ${sessionId} AND chat_id = ${chatId}`;

  await ctx.reply("Context cleared.");
}
