/**
 * Kesha benchmark utilities.
 * When KESHA_BENCHMARK=true, runs current and kesha pipelines in parallel,
 * reports per-message stats and logs results to logs/kesha-benchmark.jsonl.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { CONFIG } from "../config.ts";
import { channelLogger } from "../logger.ts";
import { transcribeGroq, transcribeLocal, transcribeKesha } from "./transcribe.ts";
import { synthesizeCurrentOnly, synthesizeKesha } from "./tts.ts";

export interface AsrBenchResult {
  provider: string;
  latencyMs: number;
  heapDeltaMB: number;
  rssDeltaMB: number;
  text: string | null;
  charCount: number;
  success: boolean;
  error?: string;
}

export interface TtsBenchResult {
  provider: string;
  latencyMs: number;
  heapDeltaMB: number;
  rssDeltaMB: number;
  fileSizeKB: number;
  fmt: string;
  success: boolean;
  error?: string;
}

export interface BenchmarkEntry {
  ts: string;
  audioDurationSec?: number;
  sessionId?: number | null;
  chatId?: string | null;
  asr: AsrBenchResult[];
  tts: TtsBenchResult[];
}

function memDelta(before: NodeJS.MemoryUsage, after: NodeJS.MemoryUsage) {
  const mb = (n: number) => Math.round(n / 1024 / 1024 * 100) / 100;
  return {
    heapDeltaMB: mb(after.heapUsed - before.heapUsed),
    rssDeltaMB: mb(after.rss - before.rss),
  };
}

async function runAsr(
  fn: () => Promise<string | null>,
  provider: string,
): Promise<AsrBenchResult> {
  const memBefore = process.memoryUsage();
  const t0 = Date.now();
  let text: string | null = null;
  let error: string | undefined;
  try {
    text = await fn();
  } catch (err: any) {
    error = err?.message ?? String(err);
  }
  const mem = memDelta(memBefore, process.memoryUsage());
  return {
    provider,
    latencyMs: Date.now() - t0,
    ...mem,
    text,
    charCount: text?.length ?? 0,
    success: text !== null,
    error,
  };
}

async function runTts(
  fn: () => Promise<{ buf: Buffer; fmt: string; provider?: string } | null>,
  provider: string,
): Promise<TtsBenchResult & { buf?: Buffer; fmt?: string }> {
  const memBefore = process.memoryUsage();
  const t0 = Date.now();
  let result: { buf: Buffer; fmt: string; provider?: string } | null = null;
  let error: string | undefined;
  try {
    result = await fn();
  } catch (err: any) {
    error = err?.message ?? String(err);
  }
  const mem = memDelta(memBefore, process.memoryUsage());
  return {
    provider: result?.provider ?? provider,
    latencyMs: Date.now() - t0,
    ...mem,
    fileSizeKB: result ? Math.round(result.buf.length / 1024) : 0,
    fmt: result?.fmt ?? "—",
    success: result !== null,
    error,
    buf: result?.buf,
  };
}

/** Run current + kesha ASR in parallel. Returns both results. */
export async function runAsrBenchmark(
  audioBuffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
): Promise<AsrBenchResult[]> {
  const [current, kesha] = await Promise.all([
    runAsr(async () => {
      const groq = await transcribeGroq(audioBuffer, fileName, mimeType);
      if (groq) return groq;
      return transcribeLocal(audioBuffer, fileName, mimeType);
    }, "groq→whisper"),
    runAsr(() => transcribeKesha(audioBuffer, fileName), "kesha"),
  ]);
  return [current, kesha];
}

/** Run current + kesha TTS in parallel. Returns both results including audio buffers. */
export async function runTtsBenchmark(
  text: string,
  isRussian: boolean,
): Promise<Array<TtsBenchResult & { buf?: Buffer }>> {
  const [current, kesha] = await Promise.all([
    runTts(() => synthesizeCurrentOnly(text, isRussian), "current"),
    runTts(async () => {
      const buf = await synthesizeKesha(text, isRussian);
      return buf ? { buf, fmt: "wav", provider: "kesha" } : null;
    }, "kesha"),
  ]);
  return [current, kesha];
}

