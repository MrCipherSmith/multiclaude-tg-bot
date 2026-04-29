import type { Bot } from "grammy";
import { InputFile } from "grammy";
import { join } from "path";
import { unlink } from "node:fs";
import { CONFIG } from "../config.ts";
import { channelLogger } from "../logger.ts";

const PIPER_DIR = process.env.PIPER_DIR ?? join(import.meta.dir, "../piper");
const PIPER_BIN = join(PIPER_DIR, "piper/piper");
// Per-language model files — fall back to the generic PIPER_MODEL
const PIPER_MODEL_FILE     = process.env.PIPER_MODEL    ?? "en_US-lessac-medium.onnx";
const PIPER_MODEL_FILE_EN  = process.env.PIPER_MODEL_EN ?? PIPER_MODEL_FILE;
const PIPER_MODEL_FILE_RU  = process.env.PIPER_MODEL_RU ?? PIPER_MODEL_FILE;
const PIPER_MODEL_EN = join(PIPER_DIR, "voices", PIPER_MODEL_FILE_EN);
const PIPER_MODEL_RU = join(PIPER_DIR, "voices", PIPER_MODEL_FILE_RU);

const GROQ_API_KEY = CONFIG.GROQ_API_KEY;
// OpenAI TTS key — read directly since config merges it into OPENROUTER_API_KEY
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const YANDEX_API_KEY = CONFIG.YANDEX_API_KEY;
const YANDEX_FOLDER_ID = CONFIG.YANDEX_FOLDER_ID;

// Lazily loaded Kokoro model instance
let _kokoroTTS: any | null = null;
async function getKokoro(): Promise<any> {
  if (_kokoroTTS) return _kokoroTTS;
  const { KokoroTTS } = await import("kokoro-js");
  channelLogger.info({ dtype: CONFIG.KOKORO_DTYPE }, "tts: loading Kokoro model...");
  const t0 = Date.now();
  _kokoroTTS = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
    dtype: CONFIG.KOKORO_DTYPE,
    device: "cpu",
  });
  channelLogger.info({ elapsedMs: Date.now() - t0 }, "tts: Kokoro model loaded");
  return _kokoroTTS;
}

/** Encode Float32Array PCM (24kHz mono) to WAV buffer */
function pcmToWav(pcm: Float32Array, sampleRate = 24000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = pcm.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);

  // RIFF header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);           // PCM chunk size
  buf.writeUInt16LE(1, 20);            // PCM format
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28); // byte rate
  buf.writeUInt16LE(numChannels * bytesPerSample, 32);              // block align
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);

  // Convert Float32 → Int16
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 44 + i * 2);
  }
  return buf;
}

const VOICE_MIN_CHARS = 300;

/** Returns true if text is predominantly Russian (Cyrillic ≥ 40% of letters). */
export function detectRussian(text: string): boolean {
  const cyr = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const lat = (text.match(/[a-zA-Z]/g) ?? []).length;
  const total = cyr + lat;
  return total === 0 ? true : cyr / total >= 0.4;
}

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

const TTS_NORMALIZE_PROMPT = `Rewrite the text for text-to-speech so it sounds natural when spoken aloud.

Rules:
- File paths → only the filename (channel/session.ts → session.ts, /home/user/bot/file.ts → file.ts)
- snake_case identifiers → replace underscores with spaces (lease_expires_at → lease expires at)
- camelCase identifiers → split into words (forceVoice → force voice, shouldSendVoice → should send voice)
- Function call parentheses → remove (acquireLease() → acquire lease)
- Short git hashes (7 hex chars like a1b2c3d) → omit
- Branch names with slashes → replace slash with space (fix/session-lease → fix session lease)
- Comparison operators: < → less than, > → greater than, = → equals
- key=value pairs → "key equals value" or just the key
- Pipe | and backslash → remove
- URLs → omit entirely
- CRITICAL: Output MUST be in the EXACT same language as the input. NEVER translate. NEVER mix languages. If input is English, output must be English. If input is Russian, output must be Russian.
- Output ONLY the rewritten text, nothing else`;

