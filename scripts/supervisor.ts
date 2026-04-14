/**
 * Helyx Session Supervisor
 *
 * Monitors all session-related health indicators and performs automatic recovery.
 * Inspired by OpenClaw Gateway: central control plane with retry policy,
 * session health tracking, and multi-agent routing.
 *
 * Runs inside admin-daemon.ts as additional setInterval loops,
 * sharing the existing DB connection and shell utilities.
 *
 * Monitoring loops:
 *  1. Session heartbeat — active_status_messages.updated_at stale >2 min → proj_start
 *  2. Queue stuck       — message_queue pending >5 min → proj_start
 *  3. Voice cleanup     — voice_status_messages >3 min → edit Telegram + delete
 *  4. Health-OK pulse   — hourly "all good" report (if no incidents in last hour)
 *
 * Alerting: Telegram topic SUPERVISOR_CHAT_ID / SUPERVISOR_TOPIC_ID (from .env).
 *           If not set, alerts are logged only.
 *
 * LLM diagnosis: qwen3:8b via Ollama (timeout 10s, non-blocking).
 */

import type postgres from "postgres";

// --- Config (read from env, not from CONFIG to avoid circular imports in admin-daemon) ---
const SUPERVISOR_CHAT_ID  = process.env.SUPERVISOR_CHAT_ID  ?? "";
const SUPERVISOR_TOPIC_ID = Number(process.env.SUPERVISOR_TOPIC_ID ?? "0");
const BOT_TOKEN           = process.env.TELEGRAM_BOT_TOKEN  ?? "";
const OLLAMA_URL          = process.env.OLLAMA_URL ?? "http://localhost:11434";

// Thresholds
const SESSION_STALE_MS  = 2 * 60 * 1000;   // 2 min — heartbeat timeout
const QUEUE_STUCK_MS    = 5 * 60 * 1000;   // 5 min — queue unprocessed
const VOICE_STALE_MS    = 3 * 60 * 1000;   // 3 min — voice download timeout
const ESCALATE_MS       = 30 * 60 * 1000;  // 30 min — escalation threshold

// Alert dedup: key → last alerted timestamp
const alertedAt = new Map<string, number>();
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 min dedup window

// Incident recovery attempt tracking: sessionId → { attempts, firstDetected }
const recoveryAttempts = new Map<string, { attempts: number; firstDetected: number }>();

// Supervisor start time for uptime tracking
const SUPERVISOR_START = Date.now();
let incidentCount = 0;
let lastIncidentAt: number | null = null;
let lastHealthyAt: number | null = null;

// Shell util signature (injected from admin-daemon)
type RunShell = (cmd: string) => Promise<{ ok: boolean; output: string }>;

// --- Telegram helpers ---

async function sendAlert(text: string, topicId?: number): Promise<void> {
  if (!BOT_TOKEN || !SUPERVISOR_CHAT_ID) return;

  const body: Record<string, unknown> = {
    chat_id: SUPERVISOR_CHAT_ID,
    text,
    parse_mode: "HTML",
  };
  const tid = topicId ?? (SUPERVISOR_TOPIC_ID > 0 ? SUPERVISOR_TOPIC_ID : undefined);
  if (tid) body.message_thread_id = tid;

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) {
      const data = await res.json() as { parameters?: { retry_after?: number } };
      const wait = (data.parameters?.retry_after ?? 5) + 1;
      await new Promise(r => setTimeout(r, wait * 1000));
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    }
  } catch {
    // Non-blocking — alert delivery failure doesn't crash supervisor
  }
}

async function editTelegramMsg(chatId: string, messageId: number, text: string, threadId?: number | null): Promise<void> {
  if (!BOT_TOKEN) return;
  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
  if (threadId) body.message_thread_id = threadId;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* best-effort */ }
}

// --- LLM diagnosis ---