/** Word-level similarity between two strings (0–1). */
function wordSimilarity(a: string, b: string): number {
  const wa = a.toLowerCase().split(/\s+/).filter(Boolean);
  const wb = b.toLowerCase().split(/\s+/).filter(Boolean);
  if (wa.length === 0 && wb.length === 0) return 1;
  const setA = new Set(wa);
  const setB = new Set(wb);
  let common = 0;
  for (const w of setA) if (setB.has(w)) common++;
  return (2 * common) / (setA.size + setB.size);
}

/** Return up to maxDiffs segments where word sequences diverge. */
function wordDiff(refText: string, hypText: string, maxDiffs = 3): Array<{ ref: string; hyp: string }> {
  const ref = refText.split(/\s+/).filter(Boolean);
  const hyp = hypText.split(/\s+/).filter(Boolean);
  const diffs: Array<{ ref: string; hyp: string }> = [];
  let i = 0;
  let j = 0;
  while (i < ref.length && j < hyp.length && diffs.length < maxDiffs) {
    if (ref[i]!.toLowerCase().replace(/[^а-яёa-z]/gi, "") === hyp[j]!.toLowerCase().replace(/[^а-яёa-z]/gi, "")) {
      i++; j++;
    } else {
      // Collect diverging window (up to 5 words each side)
      const refSeg: string[] = [];
      const hypSeg: string[] = [];
      let ri = i, hi = j;
      while (ri < ref.length && refSeg.length < 5) refSeg.push(ref[ri++]!);
      while (hi < hyp.length && hypSeg.length < 5) hypSeg.push(hyp[hi++]!);
      diffs.push({ ref: refSeg.join(" "), hyp: hypSeg.join(" ") });
      i = ri; j = hi;
    }
  }
  return diffs;
}

/** Format ASR + TTS results into a human-readable Telegram message. */
export function formatBenchmarkReport(
  asr: AsrBenchResult[],
  tts: Array<TtsBenchResult & { buf?: Buffer }>,
  audioDurationSec?: number,
): string {
  const lines: string[] = ["📊 <b>Kesha Benchmark</b>"];

  if (asr.length > 0) {
    const durLabel = audioDurationSec ? ` (${audioDurationSec}s audio)` : "";
    lines.push(`\n🎤 <b>ASR${durLabel}</b>`);

    for (const r of asr) {
      const icon = r.success ? "✅" : "❌";
      const heap = r.heapDeltaMB >= 0 ? `+${r.heapDeltaMB}` : `${r.heapDeltaMB}`;
      const rtf = audioDurationSec && r.latencyMs
        ? ` | RTF ${(r.latencyMs / 1000 / audioDurationSec).toFixed(2)}x`
        : "";
      const chPerSec = audioDurationSec && r.charCount
        ? ` | ${(r.charCount / audioDurationSec).toFixed(1)} ch/s`
        : "";
      lines.push(
        `${icon} <code>${r.provider.padEnd(14)}</code> ${r.latencyMs}ms${rtf}${chPerSec} | ${r.charCount}ch | heap ${heap}MB`,
      );
      if (!r.success && r.error) lines.push(`   ⚠️ ${r.error.slice(0, 80)}`);
    }

    // Speed comparison
    const success = asr.filter(r => r.success);
    if (success.length >= 2) {
      const [first, second] = success;
      const ratio = (Math.max(first!.latencyMs, second!.latencyMs) / Math.min(first!.latencyMs, second!.latencyMs)).toFixed(1);
      const faster = first!.latencyMs < second!.latencyMs ? first!.provider : second!.provider;
      lines.push(`\n⚡ <b>${faster}</b> быстрее в <b>${ratio}×</b>`);

      // Text similarity and diff
      const sim = wordSimilarity(first!.text ?? "", second!.text ?? "");
      const simPct = Math.round(sim * 100);
      lines.push(`📝 Совпадение слов: <b>${simPct}%</b>`);

      if (simPct < 100 && first!.text && second!.text) {
        const diffs = wordDiff(first!.text, second!.text, 2);
        if (diffs.length > 0) {
          lines.push("\n🔍 <b>Расхождения:</b>");
          for (const d of diffs) {
            lines.push(`  Groq:  <i>"${d.ref}"</i>\n  Kesha: <i>"${d.hyp}"</i>`);
          }
        }
      }

      // Explanation why kesha is slower (only for ASR pair)
      if (second!.latencyMs > first!.latencyMs * 2) {
        lines.push(
          "\n💡 <b>Почему Kesha медленнее:</b>\n" +
          "• Локальный CPU ONNX (нет GPU)\n" +
          "• Модель Parakeet-TDT-v3 чанкует аудио (~6-10s чанки)\n" +
          "• Первый запуск: загрузка модели в RAM\n" +
          "• Groq — серверный Whisper с GPU, latency сети ~300ms"
        );
      }
    }
  }

  if (tts.length > 0) {
    lines.push("\n🔊 <b>TTS</b>");
    for (const r of tts) {
      const icon = r.success ? "✅" : "❌";
      const heap = r.heapDeltaMB >= 0 ? `+${r.heapDeltaMB}` : `${r.heapDeltaMB}`;
      const kbps = r.fileSizeKB && r.latencyMs
        ? ` | ${Math.round(r.fileSizeKB * 8 / (r.latencyMs / 1000))} kbps`
        : "";
      lines.push(
        `${icon} <code>${r.provider.padEnd(14)}</code> ${r.latencyMs}ms | ${r.fileSizeKB}KB ${r.fmt.toUpperCase()}${kbps} | heap ${heap}MB`,
      );
      if (!r.success && r.error) lines.push(`   ⚠️ ${r.error?.slice(0, 80)}`);
    }
    const successTts = tts.filter((r) => r.success);
    if (successTts.length >= 2) {
      const fastest = successTts.reduce((a, b) => (a.latencyMs < b.latencyMs ? a : b));
      const ratio = (Math.max(...successTts.map(r => r.latencyMs)) / fastest.latencyMs).toFixed(1);
      lines.push(`🏆 Быстрее: <b>${fastest.provider}</b> (${fastest.latencyMs}ms, в ${ratio}×)`);
    }
  }

  lines.push(`\n📁 <code>logs/kesha-benchmark.jsonl</code>`);
  return lines.join("\n");
}

