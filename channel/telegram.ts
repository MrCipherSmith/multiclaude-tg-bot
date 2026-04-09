/**
 * Pure Telegram HTTP helpers for the channel subprocess.
 * Leaf module — no imports from other channel/ modules.
 * All calls go through `telegramRequest` which handles retry on 429 and 5xx.
 */

import { channelLogger } from "../logger.ts";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_RETRIES = 3;

/** Low-level request with retry on 429 (rate limit) and 5xx errors. */
async function telegramRequest(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; errorBody?: string; status?: number }> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt === MAX_RETRIES) return { ok: false, errorBody: String(err) };
      await Bun.sleep(1000 * (attempt + 1));
      continue;
    }

    if (res.ok) {
      const data = (await res.json()) as { ok: boolean; result?: unknown };
      return { ok: true, result: data.result };
    }

    // Rate limit — wait retry_after seconds
    if (res.status === 429) {
      const data = (await res.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
      const wait = (data.parameters?.retry_after ?? 5) * 1000;
      channelLogger.warn({ method, wait }, "Telegram rate limit — retrying");
      await Bun.sleep(wait);
      continue;
    }

    // Server error — retry with backoff
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await Bun.sleep(1000 * (attempt + 1));
      continue;
    }

    const errorBody = await res.text().catch(() => String(res.status));
    return { ok: false, errorBody, status: res.status };
  }

  return { ok: false, errorBody: "max retries exceeded" };
}

// --- Public helpers ---

export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  extra?: Record<string, unknown>,
): Promise<{ ok: boolean; messageId: number | null; errorBody?: string }> {
  const res = await telegramRequest(token, "sendMessage", {
    chat_id: Number(chatId),
    text,
    ...extra,
  });
  if (!res.ok) return { ok: false, messageId: null, errorBody: res.errorBody };
  const result = res.result as { message_id?: number } | undefined;
  return { ok: true, messageId: result?.message_id ?? null };
}

export async function editTelegramMessage(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
  extra?: Record<string, unknown>,
): Promise<{ ok: boolean; errorBody?: string }> {
  return telegramRequest(token, "editMessageText", {
    chat_id: Number(chatId),
    message_id: messageId,
    text,
    ...extra,
  });
}

export function deleteTelegramMessage(token: string, chatId: string, messageId: number): void {
  telegramRequest(token, "deleteMessage", {
    chat_id: Number(chatId),
    message_id: messageId,
  }).catch(() => {});
}

export async function setTelegramReaction(
  token: string,
  chatId: string,
  messageId: number,
  emoji: string,
): Promise<{ ok: boolean; errorBody?: string }> {
  const res = await telegramRequest(token, "setMessageReaction", {
    chat_id: Number(chatId),
    message_id: messageId,
    reaction: [{ type: "emoji", emoji }],
  });
  return { ok: res.ok, errorBody: res.errorBody };
}