/**
 * Normalize text for TTS via Groq llama-3.1-8b-instant (~250ms).
 * Falls back to OpenRouter if Groq unavailable.
 * Returns the original text on error/timeout — TTS is never blocked.
 */
async function normalizeForSpeech(text: string, isRussian: boolean): Promise<string> {
  if (!GROQ_API_KEY && !CONFIG.OPENROUTER_API_KEY) return text;

  const t0 = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  const langLabel = isRussian ? "Russian" : "English";
  const userContent = `Language: ${langLabel}. DO NOT translate. Output in ${langLabel} only.\n\n${text.slice(0, 2000)}`;

  const messages = [
    { role: "system", content: TTS_NORMALIZE_PROMPT },
    { role: "user", content: userContent },
  ];

  try {
    // Groq llama-3.1-8b-instant — ~250ms, separate rate limits from TTS model
    if (GROQ_API_KEY) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
        signal: controller.signal,
        body: JSON.stringify({ model: "llama-3.1-8b-instant", messages, temperature: 0.1, max_tokens: 500 }),
      });
      if (res.ok) {
        const data = await res.json() as { choices?: { message?: { content?: string } }[] };
        const normalized = data.choices?.[0]?.message?.content?.trim();
        if (normalized && normalized.length > 5) {
          channelLogger.info({ elapsedMs: Date.now() - t0 }, "tts: normalize ok (groq)");
          return normalized;
        }
      } else {
        channelLogger.warn({ status: res.status }, "tts: groq normalize failed, trying openrouter");
      }
    }
  } catch (err: any) {
    if (err?.name !== "AbortError") {
      channelLogger.warn({ err: err?.message }, "tts: normalize request error, trying openrouter");
    }
  } finally {
    clearTimeout(timeout);
  }

  // OpenRouter fallback (Gemma 31B — slower ~7-12s but higher quality)
  if (CONFIG.OPENROUTER_API_KEY) {
    const controller2 = new AbortController();
    const timeout2 = setTimeout(() => controller2.abort(), 15000);
    try {
      const res = await fetch(`${CONFIG.OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONFIG.OPENROUTER_API_KEY}` },
        signal: controller2.signal,
        body: JSON.stringify({ model: CONFIG.OPENROUTER_MODEL, messages, temperature: 0.1, max_tokens: 500 }),
      });
      if (res.ok) {
        const data = await res.json() as { choices?: { message?: { content?: string } }[] };
        const normalized = data.choices?.[0]?.message?.content?.trim();
        if (normalized && normalized.length > 5) {
          channelLogger.info({ elapsedMs: Date.now() - t0, model: CONFIG.OPENROUTER_MODEL }, "tts: normalize ok (openrouter)");
          return normalized;
        }
      }
    } catch {
      // ignore
    } finally {
      clearTimeout(timeout2);
    }
  }

  channelLogger.info({ elapsedMs: Date.now() - t0 }, "tts: normalize skipped, using stripped text");
  return text;
}

