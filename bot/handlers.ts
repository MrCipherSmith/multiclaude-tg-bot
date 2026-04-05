import type { Bot, Context } from "grammy";
import { composePrompt } from "../claude/prompt.ts";
import { getProviderInfo, type ContentBlock } from "../claude/client.ts";
import { addMessage, getContext, clearCache } from "../memory/short-term.ts";
import { remember, recall, forget, listMemories } from "../memory/long-term.ts";
import { streamToTelegram } from "./streaming.ts";
import { routeMessage } from "../sessions/router.ts";
import { sessionManager } from "../sessions/manager.ts";
import { sendNotificationToSession } from "../mcp/bridge.ts";
import { downloadFile, toHostPath } from "../utils/files.ts";
import { startTyping, type TypingHandle } from "../utils/typing.ts";
import { transcribe } from "../utils/transcribe.ts";
import { touchIdleTimer, checkOverflow, forceSummarize } from "../memory/summarizer.ts";
import { sql } from "../memory/db.ts";
import { getApiStats, getTranscriptionStats, getMessageStats, getSessionLogs, getRecentLogs, appendLog } from "../utils/stats.ts";

// Pending input: chatId -> handler that processes the next text message
const pendingInput = new Map<string, (ctx: Context) => Promise<void>>();

export function registerHandlers(bot: Bot): void {
  // Session commands
  bot.command("sessions", handleSessions);
  bot.command("switch", handleSwitch);
  bot.command("standalone", (ctx) => handleSwitchTo(ctx, 0));
  bot.command("session", handleSessionInfo);
  bot.command("rename", handleRename);
  bot.command("start", handleStart);
  bot.command("help", handleHelp);

  // Memory commands
  bot.command("remember", handleRemember);
  bot.command("recall", handleRecall);
  bot.command("memories", handleMemories);
  bot.command("forget", handleForget);

  // Utility commands
  bot.command("clear", handleClear);
  bot.command("remove", handleRemove);
  bot.command("cleanup", handleCleanup);
  bot.command("summarize", handleSummarize);
  bot.command("status", handleStatus);
  bot.command("stats", handleStats);
  bot.command("logs", handleLogs);
  bot.command("pending", handlePending);
  bot.command("tools", handleTools);
  bot.command("skills", handleSkills);
  bot.command("rules", handleRules);

  // Inline keyboard callbacks (permissions, session switch)
  bot.on("callback_query:data", handleCallbackQuery);

  // Media handlers
  bot.on("message:photo", handlePhoto);
  bot.on("message:document", handleDocument);
  bot.on("message:voice", handleVoice);
  bot.on("message:video", handleVideo);
  bot.on("message:video_note", handleVideoNote);
  bot.on("message:sticker", handleSticker);

  // Text messages → Claude (must be last)
  bot.on("message:text", handleText);
}

async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(
    "Привет! Я Claude-бот с памятью.\n\n" +
      "Команды:\n" +
      "/sessions — список сессий\n" +
      "/switch <id> — переключить сессию\n" +
      "/standalone — автономный режим\n" +
      "/session — текущая сессия\n" +
      "/remember <текст> — сохранить в память\n" +
      "/recall <запрос> — поиск по памяти\n" +
      "/memories — список воспоминаний\n" +
      "/forget <id> — удалить воспоминание\n" +
      "/clear — очистить контекст\n" +
      "/status — статус бота\n" +
      "/stats — статистика\n" +
      "/logs [id] — логи сессии\n" +
      "/pending — ожидающие разрешения\n" +
      "/tools — MCP инструменты\n" +
      "/skills — skills из goodai-base\n" +
      "/rules — правила из goodai-base\n" +
      "/help — помощь",
  );
}

async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(
    "Я работаю в двух режимах:\n\n" +
      "*Standalone* — отвечаю сам через Claude API\n" +
      "*CLI\\-сессия* — пересылаю сообщения в Claude Code\n\n" +
      "Память:\n" +
      "• Кратковременная: последние 20 сообщений\n" +
      "• Долгосрочная: семантический поиск по истории\n\n" +
      "Сессии: /sessions, /switch, /session\n" +
      "Память: /remember, /recall, /memories, /forget\n" +
      "Утилиты: /clear, /status",
    { parse_mode: "MarkdownV2" },
  );
}

// === Session commands ===

async function handleSessions(ctx: Context): Promise<void> {
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
    return `${s.id}. ${name}${status}${marker}`;
  });

  await ctx.reply(
    "Сессии:\n" + lines.join("\n") + "\n\n/switch <id> для переключения",
  );
}

async function handleSwitch(ctx: Context): Promise<void> {
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
    await ctx.reply("Введи ID сессии:\n\n" + lines.join("\n"));
    pendingInput.set(chatId, async (replyCtx) => {
      const id = Number(replyCtx.message?.text?.trim());
      if (isNaN(id)) {
        await replyCtx.reply("Некорректный ID.");
        return;
      }
      await handleSwitchTo(replyCtx, id);
    });
    return;
  }

  const sessionId = Number(idStr);
  await handleSwitchTo(ctx, sessionId);
}