async function getLlmExplanation(
  incidentType: string,
  project: string,
  elapsedSec: number,
  actionTaken: string,
  result: string,
): Promise<string> {
  const prompt = `You are a Telegram bot monitoring assistant. Briefly explain in 2-3 sentences what happened and what was done. Use simple language. Answer in Russian.

Incident: ${incidentType}
Project: ${project}
Elapsed: ${Math.round(elapsedSec / 60)}m ${elapsedSec % 60}s
Action: ${actionTaken}
Result: ${result}`;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3:8b", prompt, stream: false, options: { num_predict: 120 } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return "";
    const data = await res.json() as { response?: string };
    return (data.response ?? "").trim();
  } catch {
    return "";
  }
}

// --- Dedup check ---

function shouldAlert(key: string): boolean {
  const last = alertedAt.get(key) ?? 0;
  if (Date.now() - last < DEDUP_WINDOW_MS) return false;
  alertedAt.set(key, Date.now());
  return true;
}

// --- Insert admin_command for proj_start ---

async function triggerProjStart(
  sql: postgres.Sql,
  projectPath: string,
): Promise<{ ok: boolean; result: string }> {
  try {
    const [row] = await sql`
      INSERT INTO admin_commands (command, payload)
      VALUES ('proj_start', ${sql.json({ path: projectPath })})
      RETURNING id
    `;
    const id = row?.id;
    if (!id) return { ok: false, result: "insert failed" };

    // Poll for completion (max 30s)
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const [statusRow] = await sql`
        SELECT status, result FROM admin_commands WHERE id = ${id}
      `;
      if (!statusRow) break;
      if (statusRow.status === "done")  return { ok: true,  result: String(statusRow.result ?? "done") };
      if (statusRow.status === "error") return { ok: false, result: String(statusRow.result ?? "error") };
    }
    return { ok: false, result: "timeout waiting for admin-daemon" };
  } catch (err: any) {
    return { ok: false, result: err?.message ?? "db error" };
  }
}

// --- Log incident to DB ---

async function logIncident(
  sql: postgres.Sql,
  type: string,
  project: string | null,
  sessionId: number | null,
  actionTaken: string,
  result: string,
  llmExplanation: string,
): Promise<void> {
  incidentCount++;
  lastIncidentAt = Date.now();
  try {
    await sql`
      INSERT INTO supervisor_incidents
        (incident_type, project, session_id, action_taken, result, llm_explanation, resolved_at)
      VALUES
        (${type}, ${project}, ${sessionId}, ${actionTaken}, ${result}, ${llmExplanation || null},
         ${result.includes("done") || result.includes("ok") ? sql`NOW()` : null})
    `;
  } catch { /* non-blocking */ }
}

// --- Loop 1: Session heartbeat monitor ---

async function checkHungSessions(sql: postgres.Sql): Promise<void> {
  try {
    const rows = await sql`
      SELECT
        s.id         AS session_id,
        s.project    AS project,
        s.project_path,
        asm.key,
        asm.started_at,
        asm.updated_at
      FROM sessions s
      JOIN active_status_messages asm ON asm.session_id = s.id
      WHERE s.status = 'active'
        AND asm.updated_at < NOW() - INTERVAL '2 minutes'
    `;

    for (const row of rows) {
      const project = String(row.project ?? "unknown");
      const projectPath = String(row.project_path ?? "");
      const sessionId = Number(row.session_id);
      const elapsedMs = Date.now() - new Date(row.updated_at).getTime();
      const elapsedSec = Math.round(elapsedMs / 1000);
      const dedupKey = `hung_session:${project}`;

      console.log(`[supervisor] hung session detected: ${project} (stale ${elapsedSec}s)`);

      let actionResult = "no path configured";
      if (projectPath) {
        const res = await triggerProjStart(sql, projectPath);
        actionResult = res.result;
        console.log(`[supervisor] proj_start result for ${project}: ${actionResult}`);
      }

      const llm = await getLlmExplanation(
        "hung_session", project, elapsedSec,
        projectPath ? `proj_start: ${projectPath}` : "no action (no project path)",
        actionResult,
      );

      await logIncident(sql, "hung_session", project, sessionId, "proj_start", actionResult, llm);

      if (!shouldAlert(dedupKey)) continue;

      const isEscalation = recoveryAttempts.has(dedupKey) &&
        Date.now() - (recoveryAttempts.get(dedupKey)!.firstDetected) > ESCALATE_MS;

      const rec = recoveryAttempts.get(dedupKey) ?? { attempts: 0, firstDetected: Date.now() };
      rec.attempts++;
      recoveryAttempts.set(dedupKey, rec);

      const header = isEscalation
        ? `⛔ <b>Supervisor: ESCALATION — hung session</b>`
        : `⚠️ <b>Supervisor: hung session</b>`;

      const msg = [
        header,
        `Проект: <code>${project}</code>`,
        `Зависание: ${Math.round(elapsedSec / 60)}m ${elapsedSec % 60}s`,
        `Действие: proj_start`,
        `Результат: ${actionResult}`,
        llm ? `\n💬 ${llm}` : "",
        isEscalation ? "\n🔧 <i>Требует ручного вмешательства</i>" : "",
      ].filter(Boolean).join("\n");

      await sendAlert(msg);
    }
  } catch (err: any) {
    console.error(`[supervisor] checkHungSessions error: ${err?.message}`);
  }
}

