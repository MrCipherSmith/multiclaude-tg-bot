import { recordTranscription } from "./stats.ts";
import { CONFIG } from "../config.ts";
import { unlink, writeFile } from "node:fs/promises";

const GROQ_API_KEY = CONFIG.GROQ_API_KEY;
const WHISPER_URL = CONFIG.WHISPER_URL;
const TIMEOUT_MS = 60000;

export interface TranscribeContext {
  sessionId?: number | null;
  chatId?: string | null;
  audioDurationSec?: number | null;
}

/** Transcribe via Groq whisper-large-v3 API (primary) */
export async function transcribeGroq(
  audioBuffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
): Promise<string | null> {
  if (!GROQ_API_KEY) return null;

  const form = new FormData();
  form.append(
    "file",
    new Blob([audioBuffer], { type: mimeType }),
    fileName,
  );
  form.append("model", "whisper-large-v3");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
    signal: controller.signal,
  });

  clearTimeout(timeout);

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[transcribe] Groq error: ${res.status} ${errText}`);
    throw new Error(`Groq ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as { text?: string };
  return data.text?.trim() || null;
}

/** Transcribe via local Whisper ASR (fallback) */
export async function transcribeLocal(
  audioBuffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
): Promise<string | null> {
  const form = new FormData();
  form.append(
    "audio_file",
    new Blob([audioBuffer], { type: mimeType }),
    fileName,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const res = await fetch(
    `${WHISPER_URL}/asr?task=transcribe&output=json`,
    {
      method: "POST",
      body: form,
      signal: controller.signal,
    },
  );

  clearTimeout(timeout);

  if (!res.ok) {
    console.error(`[transcribe] Whisper error: ${res.status}`);
    throw new Error(`Whisper ${res.status}`);
  }

  const data = (await res.json()) as { text?: string };
  return data.text?.trim() || null;
}

let keshaModelsPromise: Promise<boolean> | null = null;

function ensureKeshaModels(): Promise<boolean> {
  if (!keshaModelsPromise) keshaModelsPromise = _initKeshaModels();
  return keshaModelsPromise;
}

async function _initKeshaModels(): Promise<boolean> {
  const home = process.env.HOME ?? "";
  const modelFile = `${home}/.cache/kesha/models/parakeet-tdt-v3/encoder-model.onnx`;
  const hasModels = home ? await Bun.file(modelFile).exists() : false;

  if (!hasModels) {
    console.error("[transcribe] kesha models not found, running install...");
    const proc = Bun.spawn([CONFIG.KESHA_BIN, "install"], {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env },
    });
    const code = await proc.exited;
    if (code !== 0) {
      console.error(`[transcribe] kesha install failed with code ${code}`);
      return false;
    }
  }
  return true;
}

/** Transcribe via kesha-engine local ONNX ASR (offline, no API key needed). */
export async function transcribeKesha(
  audioBuffer: ArrayBuffer,
  fileName: string,
): Promise<string | null> {
  if (!CONFIG.KESHA_ENABLED) return null;
  if (!(await ensureKeshaModels())) return null;

  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const tmpFile = `/tmp/kesha-asr-${Date.now()}-${safeName}`;
  try {
    await writeFile(tmpFile, Buffer.from(audioBuffer));

    const proc = Bun.spawn([CONFIG.KESHA_BIN, "transcribe", tmpFile], {
      stdout: "pipe",
      stderr: "ignore",
    });

    const code = await proc.exited;
    if (code !== 0) {
      console.error(`[transcribe] kesha exited with code ${code}`);
      return null;
    }

    const text = await new Response(proc.stdout).text();
    return text.trim() || null;
  } catch (err) {
    console.error(`[transcribe] kesha error:`, err);
    return null;
  } finally {
    unlink(tmpFile).catch(() => {});
  }
}

/** Transcribe audio: Groq (primary) → Kesha local ONNX → local Whisper (fallback) */
export async function transcribe(
  audioBuffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
  ctx?: TranscribeContext,
): Promise<string | null> {
  // Try Groq
  const groqStart = Date.now();
  try {
    const result = await transcribeGroq(audioBuffer, fileName, mimeType);
    if (result) {
      console.error(`[transcribe] Groq OK`);
      recordTranscription({
        sessionId: ctx?.sessionId,
        chatId: ctx?.chatId,
        provider: "groq",
        durationMs: Date.now() - groqStart,
        audioDurationSec: ctx?.audioDurationSec,
        status: "success",
      });
      return result;
    }
  } catch (err: any) {
    console.error(`[transcribe] Groq failed:`, err);
    recordTranscription({
      sessionId: ctx?.sessionId,
      chatId: ctx?.chatId,
      provider: "groq",
      durationMs: Date.now() - groqStart,
      audioDurationSec: ctx?.audioDurationSec,
      status: "error",
      errorMessage: err?.message ?? String(err),
    });
  }

  // Fallback to kesha local ONNX ASR
  console.error(`[transcribe] falling back to kesha ASR`);
  const keshaStart = Date.now();
  try {
    const result = await transcribeKesha(audioBuffer, fileName);
    if (result) {
      console.error(`[transcribe] kesha ASR OK`);
      recordTranscription({
        sessionId: ctx?.sessionId,
        chatId: ctx?.chatId,
        provider: "kesha",
        durationMs: Date.now() - keshaStart,
        audioDurationSec: ctx?.audioDurationSec,
        status: "success",
      });
      return result;
    }
  } catch (err: any) {
    console.error(`[transcribe] kesha ASR failed:`, err);
    recordTranscription({
      sessionId: ctx?.sessionId,
      chatId: ctx?.chatId,
      provider: "kesha",
      durationMs: Date.now() - keshaStart,
      audioDurationSec: ctx?.audioDurationSec,
      status: "error",
      errorMessage: err?.message ?? String(err),
    });
  }

  // Fallback to local Whisper
  console.error(`[transcribe] falling back to local Whisper`);
  const whisperStart = Date.now();
  try {
    const result = await transcribeLocal(audioBuffer, fileName, mimeType);
    if (result) {
      console.error(`[transcribe] local Whisper OK`);
      recordTranscription({
        sessionId: ctx?.sessionId,
        chatId: ctx?.chatId,
        provider: "whisper",
        durationMs: Date.now() - whisperStart,
        audioDurationSec: ctx?.audioDurationSec,
        status: "success",
      });
      return result;
    }
  } catch (err: any) {
    console.error(`[transcribe] local Whisper failed:`, err);
    recordTranscription({
      sessionId: ctx?.sessionId,
      chatId: ctx?.chatId,
      provider: "whisper",
      durationMs: Date.now() - whisperStart,
      audioDurationSec: ctx?.audioDurationSec,
      status: "error",
      errorMessage: err?.message ?? String(err),
    });
  }

  return null;
}