async function handleSwitchTo(ctx: Context, sessionId: number): Promise<void> {
  const session = await sessionManager.get(sessionId);

  if (!session) {
    await ctx.reply("Сессия не найдена.");
    return;
  }

  const chatId = String(ctx.chat!.id);
  await sessionManager.switchSession(chatId, sessionId);

  if (sessionId === 0) {
    await ctx.reply("Переключено на *standalone* режим\\.", {
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
      context = `\n\nПоследние сообщения:\n${preview}`;
    }

    const pendingText = pendingCount > 0 ? `\n\n⏳ В очереди: ${pendingCount} сообщ.` : "";
    const path = session.projectPath ? `\n📁 ${session.projectPath}` : "";
    await ctx.reply(`${statusIcon} Переключено на: ${name}${path}${pendingText}${context}`);
  }
}

async function handleRename(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const match = text.match(/^\/rename\s+(\d+)\s+(.+)$/);

  if (!match) {
    await ctx.reply("Формат: /rename <id> <имя>\nПример: /rename 3 keryx");
    return;
  }

  const sessionId = Number(match[1]);
  const newName = match[2].trim();
  const session = await sessionManager.get(sessionId);

  if (!session) {
    await ctx.reply("Сессия не найдена.");
    return;
  }

  await sql`UPDATE sessions SET name = ${newName} WHERE id = ${sessionId}`;
  await ctx.reply(`Сессия #${sessionId} переименована в "${newName}"`);
}

async function handleSessionInfo(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const activeId = await sessionManager.getActiveSession(chatId);
  const session = await sessionManager.get(activeId);

  if (!session) {
    await ctx.reply("Текущая сессия: standalone (по умолчанию)");
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
    `Сессия: ${session.name ?? session.clientId}`,
    `ID: ${session.id}`,
    `Статус: ${session.status}`,
    session.projectPath ? `Путь: ${session.projectPath}` : null,
    `Активность: ${agoStr} назад`,
  ].filter(Boolean);

  await ctx.reply(lines.join("\n"));
}

// === Memory commands ===

async function handleRemember(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const content = text.replace(/^\/remember\s*/, "").trim();
  const chatId = String(ctx.chat!.id);
  const activeSessionId = await sessionManager.getActiveSession(chatId);

  if (!content) {
    await ctx.reply("Что запомнить?");
    pendingInput.set(chatId, async (replyCtx) => {
      const input = replyCtx.message?.text?.trim();
      if (!input) return;
      const m = await remember({ source: "telegram", sessionId: activeSessionId, chatId, type: "note", content: input });
      const session = await sessionManager.get(activeSessionId);
      await replyCtx.reply(`Запомнил (#${m.id}, ${session?.name ?? "global"}): ${input.slice(0, 100)}${input.length > 100 ? "..." : ""}`);
    });
    return;
  }

  const m = await remember({
    source: "telegram",
    sessionId: activeSessionId,
    chatId,
    type: "note",
    content,
  });

  const session = await sessionManager.get(activeSessionId);
  await ctx.reply(`Запомнил (#${m.id}, ${session?.name ?? "global"}): ${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`);
}

async function handleRecall(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const query = text.replace(/^\/recall\s*/, "").trim();

  if (!query) {
    await ctx.reply("Что искать?");
    const chatId = String(ctx.chat!.id);
    pendingInput.set(chatId, async (replyCtx) => {
      const input = replyCtx.message?.text?.trim();
      if (!input) return;
      const results = await recall(input, { limit: 5 });
      if (results.length === 0) { await replyCtx.reply("Ничего не найдено."); return; }
      const lines = results.map((r) => `#${r.id} [${r.type}] ${r.content.slice(0, 120)}${r.content.length > 120 ? "..." : ""}`);
      await replyCtx.reply("Найдено:\n\n" + lines.join("\n\n"));
    });
    return;
  }

  const results = await recall(query, { limit: 5 });

  if (results.length === 0) {
    await ctx.reply("Ничего не найдено.");
    return;
  }

  const lines = results.map((r) => {
    const dist = (1 - Number(r.distance)).toFixed(0);
    return `#${r.id} [${r.type}] ${r.content.slice(0, 120)}${r.content.length > 120 ? "..." : ""}`;
  });

  await ctx.reply("Найдено:\n\n" + lines.join("\n\n"));
}

async function handleMemories(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const activeSessionId = await sessionManager.getActiveSession(chatId);
  const mems = await listMemories({ sessionId: activeSessionId, limit: 10 });

  if (mems.length === 0) {
    // Also check global memories
    const globalMems = await listMemories({ limit: 10 });
    if (globalMems.length === 0) {
      await ctx.reply("Память пуста.");
      return;
    }
    const lines = globalMems.map(
      (m) => `#${m.id} [${m.type}] s:${m.sessionId ?? "global"} ${m.content.slice(0, 70)}${m.content.length > 70 ? "..." : ""}`,
    );
    await ctx.reply("Воспоминания (все сессии):\n\n" + lines.join("\n"));
    return;
  }

  const session = await sessionManager.get(activeSessionId);
  const lines = mems.map(
    (m) => `#${m.id} [${m.type}] ${m.content.slice(0, 80)}${m.content.length > 80 ? "..." : ""}`,
  );

  await ctx.reply(`Воспоминания (${session?.name ?? "global"}):\n\n` + lines.join("\n"));
}

async function handleForget(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const idStr = text.replace(/^\/forget\s*/, "").trim();

  if (!idStr || isNaN(Number(idStr))) {
    await ctx.reply("Введи ID воспоминания:");
    const chatId = String(ctx.chat!.id);
    pendingInput.set(chatId, async (replyCtx) => {
      const id = Number(replyCtx.message?.text?.trim());
      if (isNaN(id)) { await replyCtx.reply("Некорректный ID."); return; }
      const deleted = await forget(id);
      await replyCtx.reply(deleted ? `Удалено #${id}` : `#${id} не найдено`);
    });
    return;
  }

  const deleted = await forget(Number(idStr));
  await ctx.reply(deleted ? `Удалено #${idStr}` : `#${idStr} не найдено`);
}

// === Utility commands ===

async function handleClear(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const sessionId = await sessionManager.getActiveSession(chatId);

  clearCache(sessionId, chatId);
  await sql`DELETE FROM messages WHERE session_id = ${sessionId} AND chat_id = ${chatId}`;

  await ctx.reply("Контекст очищен.");
}

async function handleRemove(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const idStr = text.replace(/^\/remove\s*/, "").trim();

  if (!idStr || isNaN(Number(idStr))) {
    await ctx.reply("Формат: /remove <id>\nПример: /remove 399");
    return;
  }

  const sessionId = Number(idStr);
  if (sessionId === 0) {
    await ctx.reply("Нельзя удалить standalone сессию.");
    return;
  }

  const session = await sessionManager.get(sessionId);
  if (!session) {
    await ctx.reply("Сессия не найдена.");
    return;
  }

  // Delete all related data in correct order (FK constraints)
  await sql`DELETE FROM chat_sessions WHERE active_session_id = ${sessionId}`;
  await sql`DELETE FROM permission_requests WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM memories WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM messages WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM message_queue WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM request_logs WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM api_request_stats WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM transcription_stats WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM sessions WHERE id = ${sessionId}`;

  await ctx.reply(`Удалена сессия #${sessionId} (${session.name ?? "unnamed"}) со всеми данными.`);
}

async function cleanupSession(id: number): Promise<void> {
  await sql`DELETE FROM chat_sessions WHERE active_session_id = ${id}`;
  await sql`DELETE FROM permission_requests WHERE session_id = ${id}`;
  await sql`DELETE FROM memories WHERE session_id = ${id}`;
  await sql`DELETE FROM messages WHERE session_id = ${id}`;
  await sql`DELETE FROM message_queue WHERE session_id = ${id}`;
  await sql`DELETE FROM request_logs WHERE session_id = ${id}`;
  await sql`DELETE FROM api_request_stats WHERE session_id = ${id}`;
  await sql`DELETE FROM transcription_stats WHERE session_id = ${id}`;
  await sql`DELETE FROM sessions WHERE id = ${id}`;
}

async function handleCleanup(ctx: Context): Promise<void> {
  // Find sessions to remove
  const toRemove = await sql`
    SELECT id, name, status FROM sessions
    WHERE id != 0 AND (name LIKE 'cli-%' OR status = 'disconnected')
  `;

  if (toRemove.length === 0) {
    await ctx.reply("Нечего чистить.");
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

  await ctx.reply(`Очищено ${toRemove.length}: ${parts.join(", ")}`);
}

async function handleSummarize(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const sessionId = await sessionManager.getActiveSession(chatId);

  await ctx.reply("Суммаризирую...");
  const summary = await forceSummarize(sessionId, chatId);

  if (summary) {
    await ctx.reply(`Сохранено в долгосрочную память:\n\n${summary}`);
  } else {
    await ctx.reply("Недостаточно сообщений для суммаризации.");
  }
}

async function handleStatus(ctx: Context): Promise<void> {
  // DB check
  let dbOk = false;
  try {
    await sql`SELECT 1`;
    dbOk = true;
  } catch {}

  // Ollama check
  let ollamaOk = false;
  try {
    const res = await fetch(`${process.env.OLLAMA_URL ?? "http://localhost:11434"}/api/tags`);
    ollamaOk = res.ok;
  } catch {}

  // Counts
  const [{ count: sessionCount }] = await sql`SELECT count(*) FROM sessions WHERE status = 'active'`;
  const [{ count: memoryCount }] = await sql`SELECT count(*) FROM memories`;
  const [{ count: messageCount }] = await sql`SELECT count(*) FROM messages`;

  const apiKey = process.env.ANTHROPIC_API_KEY ? "настроен" : "не задан";

  const lines = [
    `PostgreSQL: ${dbOk ? "OK" : "ОШИБКА"}`,
    `Ollama: ${ollamaOk ? "OK" : "ОШИБКА"}`,
    `API ключ: ${apiKey}`,
    `Активных сессий: ${sessionCount}`,
    `Воспоминаний: ${memoryCount}`,
    `Сообщений: ${messageCount}`,
    `MCP порт: ${process.env.PORT ?? 3847}`,
  ];

  await ctx.reply("Статус:\n\n" + lines.join("\n"));
}

// === Stats & Logs commands ===

async function handleStats(ctx: Context): Promise<void> {
  await ctx.replyWithChatAction("typing");

  const [api, transcription, msgs] = await Promise.all([
    getApiStats(),
    getTranscriptionStats(),
    getMessageStats(),
  ]);

  const lines: string[] = ["📊 Статистика\n"];

  // API stats
  for (const window of ["24ч", "запуск", "всего"] as const) {
    const a = api[window];
    if (!a?.summary?.total) continue;

    lines.push(`— API (${window}) —`);
    lines.push(`Запросов: ${a.summary.total} (✓${a.summary.success} ✗${a.summary.errors})`);
    if (a.summary.total_tokens > 0) {
      lines.push(`Токены: ${a.summary.input_tokens}→ ${a.summary.output_tokens}← (${a.summary.total_tokens})`);
    }
    lines.push(`Ср. латентность: ${a.summary.avg_latency_ms}ms`);

    if (a.byProvider.length > 0) {
      lines.push("Провайдеры:");
      for (const p of a.byProvider) {
        lines.push(`  ${p.provider}/${p.model}: ${p.requests} req, ${p.tokens} tok, ${p.avg_ms}ms`);
      }
    }

    if (a.bySession.length > 0) {
      lines.push("По сессиям:");
      for (const s of a.bySession) {
        const name = s.session_name ?? `#${s.session_id}`;
        lines.push(`  ${name}: ${s.requests} req, ${s.tokens} tok, ${s.avg_ms}ms`);
      }
    }
    lines.push("");
  }

  // Transcription stats
  for (const window of ["24ч", "запуск", "всего"] as const) {
    const t = transcription[window];
    if (!t?.summary?.total) continue;

    lines.push(`--- Транскрипция (${window}) ---`);
    lines.push(`Всего: ${t.summary.total} (ok ${t.summary.success} err ${t.summary.errors})`);
    lines.push(`Ср. латентность: ${t.summary.avg_latency_ms}ms`);

    if (t.byProvider.length > 0) {
      for (const p of t.byProvider) {
        lines.push(`  ${p.provider}: ${p.requests} req (✓${p.success}), ${p.avg_ms}ms`);
      }
    }
    lines.push("");
  }

  // Message stats
  const msgWindow = msgs["всего"];
  if (msgWindow?.bySession?.length > 0) {
    lines.push("— Сообщения (всего) —");
    for (const s of msgWindow.bySession) {
      const name = s.session_name ?? `#${s.session_id}`;
      lines.push(`  ${name}: ${s.total} (👤${s.user_msgs} 🤖${s.assistant_msgs})`);
    }
    lines.push("");
  }

  const text = lines.join("\n").trim();
  // Telegram max 4096 chars
  if (text.length > 4000) {
    await ctx.reply(text.slice(0, 4000) + "\n\n... (обрезано)");
  } else {
    await ctx.reply(text);
  }
}

async function handleLogs(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const arg = text.replace(/^\/logs\s*/, "").trim();
  const chatId = String(ctx.chat!.id);

  await ctx.replyWithChatAction("typing");

  let logs;
  let header: string;

  if (arg && !isNaN(Number(arg))) {
    // /logs <sessionId>
    const sessionId = Number(arg);
    const session = await sessionManager.get(sessionId);
    if (!session) {
      await ctx.reply("Сессия не найдена.");
      return;
    }
    header = `📋 Логи: ${session.name ?? `#${sessionId}`}`;
    logs = await getSessionLogs(sessionId, 30);
  } else {
    // /logs — current session
    const activeId = await sessionManager.getActiveSession(chatId);
    const session = await sessionManager.get(activeId);
    header = `📋 Логи: ${session?.name ?? `#${activeId}`}`;
    logs = await getSessionLogs(activeId, 30);
  }

  if (logs.length === 0) {
    await ctx.reply(`${header}\n\nЛогов нет.`);
    return;
  }

  const lines = [header, ""];
  for (const log of logs.reverse()) {
    const time = new Date(log.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const levelIcon = log.level === "error" ? "[ERR]" : log.level === "warn" ? "[WARN]" : "[OK]";
    lines.push(`${levelIcon} ${time} [${log.stage}] ${log.message}`);
  }

  const output = lines.join("\n");
  if (output.length > 4000) {
    await ctx.reply(output.slice(0, 4000) + "\n\n... (обрезано)");
  } else {
    await ctx.reply(output);
  }
}

// === Pending & Tools commands ===

async function handlePending(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const rows = await sql`
    SELECT id, tool_name, description, created_at
    FROM permission_requests
    WHERE chat_id = ${chatId} AND response IS NULL
    ORDER BY created_at DESC
    LIMIT 10
  `;

  if (rows.length === 0) {
    await ctx.reply("Нет ожидающих разрешений.");
    return;
  }

  const lines = rows.map((r) => {
    const ago = Math.round((Date.now() - new Date(r.created_at).getTime()) / 1000);
    return `${r.tool_name}: ${r.description.slice(0, 80)} (${ago}s ago)`;
  });

  await ctx.reply(`Ожидающие разрешения (${rows.length}):\n\n` + lines.join("\n\n"));
}

async function handleTools(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const activeId = await sessionManager.getActiveSession(chatId);
  const session = await sessionManager.get(activeId);

  const httpTools = [
    "remember — сохранить в долгосрочную память",
    "recall — семантический поиск по памяти",
    "forget — удалить воспоминание",
    "list_memories — список воспоминаний",
    "reply — ответить в чат",
    "react — поставить реакцию",
    "edit_message — редактировать сообщение",
    "list_sessions — список сессий",
    "session_info — информация о сессии",
    "set_session_name — задать имя сессии",
  ];

  const channelTools = [
    "reply — ответить в чат (HTML)",
    "update_status — обновить статус в Telegram",
    "remember, recall, forget, list_memories — память",
  ];

  const lines = [
    `Сессия: ${session?.name ?? "standalone"}\n`,
    "HTTP MCP (доступны всем сессиям):",
    ...httpTools.map((t) => `  ${t}`),
    "",
    "Channel (доступны CLI-сессиям):",
    ...channelTools.map((t) => `  ${t}`),
  ];

  await ctx.reply(lines.join("\n"));
}

// === Skills & Rules commands ===

const KNOWLEDGE_BASE = process.env.KNOWLEDGE_BASE;

async function handleSkills(ctx: Context): Promise<void> {
  if (!KNOWLEDGE_BASE) {
    await ctx.reply("KNOWLEDGE_BASE не настроена. Укажите путь к базе знаний в .env.");
    return;
  }
  try {
    const agents = await Bun.file(`${KNOWLEDGE_BASE}/AGENTS.md`).text();

    // Extract skills from Skills Catalog section
    const skillsMatch = agents.match(/## 🎨 Skills Catalog[\s\S]*?(?=\n---|\n## [^#])/);
    if (!skillsMatch) {
      await ctx.reply("Skills catalog not found.");
      return;
    }

    const lines: string[] = ["<b>Skills Catalog</b>\n"];

    // Parse skill entries with categories
    const categoryRegex = /### (.+)\n/g;
    const skillRegex = /\*\*`skills\/([\w-]+)`\*\*\s*(?:⭐\s*\w+[^*]*)?\n-\s*\*\*Purpose\*\*:\s*(.+)/g;

    // Extract categories and their positions
    const categories: { name: string; pos: number }[] = [];
    let catMatch;
    while ((catMatch = categoryRegex.exec(skillsMatch[0])) !== null) {
      categories.push({ name: catMatch[1], pos: catMatch.index });
    }

    let match;
    while ((match = skillRegex.exec(skillsMatch[0])) !== null) {
      // Find which category this skill belongs to
      const cat = categories.filter((c) => c.pos < match!.index).pop();
      if (cat && !lines.some((l) => l.includes(cat.name))) {
        lines.push(`\n<b>${cat.name}</b>`);
      }
      lines.push(`  <code>${match[1]}</code> — ${match[2]}`);
    }

    if (lines.length === 1) {
      await ctx.reply("No skills found in catalog.");
      return;
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  } catch {
    await ctx.reply(`Не удалось прочитать базу з��аний (${KNOWLEDGE_BASE})`);
  }
}

async function handleRules(ctx: Context): Promise<void> {
  if (!KNOWLEDGE_BASE) {
    await ctx.reply("KNOWLEDGE_BASE не настроена. Укажите путь к базе знаний в .env.");
    return;
  }
  try {
    const agents = await Bun.file(`${KNOWLEDGE_BASE}/AGENTS.md`).text();

    // Extract rules from Core Rule Catalog section
    const rulesMatch = agents.match(/## 📖 Core Rule Catalog[\s\S]*?(?=\n---|\n## [^#])/);
    if (!rulesMatch) {
      await ctx.reply("Rules catalog not found.");
      return;
    }

    const lines: string[] = ["<b>Core Rules</b>\n"];

    // Parse categories and rules
    const categoryRegex = /\*\*(.+?):\*\*/g;
    const ruleRegex = /-\s*`core\/([\w-]+)\.mdc`:\s*(.+)/g;

    const categories: { name: string; pos: number }[] = [];
    let catMatch;
    while ((catMatch = categoryRegex.exec(rulesMatch[0])) !== null) {
      categories.push({ name: catMatch[1], pos: catMatch.index });
    }

    let match;
    while ((match = ruleRegex.exec(rulesMatch[0])) !== null) {
      const cat = categories.filter((c) => c.pos < match!.index).pop();
      if (cat && !lines.some((l) => l.includes(cat.name))) {
        lines.push(`\n<b>${cat.name}</b>`);
      }
      lines.push(`  <code>${match[1]}</code> — ${match[2]}`);
    }

    if (lines.length === 1) {
      await ctx.reply("No rules found in catalog.");
      return;
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  } catch {
    await ctx.reply(`Не удалось прочитать базу знаний (${KNOWLEDGE_BASE})`);
  }
}

// === Callback query dispatcher ===

async function handleCallbackQuery(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  if (data.startsWith("perm:")) return handlePermissionCallback(ctx);
  if (data.startsWith("switch:")) return handleSwitchCallback(ctx);

  await ctx.answerCallbackQuery({ text: "Unknown action" });
}

// === Switch session callback ===

async function handleSwitchCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const targetId = Number(data?.split(":")[1]);
  const chatId = String(ctx.chat?.id);

  if (isNaN(targetId)) {
    await ctx.answerCallbackQuery({ text: "Invalid session" });
    return;
  }

  const session = await sessionManager.get(targetId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: "Сессия не найдена" });
    return;
  }

  await sessionManager.switchSession(chatId, targetId);
  appendLog(targetId, chatId, "switch", `switched via inline button`);

  // Remove the button from the message
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {}

  await ctx.answerCallbackQuery({ text: `Переключено на ${session.name}` });
  await ctx.reply(`Переключено на ${session.name}. Пиши сообщение — оно пойдёт туда.`);
}

// === Permission callback ===

async function handlePermissionCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("perm:")) return;

  const parts = data.split(":");
  const action = parts[1]; // 'allow', 'always', or 'deny'
  const requestId = parts.slice(2).join(":");

  // For "always" — treat as allow + save auto-approve rule
  const dbAction = action === "always" ? "allow" : action;

  const result = await sql`
    UPDATE permission_requests SET response = ${dbAction} WHERE id = ${requestId} RETURNING id, tool_name, session_id
  `;

  if (result.length > 0) {
    const originalText = ctx.callbackQuery?.message?.text ?? "";
    const descPart = originalText.replace(/^🔐 Разрешить\?\n*/, "").trim();

    if (action === "always") {
      const toolName = result[0].tool_name;
      const sessionId = result[0].session_id;

      // Add to auto-approve in both project and global settings
      const settingsPaths: string[] = [];

      // Project settings
      const sessionRows = await sql`SELECT project_path FROM sessions WHERE id = ${sessionId}`;
      const projectPath = sessionRows[0]?.project_path;
      if (projectPath) {
        settingsPaths.push(`${projectPath}/.claude/settings.local.json`);
      }

      // Global settings (host path mounted into Docker)
      const hostConfig = process.env.HOST_CLAUDE_CONFIG;
      if (hostConfig) {
        settingsPaths.push(`${hostConfig}/settings.local.json`);
      }

      const pattern = `${toolName}(*)`;
      for (const settingsPath of settingsPaths) {
        try {
          let settings: any = {};
          try {
            settings = JSON.parse(await Bun.file(settingsPath).text());
          } catch {}
          if (!settings.permissions) settings.permissions = {};
          if (!settings.permissions.allow) settings.permissions.allow = [];
          if (!settings.permissions.allow.includes(pattern)) {
            settings.permissions.allow.push(pattern);
            const dir = settingsPath.split("/").slice(0, -1).join("/");
            await Bun.write(settingsPath, JSON.stringify(settings, null, 2) + "\n");
            console.log(`[perm] added ${pattern} to ${settingsPath}`);
          }
        } catch (err) {
          console.error(`[perm] failed to write ${settingsPath}:`, err);
        }
      }

      await ctx.editMessageText(`✅ Всегда разрешено: ${toolName}\n\n${descPart}`);
      await ctx.answerCallbackQuery({ text: `Всегда: ${toolName}` });
    } else if (action === "allow") {
      await ctx.editMessageText(`✅ Разрешено\n\n${descPart}`);
      await ctx.answerCallbackQuery({ text: "Разрешено" });
    } else {
      await ctx.editMessageText(`❌ Запрещено\n\n${descPart}`);
      await ctx.answerCallbackQuery({ text: "Запрещено" });
    }
  } else {
    await ctx.answerCallbackQuery({ text: "Запрос устарел" });
  }
}

// === Media handlers ===

async function handleMedia(
  ctx: Context,
  fileId: string,
  description: string,
  caption?: string,
  filename?: string,
): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const route = await routeMessage(chatId);

  // Show typing indicator while downloading
  await ctx.replyWithChatAction("typing");

  // Download file
  let filePath: string;
  try {
    filePath = await downloadFile(bot, fileId, filename);
  } catch (err) {
    console.error("[handler] file download failed:", err);
    await ctx.reply("Не удалось скачать файл.");
    return;
  }

  const hostPath = toHostPath(filePath);
  const text = caption
    ? `${description}: ${caption}\n[file: ${hostPath}]`
    : `${description}\n[file: ${hostPath}]`;

  if (route.mode === "cli") {
    await addMessage({
      sessionId: route.sessionId,
      chatId,
      role: "user",
      content: text,
      metadata: { fileId, filePath, messageId: ctx.message?.message_id },
    });

    await sql`
      INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
      VALUES (
        ${route.sessionId},
        ${chatId},
        ${ctx.from?.username ?? ctx.from?.first_name ?? "user"},
        ${text},
        ${String(ctx.message?.message_id ?? "")}
      )
    `;
    return;
  }

  // Standalone: process with available provider
  const sessionId = route.sessionId;
  const { provider } = getProviderInfo();

  // Save text description to DB (no base64)
  await addMessage({
    sessionId,
    chatId,
    role: "user",
    content: text,
    metadata: { fileId, filePath, messageId: ctx.message?.message_id },
  });

  // If Anthropic provider and it's a photo, send image to Claude for analysis
  const isPhoto = description.startsWith("Фото");
  if (provider === "anthropic" && isPhoto) {
    try {
      const fileData = await Bun.file(filePath).arrayBuffer();
      const base64 = Buffer.from(fileData).toString("base64");
      const mimeType = "image/jpeg"; // Telegram always sends photos as JPEG

      const { system, messages } = await composePrompt(sessionId, chatId, caption || "Опиши что на изображении");

      // Replace last message content with image + text blocks
      const lastMsg = messages[messages.length - 1];
      const imageBlocks: ContentBlock[] = [
        { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
        { type: "text", text: caption || "Опиши что на изображении" },
      ];
      messages[messages.length - 1] = { role: lastMsg.role, content: imageBlocks };

      appendLog(sessionId, chatId, "llm", "analyzing image...");
      const response = await streamToTelegram(bot, ctx.chat!.id, system, messages, { sessionId, chatId, operation: "chat" });
      appendLog(sessionId, chatId, "reply", `image reply sent ${response.length} chars`);

      await addMessage({ sessionId, chatId, role: "assistant", content: response });
      return;
    } catch (err: any) {
      appendLog(sessionId, chatId, "llm", `image analysis failed: ${err?.message}`, "error");
    }
  }

  await ctx.reply(`Получен ${description}. Файл сохранён.`);
}

async function handlePhoto(ctx: Context): Promise<void> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) return;
  // Get highest resolution
  const photo = photos[photos.length - 1];
  await handleMedia(ctx, photo.file_id, "Фото", ctx.message?.caption);
}

