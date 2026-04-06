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
      // OpencodeAdapter: send via HTTP and stream response back to Telegram
      const { opencodeAdapter } = await import("../adapters/opencode.ts");
      try {
        await opencodeAdapter.send(route.sessionId, text, { chatId, fromUser, messageId });
        appendLog(route.sessionId, chatId, "queue", "message sent to opencode");

        // Subscribe to SSE response and stream to Telegram
        let fullResponse = "";
        let sentMsgId: number | undefined;
        // Declare before callbacks to avoid temporal dead zone
        let unsubscribe: (() => void) | undefined;
        let watchdog: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
          if (watchdog) { clearTimeout(watchdog); watchdog = undefined; }
          unsubscribe?.();
        };

        unsubscribe = await opencodeAdapter.subscribeToResponses(
          route.sessionId,
          async (chunk) => {
            fullResponse += chunk;
            if (!sentMsgId) {
              const msg = await bot.api.sendMessage(Number(chatId), chunk);
              sentMsgId = msg.message_id;
            } else {
              try {
                await bot.api.editMessageText(Number(chatId), sentMsgId, fullResponse);
              } catch {
                // edit throttle — ignore
              }
            }
          },
          async () => {
            cleanup();
            if (fullResponse) {
              await addMessage({
                sessionId: route.sessionId,
                projectPath: route.projectPath,
                chatId,
                role: "assistant",
                content: fullResponse,
              });
            }
            appendLog(route.sessionId, chatId, "reply", `opencode response: ${fullResponse.length} chars`);
          },
          async (err) => {
            cleanup();
            appendLog(route.sessionId, chatId, "opencode", `SSE error: ${err.message}`, "error");
            await ctx.reply(`opencode error: ${err.message}`);
          },
        );

        // Watchdog: abort SSE if no response within 2 minutes
        watchdog = setTimeout(() => {
          cleanup();
          ctx.reply("opencode response timed out (2 min).").catch(() => {});
        }, 120_000);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        appendLog(route.sessionId, chatId, "opencode", `send error: ${msg}`, "error");
        if (msg.includes("ECONNREFUSED") || msg.includes("fetch")) {
          await ctx.reply(
            `opencode is not running. Start it with:\n<code>opencode serve</code>\nor enable autostart in session config.`,
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
