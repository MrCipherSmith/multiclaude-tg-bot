import type { Bot } from "grammy";
import { streamResponse, type MessageParam } from "../claude/client.ts";
import { chunkText } from "../utils/chunk.ts";

const EDIT_INTERVAL_MS = 1500;
const TYPING_INDICATOR = "...";

export async function streamToTelegram(
  bot: Bot,
  chatId: number | string,
  system: string,
  messages: MessageParam[],
): Promise<string> {
  // Send initial "thinking" message
  const sent = await bot.api.sendMessage(Number(chatId), TYPING_INDICATOR);
  const messageId = sent.message_id;

  let accumulated = "";
  let lastEditAt = 0;
  let editPending = false;

  const doEdit = async (text: string, final = false) => {
    const chunks = chunkText(text);
    const firstChunk = chunks[0];

    try {
      await bot.api.editMessageText(Number(chatId), messageId, firstChunk);
    } catch (err: any) {
      // Ignore "message is not modified" errors
      if (!err?.description?.includes("message is not modified")) {
        // On rate limit, wait and retry once
        if (err?.error_code === 429) {
          const retryAfter = (err?.parameters?.retry_after ?? 3) * 1000;
          await new Promise((r) => setTimeout(r, retryAfter));
          try {
            await bot.api.editMessageText(Number(chatId), messageId, firstChunk);
          } catch { /* give up */ }
        }
      }
    }

    // Send continuation chunks as separate messages
    if (final && chunks.length > 1) {
      for (let i = 1; i < chunks.length; i++) {
        await bot.api.sendMessage(Number(chatId), chunks[i]);
      }
    }
  };

  for await (const delta of streamResponse(messages, system)) {
    accumulated += delta;

    const now = Date.now();
    if (now - lastEditAt >= EDIT_INTERVAL_MS && !editPending) {
      editPending = true;
      lastEditAt = now;
      const snapshot = accumulated;
      // Fire and forget, don't block the stream
      doEdit(snapshot).finally(() => { editPending = false; });
    }
  }

  // Final edit with complete text
  if (accumulated.length > 0) {
    await doEdit(accumulated, true);
  } else {
    await bot.api.editMessageText(Number(chatId), messageId, "(пустой ответ)");
  }

  return accumulated;
}
