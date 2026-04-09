import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sessionManager, sessionDisplayName } from "../../sessions/manager.ts";
import { deleteSessionCascade } from "../../sessions/delete.ts";
import { sql } from "../../memory/db.ts";
import { setPendingInput } from "../handlers.ts";
import { setSwitchContext, clearSwitchContext } from "../switch-cache.ts";
import { logger } from "../../logger.ts";
import { sessionService } from "../../services/session-service.ts";
import { runAllCleanupJobs } from "../../cleanup/jobs.ts";

export async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(
    "Hi! I'm Claude bot with memory.\n\n" +
      "Commands:\n" +
      "/sessions — list sessions\n" +
      "/switch <id> — switch session\n" +
      "/standalone — standalone mode\n" +
      "/session — current session\n" +
      "/remember <text> — save to memory\n" +
      "/recall <query> — search memory\n" +
      "/memories — list memories\n" +
      "/forget <id> — delete memory\n" +
      "/clear — clear context\n" +
      "/status — bot status\n" +
      "/stats — statistics\n" +
      "/logs [id] — session logs\n" +
      "/pending — pending permissions\n" +
      "/tools — MCP tools\n" +
      "/skills — skills from goodai-base\n" +
      "/rules — rules from goodai-base\n" +
      "/remote_control — tmux status & control\n" +
      "/projects — manage projects\n" +
      "/project_add — add a project\n" +
      "/help — help",
  );
}

export async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(
    "I work in two modes:\n\n" +
      "*Standalone* — I respond via Claude API\n" +
      "*CLI session* — I forward messages to Claude Code\n\n" +
      "Memory:\n" +
      "• Short\\-term: last 20 messages\n" +
      "• Long\\-term: semantic search through history\n\n" +
      "Sessions: /sessions, /switch, /session\n" +
      "Memory: /remember, /recall, /memories, /forget\n" +
      "Utilities: /clear, /status",
    { parse_mode: "MarkdownV2" },
  );
}

export async function handleSessions(ctx: Context): Promise<void> {
  const sessions = await sessionManager.list();
  const chatId = String(ctx.chat!.id);
  const activeId = await sessionManager.getActiveSession(chatId);

  const lines = sessions.map((s) => {
    const marker = s.id === activeId ? " ✓" : "";
    let status = "";
    if (s.id !== 0) {
      if (s.status === "active") status = " 🟢 active";
      else if (s.status === "terminated") status = " 💀 terminated";
      else if (s.status === "inactive") status = " ⚪ inactive";
      else status = " ⚪ inactive";
    }
    const display = sessionDisplayName(s);
    return `${s.id}. ${display}${status}${marker}`;
  });

  const localSessions = sessions.filter((s) => s.source === "local" && s.id !== 0 && s.status !== "active");
  const kb = new InlineKeyboard();
  for (const s of localSessions) {
    const label = `🗑 Delete #${s.id} ${sessionDisplayName(s)} (${s.status})`;
    kb.text(label, `sess:delete:${s.id}`).row();
  }

  await ctx.reply(
    "Sessions:\n" + lines.join("\n") + "\n\n/switch <id> to switch",
    localSessions.length > 0 ? { reply_markup: kb } : undefined,
  );
}

export async function handleDeleteSession(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const sessionId = Number(data.split(":")[2]);
  if (!sessionId) { await ctx.answerCallbackQuery({ text: "Invalid" }); return; }

  const session = await sessionManager.get(sessionId);
  if (!session || session.source !== "local") {
    await ctx.answerCallbackQuery({ text: "Session not found or not local" });
    return;
  }
  if (session.status === "active") {
    await ctx.answerCallbackQuery({ text: "Cannot delete active session" });
    return;
  }

  await deleteSessionCascade(sessionId);
  await ctx.answerCallbackQuery({ text: `Deleted session #${sessionId}` });
  await ctx.deleteMessage().catch(() => {});
  await handleSessions(ctx);
}

export async function handleSwitch(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const parts = text.split(/\s+/);
  const idStr = parts[1];

  if (!idStr) {
    const sessions = await sessionManager.list();
    const chatId = String(ctx.chat!.id);
    const activeId = await sessionManager.getActiveSession(chatId);
    const lines = sessions.map((s) => {
      const marker = s.id === activeId ? " ✓" : "";
      let status = "";
      if (s.id !== 0) {
        if (s.status === "active") status = " 🟢 active";
        else if (s.status === "terminated") status = " 💀 terminated";
        else if (s.status === "inactive") status = " ⚪ inactive";
        else status = " ⚪ inactive"; // disconnected or unknown
      }
      return `${s.id}. ${sessionDisplayName(s)}${status}${marker}`;
    });
    await ctx.reply("Enter session ID:\n\n" + lines.join("\n"));
    setPendingInput(chatId, async (replyCtx) => {
      const id = Number(replyCtx.message?.text?.trim());
      if (isNaN(id)) {
        await replyCtx.reply("Invalid ID.");
        return;
      }
      await handleSwitchTo(replyCtx, id);
    });
    return;
  }

  const sessionId = Number(idStr);
  await handleSwitchTo(ctx, sessionId);
}

