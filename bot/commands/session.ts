import type { Context } from "grammy";
import { sessionManager } from "../../sessions/manager.ts";
import { deleteSessionCascade } from "../../sessions/delete.ts";
import { sql } from "../../memory/db.ts";
import { setPendingInput } from "../handlers.ts";

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
    const status =
      s.id === 0
        ? ""
        : s.status === "active"
          ? ` (active)`
          : ` (disconnected)`;
    const name = s.name ?? s.clientId;
    const badge = s.id === 0 ? "" : ` [${s.cliType ?? "claude"}]`;
    return `${s.id}. ${name}${badge}${status}${marker}`;
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
      const status = s.id === 0 ? "" : s.status === "active" ? " (active)" : " (disconnected)";
      return `${s.id}. ${s.name ?? s.clientId}${status}${marker}`;
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

export async function handleSwitchTo(ctx: Context, sessionId: number): Promise<void> {
  const session = await sessionManager.get(sessionId);

  if (!session) {
    await ctx.reply("Session not found.");
    return;
  }

  const chatId = String(ctx.chat!.id);
  await sessionManager.switchSession(chatId, sessionId);

  if (sessionId === 0) {
    await ctx.reply("Switched to *standalone* mode\\.", {
      parse_mode: "MarkdownV2",
    });
  } else {
    const name = session.name ?? session.clientId;
    const statusIcon = session.status === "active" ? "🟢" : "🔴";

    // Get last 5 messages (full content, up to 300 chars each)
    const recentMsgs = await sql`
      SELECT role, LEFT(content, 300) as content FROM messages
      WHERE session_id = ${sessionId} AND chat_id = ${chatId}
      ORDER BY created_at DESC LIMIT 5
    `;

    // Check pending queue messages
    const pending = await sql`
      SELECT count(*)::int as cnt FROM message_queue
      WHERE session_id = ${sessionId} AND delivered = false
    `;
    const pendingCount = pending[0]?.cnt ?? 0;

    let context = "";
    if (recentMsgs.length > 0) {
      const preview = recentMsgs.reverse().map((m) => {
        const icon = m.role === "user" ? "👤" : "🤖";
        const text = m.content.trim();
        return `${icon} ${text}${text.length >= 300 ? "..." : ""}`;
      }).join("\n\n");
      context = `\n\nRecent messages:\n${preview}`;
    }

    const pendingText = pendingCount > 0 ? `\n\n⏳ In queue: ${pendingCount} messages` : "";
    const path = session.projectPath ? `\n📁 ${session.projectPath}` : "";
    await ctx.reply(`${statusIcon} Switched to: ${name}${path}${pendingText}${context}`);
  }
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
    `Session: ${session.name ?? session.clientId}`,
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

  await ctx.reply(`Deleted session #${sessionId} (${session.name ?? "unnamed"}) with all data.`);
}

async function cleanupSession(id: number): Promise<void> {
  await deleteSessionCascade(id);
}

export async function handleCleanup(ctx: Context): Promise<void> {
  // Find sessions to remove
  const toRemove = await sql`
    SELECT id, name, status FROM sessions
    WHERE id != 0 AND (name LIKE 'cli-%' OR status = 'disconnected')
  `;

  if (toRemove.length === 0) {
    await ctx.reply("Nothing to clean up.");
    return;
  }

  for (const row of toRemove) {
    await cleanupSession(row.id);
  }

  const names = toRemove.filter((r) => !r.name.startsWith("cli-")).map((r) => r.name);
  const cliCount = toRemove.filter((r) => r.name.startsWith("cli-")).length;
  const parts: string[] = [];
  if (names.length > 0) parts.push(names.join(", "));
  if (cliCount > 0) parts.push(`${cliCount} unnamed`);

  await ctx.reply(`Cleaned up ${toRemove.length}: ${parts.join(", ")}`);
}