/** Synthesize via Yandex SpeechKit (Russian, multilingual). Returns MP3 buffer. */
async function synthesizeYandex(text: string): Promise<Buffer | null> {
  if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) return null;

  const body = new URLSearchParams({
    text: text.slice(0, 5000),
    lang: CONFIG.YANDEX_LANG,
    voice: CONFIG.YANDEX_VOICE,
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

/** Synthesize via kesha-engine local TTS (Kokoro EN / Vosk-TTS RU, auto-routed). Returns WAV buffer.
 *  Voice IDs configurable via KESHA_VOICE_RU / KESHA_VOICE_EN (defaults: ru-vosk-m02 / en-af_heart).
 *  Kesha-voice-kit v1.5+ replaced Piper-RU with Vosk-TTS — pre-v1.5 ids (ru-denis, ru-irina, ...)
 *  no longer resolve and the engine will exit non-zero. */
export async function synthesizeKesha(text: string, isRussian: boolean): Promise<Buffer | null> {
  if (!CONFIG.KESHA_TTS_ENABLED || !CONFIG.KESHA_ENABLED) return null;

  const voice = isRussian ? CONFIG.KESHA_VOICE_RU : CONFIG.KESHA_VOICE_EN;
  const tmpFile = `/tmp/kesha-tts-${Date.now()}.wav`;
  try {
    const proc = Bun.spawn(
      [CONFIG.KESHA_BIN, "say", "--voice", voice, "--out", tmpFile, text.slice(0, 5000)],
      { stdout: "ignore", stderr: "ignore" },
    );
    const code = await proc.exited;
    if (code !== 0) {
      channelLogger.warn({ code }, "tts: kesha say exited with non-zero code");
      return null;
    }
    const buf = await Bun.file(tmpFile).arrayBuffer();
    return Buffer.from(buf);
  } catch (err) {
    channelLogger.error({ err }, "tts: kesha say error");
    return null;
  } finally {
    unlink(tmpFile, () => {});
  }
}

/** Synthesize via Piper local TTS (offline). Picks model by language. Returns WAV buffer. */
async function synthesizePiper(text: string, isRussian = true): Promise<Buffer | null> {
  const modelPath = isRussian ? PIPER_MODEL_RU : PIPER_MODEL_EN;
  const tmpFile = `/tmp/piper-tts-${Date.now()}.wav`;
  try {
    const proc = Bun.spawn(
      [PIPER_BIN, "--model", modelPath, "--output_file", tmpFile],
      {
        cwd: join(PIPER_DIR, "piper"),
        env: { ...process.env, LD_LIBRARY_PATH: join(PIPER_DIR, "piper") },
        stdin: new TextEncoder().encode(text.slice(0, 5000)),
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const code = await proc.exited;
    if (code !== 0) {
      channelLogger.warn({ code }, "tts: Piper exited with non-zero code");
      return null;
    }
    const buf = await Bun.file(tmpFile).arrayBuffer();
    return Buffer.from(buf);
  } catch (err) {
    channelLogger.error({ err }, "tts: Piper error");
    return null;
  } finally {
    import("fs").then(({ unlink }) => unlink(tmpFile, () => {})).catch(() => {});
  }
}

/** Synthesize via Kokoro local TTS (English only). Returns WAV buffer. */
async function synthesizeKokoro(text: string): Promise<Buffer | null> {
  try {
    const tts = await getKokoro();
    const audio = await tts.generate(text.slice(0, 2000), { voice: CONFIG.KOKORO_VOICE });
    // audio.audio is a Float32Array of PCM samples at 24kHz
    return pcmToWav(audio.audio as Float32Array, 24000);
  } catch (err) {
    channelLogger.error({ err }, "tts: Kokoro error");
    return null;
  }
}

/**
 * Run the current (non-kesha) TTS chain for benchmark comparison.
 * Tries Yandex → Piper → Kokoro without touching kesha.
 */
export async function synthesizeCurrentOnly(text: string, isRussian: boolean): Promise<{ buf: Buffer; fmt: "mp3" | "wav"; provider: string } | null> {
  const clean = stripMarkdown(text).slice(0, 1500);
  if (!clean) return null;
  if (isRussian) {
    if (YANDEX_API_KEY && YANDEX_FOLDER_ID) {
      try {
        const buf = await synthesizeYandex(clean);
        if (buf) return { buf, fmt: "mp3", provider: "yandex" };
      } catch { /* fall through */ }
    }
    try {
      const buf = await synthesizePiper(clean, true);
      if (buf) return { buf, fmt: "wav", provider: "piper-ru" };
    } catch { /* fall through */ }
  } else {
    try {
      const buf = await synthesizePiper(clean, false);
      if (buf) return { buf, fmt: "wav", provider: "piper-en" };
    } catch { /* fall through */ }
    try {
      const buf = await synthesizeKokoro(clean);
      if (buf) return { buf, fmt: "wav", provider: "kokoro" };
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * Convert text to speech.
 * Provider selection via TTS_PROVIDER env var:
 *   "auto"   — Piper → Yandex → Groq (Russian), Kokoro → Groq (English)
 *   "piper"  — local Piper only (Russian, offline)
 *   "yandex" — Yandex SpeechKit only (Russian, best quality)
 *   "kokoro" — local Kokoro only (English, offline)
 *   "openai" — OpenAI TTS only (multilingual)
 *   "groq"   — Groq Orpheus only (English)
 *   "none"   — TTS disabled
 * Returns audio buffer + format ('mp3' | 'wav') or null on failure/disabled.
 */
export async function synthesize(text: string): Promise<{ buf: Buffer; fmt: "mp3" | "wav" } | null> {
  const stripped = stripMarkdown(text);
  if (stripped.length < 10) return null;

  const provider = CONFIG.TTS_PROVIDER;

  if (provider === "none") return null;

  // Detect language on the original stripped text — before LLM normalization which
  // could accidentally introduce Cyrillic (e.g. hardcoded Russian phrases in the prompt).
  const cyrillicCountRaw = (stripped.match(/[\u0400-\u04FF]/g) ?? []).length;
  const latinCountRaw    = (stripped.match(/[a-zA-Z]/g) ?? []).length;
  const totalLettersRaw  = cyrillicCountRaw + latinCountRaw;
  const isRussian = totalLettersRaw === 0 ? true : cyrillicCountRaw / totalLettersRaw >= 0.4;

  // LLM-normalize before TTS: convert paths, symbols, code to natural speech
  const normalized = await normalizeForSpeech(stripped, isRussian);

  // Guard: if normalization changed the language (LLM returned wrong-language text despite
  // instructions), fall back to stripped original so the TTS model gets the right language.
  const cyrillicNorm = (normalized.match(/[\u0400-\u04FF]/g) ?? []).length;
  const latinNorm    = (normalized.match(/[a-zA-Z]/g) ?? []).length;
  const totalNorm    = cyrillicNorm + latinNorm;
  const isRussianNorm = totalNorm === 0 ? isRussian : cyrillicNorm / totalNorm >= 0.4;
  const clean = isRussianNorm !== isRussian
    ? (channelLogger.warn({ isRussian, isRussianNorm, normalizedPreview: normalized.slice(0, 150) }, "tts: normalize changed language, using stripped"), stripped)
    : normalized;

  channelLogger.info({
    isRussian,
    isRussianNorm,
    cyrillicRatio: totalLettersRaw > 0 ? +(cyrillicCountRaw / totalLettersRaw).toFixed(3) : null,
    normalizedPreview: clean.slice(0, 150),
  }, "tts: synthesizing");

  const wrap = (buf: Buffer | null, fmt: "mp3" | "wav") => buf ? { buf, fmt } : null;

  if (provider === "yandex") {
    if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
      channelLogger.warn({}, "tts: TTS_PROVIDER=yandex but YANDEX_API_KEY/YANDEX_FOLDER_ID not set");
      return null;
    }
    return synthesizeYandex(clean).then(b => wrap(b, "mp3")).catch((err) => {
      channelLogger.error({ err }, "tts: Yandex failed");
      return null;
    });
  }

  if (provider === "kokoro") {
    return synthesizeKokoro(clean).then(b => wrap(b, "wav"));
  }

  if (provider === "piper") {
    return synthesizePiper(clean, isRussian).then(b => wrap(b, "wav"));
  }

  if (provider === "openai") {
    return synthesizeOpenAI(clean).then(b => wrap(b, "mp3"));
  }

  if (provider === "groq") {
    return synthesizeGroq(clean).then(b => wrap(b, "wav"));
  }

  // auto (Russian): Yandex → Piper → Kesha → Groq
  // Yandex is first because it handles mixed Russian/English text correctly.
  // Piper-RU (irina) was historically preferred over Kesha because pre-v1.5
  // Kesha used Piper-RU under the hood with English-trained tail prosody.
  // Kesha v1.5 swapped to Vosk-TTS (multi-speaker BERT prosody) — quality
  // is now competitive with standalone Piper. Order is preserved for now to
  // avoid changing observed behavior; flip Piper / Kesha later if Vosk-TTS
  // is consistently better in practice.
  // auto (English): Piper(EN) → Kokoro → Kesha → Groq
  if (isRussian) {
    if (YANDEX_API_KEY && YANDEX_FOLDER_ID) {
      try {
        const buf = await synthesizeYandex(clean);
        if (buf) {
          channelLogger.info({}, "tts: provider=yandex");
          return { buf, fmt: "mp3" };
        }
      } catch (err) {
        channelLogger.warn({ err }, "tts: Yandex failed, trying Piper");
      }
    }

    try {
      const buf = await synthesizePiper(clean, true);
      if (buf) {
        channelLogger.info({}, "tts: provider=piper-ru");
        return { buf, fmt: "wav" };
      }
    } catch (err) {
      channelLogger.warn({ err }, "tts: Piper failed, trying Kesha");
    }

    try {
      const buf = await synthesizeKesha(clean, true);
      if (buf) {
        channelLogger.info({}, "tts: provider=kesha-ru");
        return { buf, fmt: "wav" };
      }
    } catch (err) {
      channelLogger.warn({ err }, "tts: Kesha failed, trying Groq");
    }
  } else {
    try {
      const buf = await synthesizePiper(clean, false);
      if (buf) {
        channelLogger.info({}, "tts: provider=piper-en");
        return { buf, fmt: "wav" };
      }
    } catch {
      // fall through to Kokoro
    }
    try {
      const buf = await synthesizeKokoro(clean);
      if (buf) {
        channelLogger.info({}, "tts: provider=kokoro");
        return { buf, fmt: "wav" };
      }
    } catch {
      // fall through to Kesha
    }
    try {
      const buf = await synthesizeKesha(clean, false);
      if (buf) {
        channelLogger.info({}, "tts: provider=kesha-en");
        return { buf, fmt: "wav" };
      }
    } catch {
      // fall through to Groq
    }
  }

  try {
    channelLogger.info({ isRussian }, "tts: provider=groq (english-only fallback)");
    const buf = await synthesizeGroq(clean);
    return wrap(buf, "wav");
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
    .then((result) => {
      if (!result) return;
      const filename = result.fmt === "mp3" ? "voice.mp3" : "voice.wav";
      return bot.api.sendVoice(Number(chatId), new InputFile(result.buf, filename), opts);
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
    .then(async (result) => {
      clearInterval(actionTimer);
      if (!result) {
        channelLogger.warn({ chatId }, "tts: synthesize returned null");
        return;
      }
      const { buf, fmt } = result;
      const mimeType = fmt === "mp3" ? "audio/mpeg" : "audio/wav";
      const filename = fmt === "mp3" ? "voice.mp3" : "voice.wav";
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("voice", new Blob([buf.buffer as ArrayBuffer], { type: mimeType }), filename);
      if (threadId) form.append("message_thread_id", String(threadId));
      channelLogger.info({ chatId, threadId, bufSize: buf.length, fmt }, "tts: sending voice");
      const sendVoice = () => fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
        method: "POST",
        body: form,
      });
      let res = await sendVoice();
      // Retry once on 429 Too Many Requests, respecting retry_after
      if (res.status === 429) {
        let retryAfter = 5;
        try {
          const body = await res.json() as { parameters?: { retry_after?: number } };
          retryAfter = body.parameters?.retry_after ?? 5;
        } catch { /* use default */ }
        channelLogger.warn({ chatId, retryAfter }, "tts: sendVoice 429, retrying after delay");
        await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
        res = await sendVoice();
      }
      if (!res.ok) {
        const err = await res.text();
        channelLogger.error({ status: res.status, err, fmt }, "tts: sendVoice failed");
      } else {
        channelLogger.info({ chatId, threadId, fmt }, "tts: voice sent ok");
      }
    })
    .catch((err) => {
      clearInterval(actionTimer);
      channelLogger.error({ err }, "tts: failed to send voice (raw)");
    });
}
