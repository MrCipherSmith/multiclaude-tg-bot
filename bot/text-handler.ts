import type { Context } from "grammy";
import { composePrompt } from "../claude/prompt.ts";
import { addMessage } from "../memory/short-term.ts";
import { streamToTelegram } from "./streaming.ts";
import { routeMessage } from "../sessions/router.ts";
import { touchIdleTimer, checkOverflow } from "../memory/summarizer.ts";
import { sql } from "../memory/db.ts";
import { appendLog } from "../utils/stats.ts";
import { pendingInput, clearPendingInput, pendingToolInput, clearPendingTool, getBotRef } from "./handlers.ts";
import { getSwitchContext, clearSwitchContext } from "./switch-cache.ts";

export async function enqueueToolCommand(
  chatId: string,
  fromUser: string,
  command: string,
  ctx?: Context,
): Promise<void> {
  const route = await routeMessage(chatId);

  if (route.mode !== "cli") {
    if (ctx) await ctx.reply("⚠️ No active CLI session. Use /switch to connect one.");
    return;
  }

  await sql`
    INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
    VALUES (${route.sessionId}, ${chatId}, ${fromUser}, ${command}, ${"tool"})
  `;

  appendLog(route.sessionId, chatId, "tools", `queued: ${command.slice(0, 80)}`);
  if (ctx) await ctx.reply(`✅ Sent to session: <code>${command}</code>`, { parse_mode: "HTML" });
}

export async function handleText(ctx: Context): Promise<void> {
  const bot = getBotRef();
  const chatId = String(ctx.chat!.id);
  const text = ctx.message?.text;
  if (!text) return;

  // Check for pending input (e.g. waiting for session ID after /switch)
  const handler = pendingInput.get(chatId);
  if (handler) {
    clearPendingInput(chatId);
    await handler(ctx);
    return;
  }

  // Check for pending tool invocation (waiting for arguments)
  const pendingTool = pendingToolInput.get(chatId);
  if (pendingTool) {
    clearPendingTool(chatId);
    const command = `/${pendingTool.name} ${text}`.trim();
    await enqueueToolCommand(chatId, ctx.from?.username ?? ctx.from?.first_name ?? "user", command, ctx);
    return;
  }

  const route = await routeMessage(chatId);

  appendLog(route.sessionId, chatId, "route", `mode=${route.mode}, session=#${route.sessionId}`);

  if (route.mode === "disconnected") {
    appendLog(route.sessionId, chatId, "route", `session "${route.sessionName}" not active`, "warn");
    await ctx.reply(
      `⚠️ Session <b>${route.sessionName ?? `#${route.sessionId}`}</b> is not active.\n\n/switch 0 — standalone mode\n/sessions — list all sessions`,
      { parse_mode: "HTML" },
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
      projectPath: route.projectPath,
      chatId,
      role: "user",
      content: text,
      metadata: {
        messageId: ctx.message?.message_id,
        from: ctx.from?.username ?? ctx.from?.first_name,
      },
    });

    const fromUser = ctx.from?.username ?? ctx.from?.first_name ?? "user";
    const messageId = String(ctx.message?.message_id ?? "");

    // ClaudeAdapter: insert into message_queue — channel.ts handles delivery
    await sql`
      INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
      VALUES (
        ${route.sessionId},
        ${chatId},
        ${fromUser},
        ${text},
        ${messageId}
      )
    `;
    appendLog(route.sessionId, chatId, "queue", "message queued for CLI");

    touchIdleTimer(route.sessionId, chatId, route.projectPath);
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
    projectPath: route.projectPath,
    chatId,
    role: "user",
    content: text,
    metadata: {
      messageId: ctx.message?.message_id,
      from: ctx.from?.username ?? ctx.from?.first_name,
    },
  });

  // Inject switch context briefing if available (once, then clear)
  const switchCtx = getSwitchContext(chatId);
  let effectiveText = text;
  if (switchCtx) {
    effectiveText = `[Project context from prior session]\n${switchCtx.summary}\n\n[User message]\n${text}`;
    clearSwitchContext(chatId);
  }

  // Compose prompt with memory context
  const { system, messages } = await composePrompt(sessionId, chatId, effectiveText);

  // Stream response
  try {
    appendLog(sessionId, chatId, "llm", "streaming response...");
    const response = await streamToTelegram(bot, ctx.chat!.id, system, messages, { sessionId, chatId, operation: "chat" });
    appendLog(sessionId, chatId, "reply", `sent ${response.length} chars`);

    // Save assistant response
    await addMessage({
      sessionId,
      projectPath: route.projectPath,
      chatId,
      role: "assistant",
      content: response,
    });
  } catch (err: any) {
    appendLog(sessionId, chatId, "llm", `error: ${err?.message ?? err}`, "error");
    await ctx.reply(`Error: ${err?.message ?? "unknown error"}`);
  }

  // Touch idle timer and check overflow
  touchIdleTimer(sessionId, chatId, route.projectPath);
  await checkOverflow(sessionId, chatId, route.projectPath);
}
