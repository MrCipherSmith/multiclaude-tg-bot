import type { Bot } from "grammy";
import { streamResponse, type MessageParam, type StreamContext } from "../llm/client.ts";
import { chunkText } from "../utils/chunk.ts";
import { markdownToTelegramHtml } from "./format.ts";
import { startTyping } from "../utils/typing.ts";
import { logger } from "../logger.ts";

const EDIT_INTERVAL_MS = 1500;
const TYPING_INDICATOR = "⏳";

export async function streamToTelegram(
  bot: Bot,
  chatId: number | string,
  system: string,
  messages: MessageParam[],
  ctx?: StreamContext,
  threadId?: number | null,
): Promise<string> {
  // Send initial "thinking" message — include thread_id for forum topics
  const sendOpts = threadId ? { message_thread_id: threadId } : undefined;
  let sent = await bot.api.sendMessage(Number(chatId), TYPING_INDICATOR, sendOpts);

  // Safety check: if we expected a thread but the message landed elsewhere, fix it
  if (threadId && sent.message_thread_id !== threadId) {
    logger.warn({ expected: threadId, got: sent.message_thread_id }, "streaming: message landed in wrong thread, resending");
    bot.api.deleteMessage(Number(chatId), sent.message_id).catch(() => {});
    sent = await bot.api.sendMessage(Number(chatId), TYPING_INDICATOR, { message_thread_id: threadId });
  }

  const messageId = sent.message_id;

  let accumulated = "";
  let lastEditAt = 0;
  let editInFlight: Promise<void> | null = null;

  const doEdit = async (text: string, final = false) => {
    const chunks = chunkText(text);
    const firstChunk = chunks[0];

    // Use HTML formatting only on final edit (partial markdown breaks during streaming)
    const parseMode = final ? "HTML" : undefined;
    const formatted = final ? markdownToTelegramHtml(firstChunk) : firstChunk;

    try {
      await bot.api.editMessageText(Number(chatId), messageId, formatted, {
        parse_mode: parseMode,
      });
    } catch (err: any) {
      if (err?.description?.includes("can't parse entities")) {
        // HTML parse failed — fallback to plain text
        try {
          await bot.api.editMessageText(Number(chatId), messageId, firstChunk);
        } catch (e) {
          logger.warn({ err: e }, "streaming: fallback edit failed");
        }
      } else if (!err?.description?.includes("message is not modified")) {
        if (err?.error_code === 429) {
          const retryAfter = (err?.parameters?.retry_after ?? 3) * 1000;
          await new Promise((r) => setTimeout(r, retryAfter));
          try {
            await bot.api.editMessageText(Number(chatId), messageId, firstChunk);
          } catch (e) {
            logger.warn({ err: e }, "streaming: retry edit failed");
          }
        } else {
          logger.warn({ err }, "streaming: edit error");
        }
      }
    }

    // Send continuation chunks as separate messages
    if (final && chunks.length > 1) {
      for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        const htmlChunk = markdownToTelegramHtml(chunk);
        try {
          await bot.api.sendMessage(Number(chatId), htmlChunk, { parse_mode: "HTML" });
        } catch {
          // Fallback to plain text
          try {
            await bot.api.sendMessage(Number(chatId), chunk);
          } catch (e) {
            logger.warn({ err: e }, "streaming: failed to send continuation chunk");
          }
        }
      }
    }
  };

  // Keep typing indicator alive during long responses (Telegram clears it after ~5s).
  const typing = startTyping(() =>
    bot.api.sendChatAction(Number(chatId), "typing", threadId ? { message_thread_id: threadId } : undefined),
  );

  try {
    for await (const delta of streamResponse(messages, system, ctx)) {
      accumulated += delta;

      const now = Date.now();
      if (now - lastEditAt >= EDIT_INTERVAL_MS && !editInFlight) {
        lastEditAt = now;
        const snapshot = accumulated;
        // Sequential: wait for previous edit before starting next
        editInFlight = doEdit(snapshot)
          .catch((err) => logger.warn({ err }, "streaming: edit failed"))
          .finally(() => { editInFlight = null; });
      }
    }

    // Wait for any in-flight edit to complete before final edit
    if (editInFlight) await editInFlight;

    // Final edit with complete text + HTML formatting
    if (accumulated.length > 0) {
      await doEdit(accumulated, true);
    } else {
      await bot.api.editMessageText(Number(chatId), messageId, "(empty response)");
    }
  } finally {
    typing.stop();
  }

  return accumulated;
}
