import type { Context } from "grammy";
import { composePrompt } from "../claude/prompt.ts";
import { addMessage } from "../memory/short-term.ts";
import { streamToTelegram } from "./streaming.ts";
import { routeMessage } from "../sessions/router.ts";
import { logger } from "../logger.ts";
import { touchIdleTimer, checkOverflow } from "../memory/summarizer.ts";
import { sql } from "../memory/db.ts";
import { appendLog } from "../utils/stats.ts";
import { pendingInput, clearPendingInput, pendingToolInput, clearPendingTool, getBotRef } from "./handlers.ts";
import { agentManager } from "../agents/agent-manager.ts";
import { orchestrator } from "../agents/orchestrator.ts";
import { getSwitchContext, clearSwitchContext } from "./switch-cache.ts";
import { replyInThread, escapeHtml } from "./format.ts";
import { getForumChatId } from "./forum-cache.ts";
import { enqueueForTopic, topicQueueKey } from "./topic-queue.ts";
import { maybeAttachVoice } from "../utils/tts.ts";
export { replyInThread } from "./format.ts";

export async function enqueueToolCommand(
  chatId: string,
  fromUser: string,
  command: string,
  ctx?: Context,
): Promise<void> {
  const route = await routeMessage(chatId);

  if (route.mode !== "cli") {
    if (ctx) await replyInThread(ctx, "⚠️ No active CLI session. Use /switch to connect one.");
    return;
  }

  await sql`
    INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
    VALUES (${route.sessionId}, ${chatId}, ${fromUser}, ${command}, ${"tool"})
  `;

  appendLog(route.sessionId, chatId, "tools", `queued: ${command.slice(0, 80)}`);
  if (ctx) await replyInThread(ctx, `✅ Sent to session: <code>${command}</code>`, { parse_mode: "HTML" });
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

  // Forum routing
  const forumTopicId = ctx.message?.message_thread_id;
  const forumChatId = await getForumChatId();
  const isForumMessage = forumChatId !== null && chatId === forumChatId;

  // General topic (threadId=1 or no thread) in forum mode → control channel only.
  // Commands still work (handled before this point by grammY command handlers).
  if (isForumMessage && (!forumTopicId || forumTopicId === 1)) {
    await replyInThread(ctx, "💡 General — только команды.\nОткрой топик проекта чтобы работать с сессией.");
    return;
  }

  // v1.42.0 Pattern A — topic-bound agent routing.
  // Before falling through to the session-based flow, check if any
  // agent_instance is bound to this forum topic via `forum_topic_id`.
  // If so, the message becomes an agent_task for that instance instead
  // of a chat turn for the project's claude-code session. The standalone-
  // llm worker picks it up within ~3s; result auto-posts back to the
  // topic via the result-router (already wired in v1.39.0).
  //
  // Skipped when the topic has no bound agent — falls through to the
  // existing session/claude-code path below.
  if (isForumMessage && forumTopicId) {
    try {
      const boundAgent = await agentManager.getInstanceByForumTopic(forumTopicId);
      if (boundAgent) {
        const task = await orchestrator.createTask({
          title: text.length > 200 ? text.slice(0, 197) + "…" : text,
          description: text.length > 200 ? text : undefined,
          agentInstanceId: boundAgent.id,
          payload: {
            source: "telegram-topic-routed",
            forum_topic_id: forumTopicId,
            telegram_chat_id: chatId,
            telegram_message_id: ctx.message?.message_id ?? null,
            from: ctx.from?.username ?? ctx.from?.first_name ?? null,
          },
        });
        await replyInThread(
          ctx,
          `🤖 Task <code>#${task.id}</code> queued for <b>${escapeHtml(boundAgent.name)}</b>.\n` +
            `<i>Result will appear in this topic when complete.</i>`,
          { parse_mode: "HTML" },
        );
        return;
      }
    } catch (err) {
      // Don't block the message on a routing-layer hiccup — fall
      // through to the existing path so the user still gets a response
      // from claude-code if a session exists.
      logger.warn(
        { forumTopicId, err: String(err) },
        "topic-bound agent lookup failed; falling back to session routing",
      );
    }
  }

  // Fire typing indicator immediately — user sees feedback before routeMessage DB query
  ctx.replyWithChatAction("typing", forumTopicId ? { message_thread_id: forumTopicId } : undefined).catch(() => {});

  const t0 = Date.now();
  logger.debug({ phase: "text-handler", step: "typing-sent", chatId, msgId: ctx.message?.message_id, t: t0 }, "perf");

  const route = await routeMessage(chatId, isForumMessage ? forumTopicId : undefined);
  logger.debug({ phase: "text-handler", step: "route-done", chatId, mode: route.mode, elapsedMs: Date.now() - t0 }, "perf");

  appendLog(route.sessionId, chatId, "route", `mode=${route.mode}, session=#${route.sessionId}`);

  if (route.mode === "disconnected") {
    appendLog(route.sessionId, chatId, "route", `session "${route.sessionName}" not active`, "warn");
    const sessionLabel = escapeHtml(route.sessionName ?? `#${route.sessionId}`);
    const projectHint = route.projectPath ? `\n📁 Проект: <code>${escapeHtml(route.projectPath)}</code>` : "";
    await replyInThread(
      ctx,
      `⚠️ Сессия <b>${sessionLabel}</b> не активна.${projectHint}\n\n` +
      `Если Claude Code запущен — сессия подключится автоматически при следующем запуске.\n` +
      `Или:\n` +
      `/standalone — перейти в standalone (без Claude Code)\n` +
      `/sessions — все сессии`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (route.mode === "cli") {
    appendLog(route.sessionId, chatId, "route", `cli session #${route.sessionId}`);

    // Save message to short-term memory
    const t1 = Date.now();
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

    logger.debug({ phase: "text-handler", step: "addmsg-done", chatId, sessionId: route.sessionId, elapsedMs: Date.now() - t1 }, "perf");

    // ClaudeAdapter: insert into message_queue — channel.ts handles delivery.
    // ON CONFLICT DO NOTHING: if the bot restarts mid-poll, grammY re-delivers the same
    // Telegram update; the dedup index on (chat_id, message_id) prevents double-queueing.
    const t2 = Date.now();
    await sql`
      INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
      VALUES (
        ${route.sessionId},
        ${chatId},
        ${fromUser},
        ${text},
        ${messageId}
      )
      ON CONFLICT (chat_id, message_id)
        WHERE message_id IS NOT NULL AND message_id != '' AND message_id != 'tool'
      DO NOTHING
    `;
    logger.debug({ phase: "text-handler", step: "queue-inserted", chatId, sessionId: route.sessionId, msgId: messageId, elapsedMs: Date.now() - t2, totalMs: Date.now() - t0 }, "perf");
    appendLog(route.sessionId, chatId, "queue", "message queued for CLI");

    // 👀 — received by bot, waiting for Claude Code to pick it up
    if (ctx.message?.message_id) {
      ctx.api.setMessageReaction(ctx.chat!.id, ctx.message.message_id, [{ type: "emoji", emoji: "👀" }]).catch(() => {});
    }

    touchIdleTimer(route.sessionId, chatId, route.projectPath);
    return;
  }

  // Standalone mode: enqueue per-topic so different topics run in parallel
  // but messages within the same topic stay sequential.
  const sessionId = route.sessionId;
  const projectPath = route.projectPath;
  const queueKey = topicQueueKey(chatId, isForumMessage ? forumTopicId : null);

  enqueueForTopic(
    queueKey,
    async () => {
      await ctx.replyWithChatAction("typing");

      // 👀 — received and processing started (standalone mode)
      if (ctx.message?.message_id) {
        ctx.api.setMessageReaction(ctx.chat!.id, ctx.message.message_id, [{ type: "emoji", emoji: "👀" }]).catch(() => {});
      }

      appendLog(sessionId, chatId, "receive", `user message: ${text.slice(0, 80)}`);

      await addMessage({
        sessionId,
        projectPath,
        chatId,
        role: "user",
        content: text,
        metadata: {
          messageId: ctx.message?.message_id,
          from: ctx.from?.username ?? ctx.from?.first_name,
        },
      });

      const switchCtx = getSwitchContext(chatId);
      let effectiveText = text;
      if (switchCtx) {
        effectiveText = `[Project context from prior session]\n${switchCtx.summary}\n\n[User message]\n${text}`;
        clearSwitchContext(chatId);
      }

      const { system, messages } = await composePrompt(sessionId, chatId, effectiveText);

      try {
        appendLog(sessionId, chatId, "llm", "streaming response...");
        const response = await streamToTelegram(bot, ctx.chat!.id, system, messages, { sessionId, chatId, operation: "chat" }, forumTopicId);
        appendLog(sessionId, chatId, "reply", `sent ${response.length} chars`);
        await addMessage({ sessionId, projectPath, chatId, role: "assistant", content: response });
        maybeAttachVoice(bot, ctx.chat!.id, response, isForumMessage ? forumTopicId : null);
      } catch (err: any) {
        appendLog(sessionId, chatId, "llm", `error: ${err?.message ?? err}`, "error");
        await replyInThread(ctx, `Error: ${err?.message ?? "unknown error"}`);
      }

      touchIdleTimer(sessionId, chatId, projectPath);
      await checkOverflow(sessionId, chatId, projectPath);
    },
    (position) => {
      replyInThread(ctx, `⏳ В очереди (#${position}). Предыдущий запрос обрабатывается...`)
        .catch(() => {});
    },
  );
}