// --- Loop 2: Stuck queue monitor ---

async function checkStuckQueue(sql: postgres.Sql): Promise<void> {
  try {
    const rows = await sql`
      SELECT
        mq.session_id,
        s.project,
        s.project_path,
        MIN(mq.created_at) AS oldest_pending
      FROM message_queue mq
      JOIN sessions s ON s.id = mq.session_id
      WHERE mq.delivered = false
        AND mq.created_at < NOW() - INTERVAL '5 minutes'
      GROUP BY mq.session_id, s.project, s.project_path
    `;

    for (const row of rows) {
      const project = String(row.project ?? "unknown");
      const projectPath = String(row.project_path ?? "");
      const sessionId = Number(row.session_id);
      const oldestMs = Date.now() - new Date(row.oldest_pending).getTime();
      const oldestSec = Math.round(oldestMs / 1000);
      const dedupKey = `stuck_queue:${project}`;

      console.log(`[supervisor] stuck queue: ${project} (oldest msg ${oldestSec}s)`);

      let actionResult = "no path configured";
      if (projectPath) {
        const res = await triggerProjStart(sql, projectPath);
        actionResult = res.result;
      }

      const llm = await getLlmExplanation(
        "stuck_queue", project, oldestSec,
        projectPath ? `proj_start: ${projectPath}` : "no action",
        actionResult,
      );

      await logIncident(sql, "stuck_queue", project, sessionId, "proj_start", actionResult, llm);

      if (!shouldAlert(dedupKey)) continue;

      const msg = [
        `⚠️ <b>Supervisor: stuck queue</b>`,
        `Проект: <code>${project}</code>`,
        `Старейшее сообщение: ${Math.round(oldestSec / 60)}m ${oldestSec % 60}s`,
        `Действие: proj_start`,
        `Результат: ${actionResult}`,
        llm ? `\n💬 ${llm}` : "",
      ].filter(Boolean).join("\n");

      await sendAlert(msg);
    }
  } catch (err: any) {
    console.error(`[supervisor] checkStuckQueue error: ${err?.message}`);
  }
}

// --- Loop 3: Voice status recovery ---

async function cleanVoiceStatuses(sql: postgres.Sql): Promise<void> {
  try {
    const rows = await sql`
      SELECT id, chat_id, thread_id, message_id
      FROM voice_status_messages
      WHERE created_at < NOW() - INTERVAL '3 minutes'
    `;

    for (const row of rows) {
      await editTelegramMsg(
        String(row.chat_id),
        Number(row.message_id),
        "⚠️ Бот перезапущен — голосовое не обработано. Отправь повторно.",
        row.thread_id ? Number(row.thread_id) : null,
      );
      await sql`DELETE FROM voice_status_messages WHERE id = ${row.id}`;
      console.log(`[supervisor] voice status cleaned: chat ${row.chat_id} msg ${row.message_id}`);
    }
  } catch (err: any) {
    console.error(`[supervisor] cleanVoiceStatuses error: ${err?.message}`);
  }
}