async function handleDocument(ctx: Context): Promise<void> {
  const doc = ctx.message?.document;
  if (!doc) return;
  await handleMedia(
    ctx,
    doc.file_id,
    `Документ (${doc.file_name ?? "file"}, ${doc.mime_type ?? "unknown"})`,
    ctx.message?.caption,
    doc.file_name ?? undefined,
  );
}

async function handleVoice(ctx: Context): Promise<void> {
  const voice = ctx.message?.voice;
  if (!voice) return;

  const chatId = String(ctx.chat!.id);
  const route = await routeMessage(chatId);

  appendLog(route.sessionId, chatId, "voice", `received ${voice.duration}s, route=${route.mode}`);

  // Send status message that we'll update
  const statusMsg = await ctx.reply(`🎤 Голосовое (${voice.duration}с) — скачиваю...`);
  await ctx.replyWithChatAction("typing");

  // Download voice file
  let filePath: string;
  try {
    filePath = await downloadFile(bot, voice.file_id);
    appendLog(route.sessionId, chatId, "voice", `downloaded: ${filePath}`);
  } catch (err) {
    console.error("[handler] voice download failed:", err);
    appendLog(route.sessionId, chatId, "voice", `download failed: ${err}`, "error");
    await bot.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "🎤 Не удалось скачать голосовое сообщение.");
    return;
  }

  // Transcribe
  await bot.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "🎤 Распознаю речь...");
  const fileData = await Bun.file(filePath).arrayBuffer();
  const text = await transcribe(fileData, "voice.ogg", voice.mime_type ?? "audio/ogg", {
    sessionId: route.sessionId,
    chatId,
    audioDurationSec: voice.duration,
  });

  if (text) {
    appendLog(route.sessionId, chatId, "voice", `transcribed: ${text.slice(0, 80)}`);
    await bot.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `🎤 Распознано: ${text}`);

    // Process as text message with transcription
    const content = `🎤 ${text}`;

    if (route.mode === "cli") {
      await addMessage({
        sessionId: route.sessionId,
        chatId,
        role: "user",
        content,
        metadata: { voiceFile: filePath, messageId: ctx.message?.message_id },
      });
      await sql`
        INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
        VALUES (
          ${route.sessionId}, ${chatId},
          ${ctx.from?.username ?? ctx.from?.first_name ?? "user"},
          ${content}, ${String(ctx.message?.message_id ?? "")}
        )
      `;
      appendLog(route.sessionId, chatId, "queue", "voice message queued for CLI");
      touchIdleTimer(route.sessionId, chatId);
    } else if (route.mode === "standalone") {
      await addMessage({
        sessionId: route.sessionId,
        chatId,
        role: "user",
        content,
        metadata: { voiceFile: filePath, messageId: ctx.message?.message_id },
      });
      const { system, messages } = await composePrompt(route.sessionId, chatId, content);
      appendLog(route.sessionId, chatId, "llm", "streaming voice response...");
      const response = await streamToTelegram(bot, ctx.chat!.id, system, messages, { sessionId: route.sessionId, chatId, operation: "chat" });
      appendLog(route.sessionId, chatId, "reply", `voice reply sent ${response.length} chars`);
      await addMessage({ sessionId: route.sessionId, chatId, role: "assistant", content: response });
      touchIdleTimer(route.sessionId, chatId);
    } else {
      appendLog(route.sessionId, chatId, "voice", `no handler for mode=${route.mode}`, "warn");
    }
  } else {
    // Transcription failed
    appendLog(route.sessionId, chatId, "voice", "transcription failed", "error");
    await bot.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "🎤 Не удалось распознать речь. Отправляю как файл...");
    await handleMedia(ctx, voice.file_id, `Голосовое сообщение (${voice.duration}s, не распознано)`);
  }
}