const LOG_FILE = `${CONFIG.LOGS_DIR}/kesha-benchmark.jsonl`;

/** Append benchmark result to JSONL log file. */
export function appendBenchmarkLog(entry: BenchmarkEntry): void {
  try {
    mkdirSync(CONFIG.LOGS_DIR, { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    channelLogger.warn({ err }, "benchmark: failed to write log");
  }
}

export { detectRussian } from "./tts.ts";

/** Send a voice buffer to Telegram via raw HTTP. */
export async function sendTelegramVoice(
  token: string,
  chatId: string | number,
  buf: Buffer,
  fmt: string,
  threadId?: number | null,
  caption?: string,
): Promise<void> {
  const mimeType = fmt === "mp3" ? "audio/mpeg" : "audio/wav";
  const filename = fmt === "mp3" ? "voice.mp3" : "voice.wav";
  const makeForm = () => {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("voice", new Blob([buf], { type: mimeType }), filename);
    if (threadId) form.append("message_thread_id", String(threadId));
    if (caption) form.append("caption", caption);
    return form;
  };
  const send = () => fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
    method: "POST",
    body: makeForm(),
  });
  try {
    let res = await send();
    if (res.status === 429) {
      let retryAfter = 5;
      try {
        const body = await res.json() as { parameters?: { retry_after?: number } };
        retryAfter = body.parameters?.retry_after ?? 5;
      } catch { /* use default */ }
      channelLogger.warn({ chatId, retryAfter }, "benchmark: sendVoice 429, retrying");
      await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
      res = await send();
    }
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      channelLogger.warn({ status: res.status, err, fmt }, "benchmark: sendVoice failed");
    } else {
      channelLogger.info({ chatId, threadId, fmt, caption }, "benchmark: voice sent ok");
    }
  } catch (err) {
    channelLogger.warn({ err }, "benchmark: sendTelegramVoice failed");
  }
}