// --- Loop 4: Hourly health-OK pulse ---

async function sendHealthPulse(sql: postgres.Sql): Promise<void> {
  // Only send if no incidents in the last hour
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  if (lastIncidentAt && lastIncidentAt > oneHourAgo) return;

  try {
    const [qRow] = await sql`
      SELECT COUNT(*) AS cnt FROM message_queue WHERE delivered = false
    `;
    const [sRow] = await sql`
      SELECT COUNT(*) AS cnt FROM sessions WHERE status = 'active'
    `;
    const pendingCount = Number((qRow as any)?.cnt ?? 0);
    const activeCount = Number((sRow as any)?.cnt ?? 0);

    const now = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    const uptimeMs = Date.now() - SUPERVISOR_START;
    const uptimeMin = Math.floor(uptimeMs / 60_000);

    const msg = [
      `✅ <b>Supervisor: всё в норме</b> — ${now}`,
      `Сессии: ${activeCount} активных`,
      `Очередь: ${pendingCount} pending`,
      `Инцидентов: ${incidentCount}`,
      `Uptime: ${uptimeMin}m`,
    ].join("\n");

    await sendAlert(msg);
    lastHealthyAt = Date.now();
    console.log(`[supervisor] health pulse sent (${activeCount} sessions, ${pendingCount} pending)`);
  } catch (err: any) {
    console.error(`[supervisor] sendHealthPulse error: ${err?.message}`);
  }
}

// --- Heartbeat to process_health ---

async function updateProcessHealth(sql: postgres.Sql): Promise<void> {
  const uptimeMs = Date.now() - SUPERVISOR_START;
  try {
    await sql`
      INSERT INTO process_health (name, status, detail, updated_at)
      VALUES (
        'supervisor',
        'running',
        ${sql.json({ uptime_ms: uptimeMs, incident_count: incidentCount, last_incident_at: lastIncidentAt })},
        NOW()
      )
      ON CONFLICT (name) DO UPDATE
        SET status = 'running', detail = EXCLUDED.detail, updated_at = NOW()
    `;
  } catch { /* non-blocking */ }
}

// --- Main entry point ---

export function startSupervisor(sql: postgres.Sql, _runShell: RunShell): void {
  console.log("[supervisor] starting session health watchdog...");
  if (!SUPERVISOR_CHAT_ID || !SUPERVISOR_TOPIC_ID) {
    console.warn("[supervisor] SUPERVISOR_CHAT_ID or SUPERVISOR_TOPIC_ID not set — alerts will be logged only");
  }

  // Loop 1: Session heartbeat — every 60s
  const sessionTimer = setInterval(() => checkHungSessions(sql).catch(() => {}), 60_000);
  sessionTimer.unref?.();

  // Loop 2: Stuck queue — every 60s (offset 15s from session loop to spread DB load)
  setTimeout(() => {
    checkStuckQueue(sql).catch(() => {});
    const queueTimer = setInterval(() => checkStuckQueue(sql).catch(() => {}), 60_000);
    queueTimer.unref?.();
  }, 15_000);

  // Loop 3: Voice cleanup — every 5 min
  const voiceTimer = setInterval(() => cleanVoiceStatuses(sql).catch(() => {}), 5 * 60_000);
  voiceTimer.unref?.();

  // Loop 4: Health pulse — every 1 hour
  const pulseTimer = setInterval(() => sendHealthPulse(sql).catch(() => {}), 60 * 60_000);
  pulseTimer.unref?.();

  // Heartbeat to process_health — every 30s
  const healthTimer = setInterval(() => updateProcessHealth(sql).catch(() => {}), 30_000);
  healthTimer.unref?.();

  // Run initial checks after a short delay (let admin-daemon settle first)
  setTimeout(() => {
    checkHungSessions(sql).catch(() => {});
    cleanVoiceStatuses(sql).catch(() => {});
    updateProcessHealth(sql).catch(() => {});
  }, 10_000);

  console.log("[supervisor] watchdog running (session:60s, queue:60s, voice:5min, pulse:1h)");
}