async function handleVideo(ctx: Context): Promise<void> {
  const video = ctx.message?.video;
  if (!video) return;
  await handleMedia(
    ctx,
    video.file_id,
    `Видео (${video.duration}s)`,
    ctx.message?.caption,
    video.file_name ?? undefined,
  );
}

async function handleVideoNote(ctx: Context): Promise<void> {
  const vn = ctx.message?.video_note;
  if (!vn) return;
  await handleMedia(ctx, vn.file_id, `Видеосообщение (${vn.duration}s)`);
}

async function handleSticker(ctx: Context): Promise<void> {
  const sticker = ctx.message?.sticker;
  if (!sticker) return;
  const emoji = sticker.emoji ?? "";
  const text = `Стикер ${emoji} (${sticker.set_name ?? "без набора"})`;
  // Don't download sticker, just notify
  const chatId = String(ctx.chat!.id);
  const route = await routeMessage(chatId);

  if (route.mode === "cli") {
    await sql`
      INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
      VALUES (
        ${route.sessionId},
        ${chatId},
        ${ctx.from?.username ?? ctx.from?.first_name ?? "user"},
        ${text},
        ${String(ctx.message?.message_id ?? "")}
      )
    `;
  }
}

// === Text handler ===

async function handleText(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const text = ctx.message?.text;
  if (!text) return;

  // Check for pending input (e.g. waiting for session ID after /switch)
  const handler = pendingInput.get(chatId);
  if (handler) {
    pendingInput.delete(chatId);
    await handler(ctx);
    return;
  }

  const route = await routeMessage(chatId);

  appendLog(route.sessionId, chatId, "route", `mode=${route.mode}, session=#${route.sessionId}`);

  if (route.mode === "disconnected") {
    appendLog(route.sessionId, chatId, "route", `session "${route.sessionName}" disconnected`, "warn");
    await ctx.reply(
      `Сессия "${route.sessionName}" отключена.\n/switch 0 для standalone или /sessions для списка.`,
    );
    return;
  }

  if (route.mode === "cli") {
    appendLog(route.sessionId, chatId, "route", `cli session #${route.sessionId}`);

    // Show typing indicator
    await ctx.replyWithChatAction("typing");

    // Save message to short-term memory
    await addMessage({
      sessionId: route.sessionId,
      chatId,
      role: "user",
      content: text,
      metadata: {
        messageId: ctx.message?.message_id,
        from: ctx.from?.username ?? ctx.from?.first_name,
      },
    });

    // Put message into queue for stdio channel adapter
    await sql`
      INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
      VALUES (
        ${route.sessionId},
        ${chatId},
        ${ctx.from?.username ?? ctx.from?.first_name ?? "user"},
        ${text},
        ${String(ctx.message?.message_id ?? "")}
      )
    `;
    appendLog(route.sessionId, chatId, "queue", "message queued for CLI");
    touchIdleTimer(route.sessionId, chatId);
    return;
  }

  // Standalone mode: process with available provider (anthropic/openrouter/ollama)
  const sessionId = route.sessionId;

  // Show typing indicator
  await ctx.replyWithChatAction("typing");

  appendLog(sessionId, chatId, "receive", `user message: ${text.slice(0, 80)}`);

  // Save user message
  await addMessage({
    sessionId,
    chatId,
    role: "user",
    content: text,
    metadata: {
      messageId: ctx.message?.message_id,
      from: ctx.from?.username ?? ctx.from?.first_name,
    },
  });

  // Compose prompt with memory context
  const { system, messages } = await composePrompt(sessionId, chatId, text);

  // Stream response
  try {
    appendLog(sessionId, chatId, "llm", "streaming response...");
    const response = await streamToTelegram(bot, ctx.chat!.id, system, messages, { sessionId, chatId, operation: "chat" });
    appendLog(sessionId, chatId, "reply", `sent ${response.length} chars`);

    // Save assistant response
    await addMessage({
      sessionId,
      chatId,
      role: "assistant",
      content: response,
    });
  } catch (err: any) {
    appendLog(sessionId, chatId, "llm", `error: ${err?.message ?? err}`, "error");
    await ctx.reply(`Ошибка: ${err?.message ?? "неизвестная ошибка"}`);
  }

  // Touch idle timer and check overflow
  touchIdleTimer(sessionId, chatId);
  await checkOverflow(sessionId, chatId);
}

// Bot reference set from bot.ts
let bot: any;
export function setBotRef(b: any): void {
  bot = b;
}
