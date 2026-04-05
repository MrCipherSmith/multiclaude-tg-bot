import { sql } from "../memory/db.ts";

// --- Recording ---

export interface ApiRequestStat {
  sessionId?: number | null;
  chatId?: string | null;
  provider: string;
  model: string;
  operation: string; // "chat", "summarize"
  durationMs: number;
  status: "success" | "error";
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  errorMessage?: string | null;
}

export async function recordApiRequest(stat: ApiRequestStat): Promise<void> {
  try {
    await sql`
      INSERT INTO api_request_stats
        (session_id, chat_id, provider, model, operation, duration_ms, status,
         input_tokens, output_tokens, total_tokens, error_message)
      VALUES
        (${stat.sessionId ?? null}, ${stat.chatId ?? null}, ${stat.provider},
         ${stat.model}, ${stat.operation}, ${stat.durationMs}, ${stat.status},
         ${stat.inputTokens ?? null}, ${stat.outputTokens ?? null},
         ${stat.totalTokens ?? null}, ${stat.errorMessage ?? null})
    `;
  } catch (err) {
    console.error("[stats] failed to record api request:", err);
  }
}

export interface TranscriptionStat {
  sessionId?: number | null;
  chatId?: string | null;
  provider: string; // "groq" | "whisper"
  durationMs: number;
  audioDurationSec?: number | null;
  status: "success" | "error";
  errorMessage?: string | null;
}

export async function recordTranscription(stat: TranscriptionStat): Promise<void> {
  try {
    await sql`
      INSERT INTO transcription_stats
        (session_id, chat_id, provider, duration_ms, audio_duration_sec, status, error_message)
      VALUES
        (${stat.sessionId ?? null}, ${stat.chatId ?? null}, ${stat.provider},
         ${stat.durationMs}, ${stat.audioDurationSec ?? null},
         ${stat.status}, ${stat.errorMessage ?? null})
    `;
  } catch (err) {
    console.error("[stats] failed to record transcription:", err);
  }
}

export async function appendLog(
  sessionId: number | null,
  chatId: string,
  stage: string,
  message: string,
  level: "info" | "warn" | "error" = "info",
): Promise<void> {
  try {
    await sql`
      INSERT INTO request_logs (session_id, chat_id, level, stage, message)
      VALUES (${sessionId}, ${chatId}, ${level}, ${stage}, ${message})
    `;
  } catch (err) {
    console.error("[stats] failed to append log:", err);
  }
}

// --- Querying ---

const startupAt = new Date().toISOString();

interface TimeWindow {
  label: string;
  cutoff: string | null; // null = all-time
}

function getWindows(): TimeWindow[] {
  return [
    { label: "24h", cutoff: new Date(Date.now() - 24 * 3600 * 1000).toISOString() },
    { label: "startup", cutoff: startupAt },
    { label: "total", cutoff: null },
  ];
}

export async function getApiStats() {
  const windows = getWindows();
  const results: Record<string, any> = {};

  for (const w of windows) {
    const where = w.cutoff ? sql`WHERE created_at >= ${w.cutoff}` : sql``;

    const [summary] = await sql`
      SELECT
        count(*)::int as total,
        count(*) FILTER (WHERE status = 'success')::int as success,
        count(*) FILTER (WHERE status = 'error')::int as errors,
        coalesce(sum(input_tokens), 0)::int as input_tokens,
        coalesce(sum(output_tokens), 0)::int as output_tokens,
        coalesce(sum(total_tokens), 0)::int as total_tokens,
        coalesce(avg(duration_ms) FILTER (WHERE status = 'success'), 0)::int as avg_latency_ms
      FROM api_request_stats ${where}
    `;

    const byProvider = await sql`
      SELECT
        provider,
        model,
        count(*)::int as requests,
        coalesce(sum(total_tokens), 0)::int as tokens,
        coalesce(avg(duration_ms), 0)::int as avg_ms
      FROM api_request_stats ${where}
      GROUP BY provider, model
      ORDER BY requests DESC
    `;

    const bySession = await sql`
      SELECT
        s.session_id,
        sess.name as session_name,
        count(*)::int as requests,
        coalesce(sum(s.total_tokens), 0)::int as tokens,
        coalesce(avg(s.duration_ms), 0)::int as avg_ms
      FROM api_request_stats s
      LEFT JOIN sessions sess ON sess.id = s.session_id
      ${w.cutoff ? sql`WHERE s.created_at >= ${w.cutoff}` : sql``}
      GROUP BY s.session_id, sess.name
      ORDER BY requests DESC
    `;

    results[w.label] = { summary, byProvider, bySession };
  }

  return results;
}

export async function getTranscriptionStats() {
  const windows = getWindows();
  const results: Record<string, any> = {};

  for (const w of windows) {
    const where = w.cutoff ? sql`WHERE created_at >= ${w.cutoff}` : sql``;

    const [summary] = await sql`
      SELECT
        count(*)::int as total,
        count(*) FILTER (WHERE status = 'success')::int as success,
        count(*) FILTER (WHERE status = 'error')::int as errors,
        coalesce(avg(duration_ms) FILTER (WHERE status = 'success'), 0)::int as avg_latency_ms
      FROM transcription_stats ${where}
    `;

    const byProvider = await sql`
      SELECT
        provider,
        count(*)::int as requests,
        count(*) FILTER (WHERE status = 'success')::int as success,
        coalesce(avg(duration_ms), 0)::int as avg_ms
      FROM transcription_stats ${where}
      GROUP BY provider
      ORDER BY requests DESC
    `;

    results[w.label] = { summary, byProvider };
  }

  return results;
}

export async function getSessionLogs(sessionId: number, limit = 50) {
  return sql`
    SELECT level, stage, message, created_at
    FROM request_logs
    WHERE session_id = ${sessionId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

export async function getRecentLogs(limit = 50) {
  return sql`
    SELECT r.session_id, s.name as session_name, r.level, r.stage, r.message, r.created_at
    FROM request_logs r
    LEFT JOIN sessions s ON s.id = r.session_id
    ORDER BY r.created_at DESC
    LIMIT ${limit}
  `;
}

export async function getMessageStats() {
  const windows = getWindows();
  const results: Record<string, any> = {};

  for (const w of windows) {
    const where = w.cutoff ? sql`WHERE m.created_at >= ${w.cutoff}` : sql``;

    const bySession = await sql`
      SELECT
        m.session_id,
        s.name as session_name,
        count(*)::int as total,
        count(*) FILTER (WHERE m.role = 'user')::int as user_msgs,
        count(*) FILTER (WHERE m.role = 'assistant')::int as assistant_msgs
      FROM messages m
      LEFT JOIN sessions s ON s.id = m.session_id
      ${where}
      GROUP BY m.session_id, s.name
      ORDER BY total DESC
    `;

    results[w.label] = { bySession };
  }

  return results;
}