function formatBriefing(raw: string): string {
  return raw
    .replace(/\[DECISIONS\]/g, "**Key Decisions:**")
    .replace(/\[FILES\]/g, "**Files Changed:**")
    .replace(/\[PROBLEMS\]/g, "**Problems Solved:**")
    .replace(/\[PENDING\]/g, "**Pending:**")
    .replace(/\[CONTEXT\]/g, "**Context:**");
}

export async function doSwitch(ctx: Context, targetSessionId: number): Promise<void> {
  const session = await sessionManager.get(targetSessionId);

  if (!session) {
    await ctx.reply("Session not found.");
    return;
  }

  const chatId = String(ctx.chat!.id);
  const currentId = await sessionManager.getActiveSession(chatId);

  // Switch first — always happens regardless of briefing errors
  await sessionManager.switchSession(chatId, targetSessionId);
  await ctx.reply(`Switched to ${sessionDisplayName(session)}.`);

  // Send briefing after switch (non-critical, errors don't affect the switch)
  if (session.projectPath) {
    const [mem] = await sql`
      SELECT content FROM memories
      WHERE project_path = ${session.projectPath}
        AND type IN ('project_context', 'summary')
        AND embedding IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (mem) {
      setSwitchContext(chatId, {
        summary: mem.content,
        sessionId: targetSessionId,
        projectPath: session.projectPath,
        loadedAt: new Date(),
      });
      logger.info({ from: currentId, to: targetSessionId }, "switch: briefing loaded from memories");
      try {
        const formattedBriefing = formatBriefing(mem.content);
        await ctx.reply(`📋 *Context: ${session.project ?? sessionDisplayName(session)}*\n\n${formattedBriefing}`, {
          parse_mode: "Markdown",
        });
      } catch {
        // Markdown parse error — send as plain text
        await ctx.reply(`📋 Context: ${session.project ?? sessionDisplayName(session)}\n\n${mem.content}`);
      }
    } else {
      logger.info({ from: currentId, to: targetSessionId }, "switch: no briefing available");
      clearSwitchContext(chatId);
    }
  }
}

export async function handleSwitchTo(ctx: Context, sessionId: number): Promise<void> {
  await doSwitch(ctx, sessionId);
}

export async function handleRename(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const match = text.match(/^\/rename\s+(\d+)\s+(.+)$/);

  if (!match) {
    await ctx.reply("Format: /rename <id> <name>\nExample: /rename 3 keryx");
    return;
  }

  const sessionId = Number(match[1]);
  const newName = match[2].trim();
  const session = await sessionManager.get(sessionId);

  if (!session) {
    await ctx.reply("Session not found.");
    return;
  }

  await sessionService.rename(sessionId, newName);
  await ctx.reply(`Session #${sessionId} renamed to "${newName}"`);
}

export async function handleSessionInfo(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const activeId = await sessionManager.getActiveSession(chatId);
  const session = await sessionManager.get(activeId);

  if (!session) {
    await ctx.reply("Current session: standalone (default)");
    return;
  }

  const ago = Math.round(
    (Date.now() - new Date(session.lastActive).getTime()) / 1000,
  );
  const agoStr =
    ago < 60
      ? `${ago}s`
      : ago < 3600
        ? `${Math.floor(ago / 60)}m`
        : `${Math.floor(ago / 3600)}h`;

  const lines = [
    `Session: ${sessionDisplayName(session)}`,
    `ID: ${session.id}`,
    `Status: ${session.status}`,
    session.projectPath ? `Path: ${session.projectPath}` : null,
    `Activity: ${agoStr} ago`,
  ].filter(Boolean);

  await ctx.reply(lines.join("\n"));
}

export async function handleRemove(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const idStr = text.replace(/^\/remove\s*/, "").trim();

  if (!idStr || isNaN(Number(idStr))) {
    await ctx.reply("Format: /remove <id>\nExample: /remove 399");
    return;
  }

  const sessionId = Number(idStr);
  if (sessionId === 0) {
    await ctx.reply("Cannot delete standalone session.");
    return;
  }

  const session = await sessionManager.get(sessionId);
  if (!session) {
    await ctx.reply("Session not found.");
    return;
  }

  await deleteSessionCascade(sessionId);

  await ctx.reply(`Deleted session #${sessionId} (${sessionDisplayName(session)}) with all data.`);
}

async function cleanupSession(id: number): Promise<void> {
  await deleteSessionCascade(id);
}

export async function handleCleanup(ctx: Context): Promise<void> {
  // Run structured cleanup jobs (message queue, logs, archived messages, memory TTL, orphan sessions)
  const results = await runAllCleanupJobs(false);
  const total = results.reduce((sum, r) => sum + r.rowsAffected, 0);

  if (total === 0) {
    await ctx.reply("Nothing to clean up.");
    return;
  }

  const lines = results
    .filter((r) => r.rowsAffected > 0)
    .map((r) => `  • ${r.job}: ${r.rowsAffected}`);
  await ctx.reply(`Cleaned up ${total} rows:\n${lines.join("\n")}`);
}
