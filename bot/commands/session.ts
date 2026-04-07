import type { Context } from "grammy";
import { sessionManager, sessionDisplayName } from "../../sessions/manager.ts";
import { deleteSessionCascade } from "../../sessions/delete.ts";
import { sql } from "../../memory/db.ts";
import { setPendingInput } from "../handlers.ts";
import { setSwitchContext, clearSwitchContext } from "../switch-cache.ts";

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
      else status = " ⚪ inactive"; // disconnected or unknown
    }
    const display = sessionDisplayName(s);
    return `${s.id}. ${display}${status}${marker}`;
  });

  await ctx.reply(
    "Sessions:\n" + lines.join("\n") + "\n\n/switch <id> to switch",
  );
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
      const formattedBriefing = formatBriefing(mem.content);
      await ctx.reply(`📋 *Context: ${session.project ?? sessionDisplayName(session)}*\n\n${formattedBriefing}`, {
        parse_mode: "Markdown",
      });
      setSwitchContext(chatId, {
        summary: mem.content,
        sessionId: targetSessionId,
        projectPath: session.projectPath,
        loadedAt: new Date(),
      });
      console.log(`[switch] session #${currentId} → #${targetSessionId}: briefing loaded from memories`);
    } else {
      console.log(`[switch] session #${currentId} → #${targetSessionId}: no briefing available`);
      clearSwitchContext(chatId);
    }
  }

  await sessionManager.switchSession(chatId, targetSessionId);
  await ctx.reply(`Switched to ${sessionDisplayName(session)}.`);
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

  await sql`UPDATE sessions SET name = ${newName} WHERE id = ${sessionId}`;
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
  // Find sessions to remove (exclude remote sessions — they are managed by channel.ts)
  const toRemove = await sql`
    SELECT id, name, project, source FROM sessions
    WHERE id != 0
      AND source != 'remote'
      AND (name LIKE 'cli-%' OR status IN ('disconnected', 'terminated'))
  `;

  if (toRemove.length === 0) {
    await ctx.reply("Nothing to clean up.");
    return;
  }

  for (const row of toRemove) {
    await cleanupSession(row.id);
  }

  const named = toRemove.filter((r) => r.project || (r.name && !r.name.startsWith("cli-")));
  const cliCount = toRemove.length - named.length;
  const parts: string[] = [];
  if (named.length > 0) parts.push(named.map((r) => r.project ? `${r.project} · ${r.source}` : r.name).join(", "));
  if (cliCount > 0) parts.push(`${cliCount} unnamed`);

  await ctx.reply(`Cleaned up ${toRemove.length}: ${parts.join(", ")}`);
}
