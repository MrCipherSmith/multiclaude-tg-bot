import type { Bot } from "grammy";
import { InputFile } from "grammy";
import { CONFIG } from "../config.ts";
import { channelLogger } from "../logger.ts";

const GROQ_API_KEY = CONFIG.GROQ_API_KEY;
// OpenAI TTS key — read directly since config merges it into OPENROUTER_API_KEY
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const YANDEX_API_KEY = CONFIG.YANDEX_API_KEY;
const YANDEX_FOLDER_ID = CONFIG.YANDEX_FOLDER_ID;

const VOICE_MIN_CHARS = 300;

/**
 * Returns true if the text qualifies for a voice attachment:
 * - At least 200 chars
 * - Not mostly code (fenced code blocks < 40% of text length)
 * - Not a diff (fewer than 6 lines starting with + or -)
 */
export function shouldSendVoice(text: string): boolean {
  if (text.length < VOICE_MIN_CHARS) return false;

  // Count characters inside fenced code blocks
  let codeChars = 0;
  for (const m of text.matchAll(/```[\s\S]*?```/g)) {
    codeChars += m[0].length;
  }
  if (codeChars / text.length > 0.4) return false;

  // Detect diffs: lines starting with + or - but NOT markdown bullets ("- item")
  // Real diff lines: "+added", "-removed" (no space after marker)
  const diffLines = text.split("\n").filter((l) => /^[+\-][^ +\-]/.test(l)).length;
  if (diffLines >= 6) return false;

  return true;
}

/** Strip markdown formatting for cleaner TTS output */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")          // code blocks → remove entirely
    .replace(/`[^`]+`/g, "")                 // inline code → remove
    .replace(/^#{1,6}\s+/gm, "")             // headings
    .replace(/\*\*([^*]+)\*\*/g, "$1")       // bold
    .replace(/\*([^*]+)\*/g, "$1")           // italic *
    .replace(/_([^_]+)_/g, "$1")             // italic _
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → keep label only
    .replace(/^\s*[-*+]\s+/gm, "")           // unordered list bullets
    .replace(/^\s*\d+\.\s+/gm, "")           // ordered list numbers
    .replace(/\n{3,}/g, "\n\n")              // collapse excessive blank lines
    .trim();
}

/** Synthesize via Yandex SpeechKit (Russian, multilingual). Returns MP3 buffer. */
async function synthesizeYandex(text: string): Promise<Buffer | null> {
  if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) return null;

  const body = new URLSearchParams({
    text: text.slice(0, 5000),
    lang: "ru-RU",
    voice: "alena",
    format: "mp3",
    folderId: YANDEX_FOLDER_ID,
  });

  const res = await fetch("https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize", {
    method: "POST",
    headers: {
      Authorization: `Api-Key ${YANDEX_API_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    channelLogger.error({ status: res.status, err }, "tts: Yandex error");
    return null;
  }

  return Buffer.from(await res.arrayBuffer());
}

/** Synthesize via Groq Orpheus (English only — best available Groq TTS as of 2026). */
async function synthesizeGroq(text: string): Promise<Buffer | null> {
  if (!GROQ_API_KEY) return null;

  const res = await fetch("https://api.groq.com/openai/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "canopylabs/orpheus-v1-english",
      input: text.slice(0, 4000),
      voice: "autumn",
      response_format: "wav",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    channelLogger.error({ status: res.status, err }, "tts: Groq error");
    return null;
  }

  return Buffer.from(await res.arrayBuffer());
}

/** Synthesize via OpenAI TTS (tts-1, multilingual, auto language detect). */
async function synthesizeOpenAI(text: string): Promise<Buffer | null> {
  if (!OPENAI_API_KEY) return null;

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      input: text.slice(0, 4096),
      voice: "nova",
      response_format: "mp3",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    channelLogger.error({ status: res.status, err }, "tts: OpenAI error");
    return null;
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Convert text to speech.
 * Priority: Yandex SpeechKit (Russian, if keys set) → Groq (fallback).
 * Returns audio buffer or null on failure/disabled.
 */
export async function synthesize(text: string): Promise<Buffer | null> {
  const clean = stripMarkdown(text);
  if (clean.length < 10) return null;

  // Yandex first — best Russian support
  if (YANDEX_API_KEY && YANDEX_FOLDER_ID) {
    try {
      const buf = await synthesizeYandex(clean);
      if (buf) return buf;
    } catch (err) {
      channelLogger.warn({ err }, "tts: Yandex failed, trying Groq");
    }
  }

  // Groq fallback
  try {
    return await synthesizeGroq(clean);
  } catch (err) {
    channelLogger.error({ err }, "tts: all providers failed");
    return null;
  }
}

/**
 * Fire-and-forget: if text qualifies for voice, generate TTS and send
 * as a Telegram voice message (MP3). Does not block the caller.
 */
export function maybeAttachVoice(
  bot: Bot,
  chatId: number | string,
  text: string,
  threadId?: number | null,
): void {
  if (!shouldSendVoice(text)) return;

  const opts = threadId ? { message_thread_id: threadId } : undefined;

  synthesize(text)
    .then((buf) => {
      if (!buf) return;
      return bot.api.sendVoice(Number(chatId), new InputFile(buf, "voice.wav"), opts);
    })
    .catch((err) => channelLogger.error({ err }, "tts: failed to send voice"));
}

/**
 * Same as maybeAttachVoice but uses a raw bot token instead of a grammY Bot.
 * Used by the channel subprocess which doesn't have a Bot instance.
 * @param forceVoice — skip shouldSendVoice check (e.g. user sent a voice message)
 */
export function maybeAttachVoiceRaw(
  token: string,
  chatId: number | string,
  text: string,
  threadId?: number | null,
  forceVoice = false,
): void {
  channelLogger.info({ chatId, threadId, textLen: text.length, forceVoice, hasGroqKey: !!GROQ_API_KEY }, "tts: maybeAttachVoiceRaw called");
  if (!forceVoice && !shouldSendVoice(text)) {
    channelLogger.info({ chatId, textLen: text.length }, "tts: shouldSendVoice=false, skipping");
    return;
  }

  // Show "recording voice..." indicator while synthesis is in progress.
  // Telegram clears chat actions after 5s, so repeat every 4s until done.
  const actionBody: Record<string, unknown> = {
    chat_id: String(chatId),
    action: "upload_voice",
  };
  if (threadId) actionBody.message_thread_id = threadId;
  const sendAction = () => fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(actionBody),
  }).catch(() => {});

  sendAction();
  const actionTimer = setInterval(sendAction, 4000);

  synthesize(text)
    .then(async (buf) => {
      clearInterval(actionTimer);
      if (!buf) {
        channelLogger.warn({ chatId }, "tts: synthesize returned null");
        return;
      }
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("voice", new Blob([buf], { type: "audio/wav" }), "voice.wav");
      if (threadId) form.append("message_thread_id", String(threadId));
      channelLogger.info({ chatId, threadId, bufSize: buf.length }, "tts: sending voice");
      const res = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const err = await res.text();
        channelLogger.error({ status: res.status, err }, "tts: sendVoice failed");
      } else {
        channelLogger.info({ chatId, threadId }, "tts: voice sent ok");
      }
    })
    .catch((err) => {
      clearInterval(actionTimer);
      channelLogger.error({ err }, "tts: failed to send voice (raw)");
    });
}
