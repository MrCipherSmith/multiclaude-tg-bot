/**
 * Pure Telegram HTTP helpers for the channel subprocess.
 * Leaf module — no imports from other channel/ modules.
 * All calls go through `telegramRequest` which handles retry on 429 and 5xx.
 */

import { channelLogger } from "../logger.ts";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_ERROR_RETRIES = 3;  // for network errors and 5xx only
const FETCH_TIMEOUT_MS = 10_000; // 10 s per individual fetch — prevents infinite hang
const MAX_TOTAL_MS = 60_000;     // 60 s total budget per call (covers 429 retries too)

/** Low-level request with retry on 429 (rate limit) and 5xx errors.
 * Each fetch is capped at FETCH_TIMEOUT_MS.
 * Total call budget is MAX_TOTAL_MS — returns error if exceeded.
 * 429 retries wait retry_after but respect the total budget.
 * Network/5xx errors retry up to MAX_ERROR_RETRIES times.
 */
async function telegramRequest(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; errorBody?: string; status?: number }> {
  let errorAttempt = 0;
  const deadline = Date.now() + MAX_TOTAL_MS;

  while (true) {
    if (Date.now() >= deadline) {
      return { ok: false, errorBody: `telegramRequest timeout after ${MAX_TOTAL_MS}ms (method: ${method})` };
    }

    let res: Response;
    try {
      res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      if (errorAttempt >= MAX_ERROR_RETRIES) return { ok: false, errorBody: String(err) };
      await Bun.sleep(1000 * (errorAttempt + 1));
      errorAttempt++;
      continue;
    }

    if (res.ok) {
      const data = (await res.json()) as { ok: boolean; result?: unknown };
      return { ok: true, result: data.result };
    }

    // Rate limit — wait retry_after but respect total deadline
    if (res.status === 429) {
      const data = (await res.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
      const wait = (data.parameters?.retry_after ?? 5) * 1000;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, errorBody: `telegramRequest 429 deadline exceeded (method: ${method})` };
      channelLogger.warn({ method, wait, remaining }, "Telegram rate limit — retrying");
      await Bun.sleep(Math.min(wait, remaining));
      continue;
    }

    // Server error — retry with backoff up to MAX_ERROR_RETRIES
    if (res.status >= 500 && errorAttempt < MAX_ERROR_RETRIES) {
      await Bun.sleep(1000 * (errorAttempt + 1));
      errorAttempt++;
      continue;
    }

    const errorBody = await res.text().catch(() => String(res.status));
    return { ok: false, errorBody, status: res.status };
  }
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

export async function sendTelegramPoll(
  token: string,
  chatId: string,
  question: string,
  options: string[],
  extra?: Record<string, unknown>,
): Promise<{ ok: boolean; pollId?: string; messageId?: number; errorBody?: string }> {
  const res = await telegramRequest(token, "sendPoll", {
    chat_id: Number(chatId),
    question,
    options: options.map((text) => ({ text })),
    is_anonymous: false,
    ...extra,
  });
  if (!res.ok) return { ok: false, errorBody: res.errorBody };
  const result = res.result as { message_id?: number; poll?: { id?: string } } | undefined;
  return { ok: true, messageId: result?.message_id ?? null, pollId: result?.poll?.id ?? null };
}

export async function sendTelegramPhoto(
  token: string,
  chatId: string,
  photo: string, // public URL or absolute local file path
  caption?: string,
  extra?: Record<string, unknown>,
): Promise<{ ok: boolean; messageId: number | null; errorBody?: string }> {
  // Local file — upload via multipart form data
  if (photo.startsWith("/")) {
    const file = Bun.file(photo);
    if (!(await file.exists())) return { ok: false, messageId: null, errorBody: `File not found: ${photo}` };
    const bytes = await file.arrayBuffer();
    const mime = file.type || "image/jpeg";
    const form = new FormData();
    form.append("chat_id", String(Number(chatId)));
    form.append("photo", new Blob([bytes], { type: mime }), "photo");
    if (caption) form.append("caption", caption);
    if (extra?.message_thread_id) form.append("message_thread_id", String(extra.message_thread_id));
    let res: Response;
    try {
      res = await fetch(`${TELEGRAM_API}/bot${token}/sendPhoto`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      return { ok: false, messageId: null, errorBody: String(err) };
    }
    if (!res.ok) {
      const errorBody = await res.text().catch(() => String(res.status));
      return { ok: false, messageId: null, errorBody };
    }
    const data = (await res.json()) as { ok: boolean; result?: { message_id?: number } };
    return { ok: true, messageId: data.result?.message_id ?? null };
  }

  // Remote URL — pass directly to Telegram
  const res = await telegramRequest(token, "sendPhoto", {
    chat_id: Number(chatId),
    photo,
    ...(caption ? { caption } : {}),
    ...extra,
  });
  if (!res.ok) return { ok: false, messageId: null, errorBody: res.errorBody };
  const result = res.result as { message_id?: number } | undefined;
  return { ok: true, messageId: result?.message_id ?? null };
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
