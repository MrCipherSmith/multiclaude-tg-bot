import type { Context } from "grammy";
import { composePrompt } from "../claude/prompt.ts";
import { addMessage } from "../memory/short-term.ts";
import { streamToTelegram } from "./streaming.ts";
import { routeMessage } from "../sessions/router.ts";
import { touchIdleTimer, checkOverflow } from "../memory/summarizer.ts";
import { sql } from "../memory/db.ts";
import { appendLog } from "../utils/stats.ts";
import { pendingInput, clearPendingInput, pendingToolInput, clearPendingTool, getBotRef } from "./handlers.ts";
import { getAdapter } from "../adapters/index.ts";

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

  // Route tool commands through the adapter (only claude uses message_queue for tools)
  if (route.cliType === "claude") {
    await sql`
      INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
      VALUES (${route.sessionId}, ${chatId}, ${fromUser}, ${command}, ${"tool"})
    `;
  } else {
    const adapter = getAdapter(route.cliType);
    await adapter.send(route.sessionId, command, { chatId, fromUser, messageId: "tool" });
  }

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
    appendLog(route.sessionId, chatId, "route", `session "${route.sessionName}" disconnected`, "warn");
    await ctx.reply(
      `Session "${route.sessionName}" disconnected.\n/switch 0 for standalone or /sessions for list.`,
    );
    return;
  }

  if (route.mode === "cli") {
    appendLog(route.sessionId, chatId, "route", `cli session #${route.sessionId} [${route.cliType}]`);

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

    if (route.cliType === "opencode") {
      // OpencodeAdapter: send message, monitor handles the response
      const { opencodeAdapter } = await import("../adapters/opencode.ts");
      const { opencodeMonitor } = await import("../adapters/opencode-monitor.ts");
      try {
        // Send a placeholder "..." message — monitor will edit it with the response
        const placeholder = await bot.api.sendMessage(Number(chatId), "...");
        opencodeMonitor.setPending(route.sessionId, chatId, placeholder.message_id);

        await opencodeAdapter.send(route.sessionId, text, { chatId, fromUser, messageId });
        appendLog(route.sessionId, chatId, "queue", "message sent to opencode");
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        appendLog(route.sessionId, chatId, "opencode", `send error: ${msg}`, "error");
        if (msg.includes("ECONNREFUSED") || msg.includes("fetch")) {
          await ctx.reply(
            `opencode is not running. Start it with:\n<code>opencode serve</code>`,
            { parse_mode: "HTML" },
          );
        } else {
          await ctx.reply(`Error: ${msg}`);
        }
      }
    } else {
      // ClaudeAdapter (default): insert into message_queue — channel.ts handles delivery
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
    }

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
