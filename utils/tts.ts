import type { Bot } from "grammy";
import { InputFile } from "grammy";
import { CONFIG } from "../config.ts";
import { logger } from "../logger.ts";

const GROQ_API_KEY = CONFIG.GROQ_API_KEY;
// OpenAI TTS key — read directly since config merges it into OPENROUTER_API_KEY
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

const VOICE_MIN_CHARS = 200;

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

  // Detect diffs: lines starting with + or - (but not --- / +++ headers)
  const diffLines = text.split("\n").filter((l) => /^[+\-][^+\-]/.test(l)).length;
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

/** Synthesize via Groq playai-tts (multilingual, auto language detect). */
async function synthesizeGroq(text: string): Promise<Buffer | null> {
  if (!GROQ_API_KEY) return null;

  const res = await fetch("https://api.groq.com/openai/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "playai-tts",
      input: text.slice(0, 4000),
      voice: "Fritz-PlayAI",
      response_format: "mp3",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    logger.error({ status: res.status, err }, "tts: Groq error");
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
    logger.error({ status: res.status, err }, "tts: OpenAI error");
    return null;
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Convert text to speech. Tries OpenAI first (better multilingual),
 * falls back to Groq. Returns MP3 buffer or null on failure/disabled.
 */
export async function synthesize(text: string): Promise<Buffer | null> {
  const clean = stripMarkdown(text);
  if (clean.length < 10) return null;

  // OpenAI first — better Russian support
  if (OPENAI_API_KEY) {
    try {
      const buf = await synthesizeOpenAI(clean);
      if (buf) return buf;
    } catch (err) {
      logger.warn({ err }, "tts: OpenAI failed, trying Groq");
    }
  }

  // Groq fallback (or primary if no OpenAI key)
  try {
    return await synthesizeGroq(clean);
  } catch (err) {
    logger.error({ err }, "tts: all providers failed");
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
      return bot.api.sendVoice(Number(chatId), new InputFile(buf, "voice.mp3"), opts);
    })
    .catch((err) => logger.error({ err }, "tts: failed to send voice"));
}
