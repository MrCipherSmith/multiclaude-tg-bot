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

/** POST to Telegram API with one 429-retry. Returns parsed JSON or null on error. */
async function tgPost(method: string, body: Record<string, unknown>): Promise<any | null> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const opts = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  };
  let res = await fetch(url, opts);
  if (res.status === 429) {
    let wait = 6;
    try {
      const data = await res.json() as { parameters?: { retry_after?: number } };
      wait = (data.parameters?.retry_after ?? 5) + 1;
    } catch { /* use default */ }
    console.error(`[supervisor] tgPost ${method} 429 — retrying in ${wait}s`);
    await new Promise(r => setTimeout(r, wait * 1000));
    res = await fetch(url, opts);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`[supervisor] tgPost ${method} failed: ${res.status} ${errText.slice(0, 150)}`);
    return null;
  }
  return res.json().catch(() => null);
}

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
    await tgPost("sendMessage", body);
  } catch {
    // Non-blocking
  }
}

async function editTelegramMsg(chatId: string, messageId: number, text: string, threadId?: number | null): Promise<void> {
  if (!BOT_TOKEN) return;
  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
  if (threadId) body.message_thread_id = threadId;
  try {
    await tgPost("editMessageText", body);
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
  const system = `Ты — компонент мониторинга Telegram-бота Helyx. Твоя единственная задача: кратко объяснить инцидент в 1-2 предложениях на русском языке. Не рассуждай, не задавай вопросы, не выходи за рамки описания инцидента. Отвечай только фактами о произошедшем.`;

  const userMsg = `Инцидент: ${incidentType}
Проект: ${project}
Прошло: ${Math.round(elapsedSec / 60)}m ${elapsedSec % 60}s
Действие: ${actionTaken}
Результат: ${result}

Объясни кратко что произошло и что было сделано.`;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemma4:e4b",
        think: false,
        messages: [
          { role: "system", content: system },
          { role: "user",   content: userMsg },
        ],
        stream: false,
        options: { num_predict: 120, temperature: 0.3 },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return "";
    const data = await res.json() as { message?: { content?: string } };
    return (data.message?.content ?? "").trim();
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

// --- Verify session recovery (poll active_status_messages heartbeat) ---

async function verifyRecovery(sql: postgres.Sql, sessionId: number): Promise<boolean> {
  const deadline = Date.now() + 60_000; // wait up to 60s
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5_000));
    const [row] = await sql`
      SELECT 1 FROM active_status_messages
      WHERE session_id = ${sessionId}
        AND updated_at > NOW() - INTERVAL '30 seconds'
    `;
    if (row) return true;
  }
  return false;
}

// --- Send alert with inline keyboard buttons ---

async function sendAlertWithButtons(
  text: string,
  buttons: Array<Array<{ text: string; callback_data: string }>>,
): Promise<number | null> {
  if (!BOT_TOKEN || !SUPERVISOR_CHAT_ID) {
    console.error("[supervisor] alert (no Telegram):", text.replace(/<[^>]+>/g, ""));
    return null;
  }
  const body: Record<string, unknown> = {
    chat_id: SUPERVISOR_CHAT_ID,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  };
  if (SUPERVISOR_TOPIC_ID) body.message_thread_id = SUPERVISOR_TOPIC_ID;
  const result = await tgPost("sendMessage", body).catch(() => null);
  return result?.result?.message_id ?? null;
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

      const isEscalation = recoveryAttempts.has(dedupKey) &&
        Date.now() - (recoveryAttempts.get(dedupKey)!.firstDetected) > ESCALATE_MS;

      const rec = recoveryAttempts.get(dedupKey) ?? { attempts: 0, firstDetected: Date.now() };
      rec.attempts++;
      recoveryAttempts.set(dedupKey, rec);

      // 1. Send initial alert (before restart, so user sees something immediately)
      if (shouldAlert(dedupKey)) {
        const header = isEscalation
          ? `⛔ <b>Supervisor: ESCALATION — сессия зависла</b>`
          : `⚠️ <b>Supervisor: сессия зависла</b>`;
        const initMsg = [
          header,
          `Проект: <code>${project}</code>`,
          `Зависание: ${Math.round(elapsedSec / 60)}m ${elapsedSec % 60}s`,
          `⏳ <i>Перезапускаю...</i>`,
          isEscalation ? "\n🔧 <i>Требует ручного вмешательства</i>" : "",
        ].filter(Boolean).join("\n");
        await sendAlert(initMsg);
      }

      // 2. Trigger restart
      let actionResult = "no path configured";
      if (projectPath) {
        const res = await triggerProjStart(sql, projectPath);
        actionResult = res.result;
        console.log(`[supervisor] proj_start result for ${project}: ${actionResult}`);
      }

      // 3. Verify recovery (poll 60s)
      const recovered = projectPath ? await verifyRecovery(sql, sessionId) : false;

      const llm = await getLlmExplanation(
        "hung_session", project, elapsedSec,
        projectPath ? `proj_start: ${projectPath}` : "no action (no project path)",
        recovered ? "recovered" : actionResult,
      );

      await logIncident(sql, "hung_session", project, sessionId, "proj_start",
        recovered ? "recovered" : actionResult, llm);

      // 4. Send recovery result
      if (recovered) {
        await sendAlert(`✅ <b>Сессия восстановлена</b>\nПроект: <code>${project}</code>${llm ? `\n\n💬 ${llm}` : ""}`);
        recoveryAttempts.delete(dedupKey);
      } else {
        const failMsg = [
          `⛔ <b>Сессия не восстановилась</b>`,
          `Проект: <code>${project}</code>`,
          `Результат: ${actionResult}`,
          llm ? `\n💬 ${llm}` : "",
          `\n🔧 <i>Требуется ручное вмешательство</i>`,
        ].filter(Boolean).join("\n");
        await sendAlertWithButtons(failMsg, [[
          { text: "🔄 Повторить", callback_data: `sup:restart_session:${sessionId}` },
        ]]);
      }
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

      if (!shouldAlert(dedupKey)) continue;

      await logIncident(sql, "stuck_queue", project, sessionId, "alert_sent", "pending_user_action", "");

      const msg = [
        `⚠️ <b>Supervisor: очередь зависла</b>`,
        `Проект: <code>${project}</code>`,
        `Старейшее сообщение: ${Math.round(oldestSec / 60)}m ${oldestSec % 60}s`,
        `В очереди необработанных сообщений — требуется перезапуск сессии.`,
      ].join("\n");

      await sendAlertWithButtons(msg, [[
        { text: "🔄 Перезапустить", callback_data: `sup:restart_session:${sessionId}` },
        { text: "✅ Игнорировать",  callback_data: `sup:ignore:${dedupKey}` },
      ]]);
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

// --- Loop 4: 5-minute full status broadcast ---

let statusMessageId: number | null = null; // edit existing message instead of spamming

async function sendStatusBroadcast(sql: postgres.Sql, runShell: RunShell): Promise<void> {
  try {
    const now = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

    // --- Docker status ---
    const dockerResult = await runShell(`docker ps --format "{{.Names}}\t{{.Status}}" 2>/dev/null || true`);
    const dockerLines: string[] = [];
    for (const line of dockerResult.output.split("\n").filter(Boolean)) {
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const name = line.slice(0, tab).trim();
      const status = line.slice(tab + 1).trim();
      const running = !status.toLowerCase().startsWith("exited") && !status.toLowerCase().startsWith("dead");
      dockerLines.push(`${running ? "🟢" : "🔴"} ${name} — <i>${status}</i>`);
    }

    // --- Session states ---
    const sessions = await sql`
      SELECT
        s.id,
        s.project,
        s.project_path,
        s.status,
        s.last_active,
        asm.updated_at AS asm_updated,
        (
          SELECT COUNT(*) FROM message_queue mq
          WHERE mq.session_id = s.id AND mq.delivered = false
        ) AS pending_msgs
      FROM sessions s
      LEFT JOIN active_status_messages asm ON asm.session_id = s.id
      WHERE s.status = 'active' AND s.id != 0
      ORDER BY s.project
    `;

    const sessionLines: string[] = [];
    for (const row of sessions) {
      const project = String(row.project ?? "?");
      const pendingMsgs = Number(row.pending_msgs ?? 0);
      const asmUpdated = row.asm_updated ? new Date(row.asm_updated) : null;
      const lastActive = row.last_active ? new Date(row.last_active) : null;
      const idleSec = lastActive ? Math.floor((Date.now() - lastActive.getTime()) / 1000) : null;

      let stateIcon: string;
      let stateText: string;

      if (asmUpdated && Date.now() - asmUpdated.getTime() < 2 * 60 * 1000) {
        // Fresh heartbeat in active_status_messages → Claude is actively working
        const elapsed = Math.floor((Date.now() - asmUpdated.getTime()) / 1000);
        stateIcon = "🔄";
        stateText = `работает (heartbeat ${elapsed}s назад)`;
      } else if (pendingMsgs > 0) {
        // Has pending messages in queue
        stateIcon = "📨";
        stateText = `${pendingMsgs} сообщ. в очереди`;
      } else if (idleSec !== null && idleSec < 60) {
        stateIcon = "🟢";
        stateText = `активна только что`;
      } else {
        // Idle
        const idleStr = idleSec === null ? "?" :
          idleSec < 3600 ? `${Math.floor(idleSec / 60)}m` : `${Math.floor(idleSec / 3600)}h`;
        stateIcon = "⚪";
        stateText = `ожидание (idle ${idleStr})`;
      }

      sessionLines.push(`${stateIcon} <b>${project}</b> — ${stateText}`);
    }

    // --- Queue summary ---
    const [qRow] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE delivered = false) AS pending,
        COUNT(*) FILTER (WHERE delivered = false AND created_at < NOW() - INTERVAL '5 minutes') AS stuck
      FROM message_queue
    `;
    const pendingTotal = Number((qRow as any)?.pending ?? 0);
    const stuckTotal = Number((qRow as any)?.stuck ?? 0);

    // --- Supervisor stats ---
    const uptimeMin = Math.floor((Date.now() - SUPERVISOR_START) / 60_000);

    // --- Build message ---
    const lines: string[] = [
      `🖥 <b>Статус системы</b> — ${now}`,
      "",
    ];

    if (dockerLines.length > 0) {
      lines.push("<b>Docker:</b>", ...dockerLines, "");
    }

    if (sessionLines.length > 0) {
      lines.push(`<b>Сессии (${sessionLines.length}):</b>`, ...sessionLines, "");
    } else {
      lines.push("Активных сессий нет", "");
    }

    const queueStatus = stuckTotal > 0
      ? `⚠️ ${pendingTotal} pending, ${stuckTotal} зависших`
      : pendingTotal > 0
        ? `📨 ${pendingTotal} pending`
        : "✅ очередь пуста";
    lines.push(`<b>Очередь:</b> ${queueStatus}`);
    lines.push(`<b>Супервизор:</b> 🛡 uptime ${uptimeMin}m · инцидентов: ${incidentCount}`);

    if (stuckTotal > 0) {
      lines.push("", `⚠️ Зависших сообщений: ${stuckTotal}. Использую proj_start для восстановления...`);
    }

    const text = lines.join("\n");

    // Try to edit the previous status message; if fails, send new
    if (statusMessageId && BOT_TOKEN && SUPERVISOR_CHAT_ID) {
      const editBody: Record<string, unknown> = {
        chat_id: SUPERVISOR_CHAT_ID,
        message_id: statusMessageId,
        text,
        parse_mode: "HTML",
      };
      if (SUPERVISOR_TOPIC_ID) editBody.message_thread_id = SUPERVISOR_TOPIC_ID;
      const editResult = await tgPost("editMessageText", editBody);
      if (editResult?.ok) {
        console.error("[supervisor] status message updated");
        return;
      }
      // Edit failed (message too old or deleted) — fall through to send new
      statusMessageId = null;
    }

    // Send new status message
    if (!BOT_TOKEN || !SUPERVISOR_CHAT_ID) {
      console.error("[supervisor] status broadcast (no Telegram):", text.replace(/<[^>]+>/g, ""));
      return;
    }
    const sendBody: Record<string, unknown> = {
      chat_id: SUPERVISOR_CHAT_ID,
      text,
      parse_mode: "HTML",
    };
    if (SUPERVISOR_TOPIC_ID) sendBody.message_thread_id = SUPERVISOR_TOPIC_ID;
    const sendResult = await tgPost("sendMessage", sendBody);
    if (sendResult?.result?.message_id) {
      statusMessageId = sendResult.result.message_id;
      console.error("[supervisor] status broadcast sent (msg_id:", statusMessageId, ")");
    }
  } catch (err: any) {
    console.error(`[supervisor] sendStatusBroadcast error: ${err?.message}`);
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

export function startSupervisor(sql: postgres.Sql, runShell: RunShell): void {
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

  // Loop 4: Full status broadcast — every 5 min
  const statusTimer = setInterval(() => sendStatusBroadcast(sql, runShell).catch(() => {}), 5 * 60_000);
  statusTimer.unref?.();

  // Heartbeat to process_health — every 30s
  const healthTimer = setInterval(() => updateProcessHealth(sql).catch(() => {}), 30_000);
  healthTimer.unref?.();

  // Run initial checks after a short delay (let admin-daemon settle first)
  setTimeout(() => {
    checkHungSessions(sql).catch(() => {});
    cleanVoiceStatuses(sql).catch(() => {});
    updateProcessHealth(sql).catch(() => {});
    // First status broadcast after 30s settle time
    setTimeout(() => sendStatusBroadcast(sql, runShell).catch(() => {}), 20_000);
  }, 10_000);

  console.log("[supervisor] watchdog running (session:60s, queue:60s, voice:5min, status:5min)");
}
