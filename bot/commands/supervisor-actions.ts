/**
 * Supervisor topic handlers:
 * - handleSupervisorCallback: inline button callbacks (sup:restart_session, sup:ignore)
 * - handleSupervisorMessage: text messages in supervisor topic (/status, ?, статус)
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sql } from "../../memory/db.ts";

export async function handleSupervisorCallback(ctx: Context): Promise<void> {
  // Only the configured admin chat may trigger supervisor actions
  const adminChatId = String(process.env.TELEGRAM_CHAT_ID ?? "");
  if (adminChatId && String(ctx.chat?.id) !== adminChatId) {
    await ctx.answerCallbackQuery({ text: "Unauthorized" });
    return;
  }

  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");
  const action = parts[1];

  if (action === "restart_session") {
    const sessionId = parts[2];
    if (!sessionId) { await ctx.answerCallbackQuery({ text: "Нет ID сессии" }); return; }

    const [session] = await sql`
      SELECT project_path, project FROM sessions WHERE id = ${sessionId}
    `.catch(() => []);

    if (!session) {
      await ctx.answerCallbackQuery({ text: "Сессия не найдена" });
      return;
    }

    if (!session.project_path) {
      await ctx.answerCallbackQuery({ text: "Нет project_path для этой сессии" });
      return;
    }

    await sql`
      INSERT INTO admin_commands (command, payload)
      VALUES ('proj_start', ${sql.json({ path: session.project_path })})
    `;

    await ctx.answerCallbackQuery({ text: `⏳ Запускаю ${session.project}...` });
    await ctx.editMessageReplyMarkup({
      reply_markup: new InlineKeyboard().text("⏳ Перезапускается...", "sup:noop"),
    }).catch(() => {});
    return;
  }

  if (action === "ignore") {
    await ctx.answerCallbackQuery({ text: "Игнорируется" });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    return;
  }

  if (action === "ack") {
    const key = parts.slice(2).join(":");
    const durationMin = 30;
    await sql`
      INSERT INTO admin_commands (command, payload)
      VALUES ('supervisor_ack', ${sql.json({ key, until_ms: Date.now() + durationMin * 60_000 })})
    `.catch(() => {});
    await ctx.answerCallbackQuery({ text: `🔕 Тишина на ${durationMin} мин` });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    return;
  }

  if (action === "bounce") {
    await sql`
      INSERT INTO admin_commands (command, payload)
      VALUES ('bounce', ${sql.json({})})
    `.catch(() => {});
    await ctx.answerCallbackQuery({ text: "🚀 Bounce запущен" });
    await ctx.editMessageReplyMarkup({
      reply_markup: new InlineKeyboard().text("🚀 Bouncing...", "sup:noop"),
    }).catch(() => {});
    return;
  }

  if (action === "noop") {
    await ctx.answerCallbackQuery();
    return;
  }

  await ctx.answerCallbackQuery({ text: "Неизвестное действие" });
}

export async function handleSupervisorCommand(ctx: Context): Promise<void> {
  return handleSupervisorMessage(ctx);
}

export async function handleSupervisorMessage(ctx: Context): Promise<void> {
  const text = (ctx.message?.text ?? "").toLowerCase().trim();

  // Respond to any message in the supervisor topic (status queries and general questions)
  // — this topic is supervisor-only, so all text gets a status response
  const isIgnored = !text; // skip empty
  if (isIgnored) return;

  const [sessions, qRow, health, incRow] = await Promise.all([
    sql`
      SELECT
        s.id, s.project, s.last_active,
        asm.updated_at AS asm_updated,
        (
          SELECT COUNT(*) FROM message_queue mq
          WHERE mq.session_id = s.id AND mq.delivered = false
        ) AS pending
      FROM sessions s
      LEFT JOIN active_status_messages asm ON asm.session_id = s.id
      WHERE s.status = 'active' AND s.id != 0
      ORDER BY s.project
    `,
    sql`
      SELECT
        COUNT(*) FILTER (WHERE delivered = false) AS pending,
        COUNT(*) FILTER (WHERE delivered = false AND created_at < NOW() - INTERVAL '5 minutes') AS stuck
      FROM message_queue
    `,
    sql`SELECT name, status, updated_at, detail FROM process_health ORDER BY name`,
    sql`
      SELECT
        COUNT(*) FILTER (WHERE detected_at > NOW() - INTERVAL '1 hour')  AS last_hour,
        COUNT(*) FILTER (WHERE detected_at > NOW() - INTERVAL '24 hours') AS last_day
      FROM supervisor_incidents
    `.catch(() => [{ last_hour: 0, last_day: 0 }]),
  ]);

  const now = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const lines: string[] = [`🖥 <b>Статус системы</b> — ${now}`, ""];

  // --- Sessions ---
  if (sessions.length > 0) {
    lines.push(`<b>Сессии (${sessions.length}):</b>`);
    for (const s of sessions) {
      const project = String(s.project ?? "?");
      const asmUpdated = s.asm_updated ? new Date(s.asm_updated as string) : null;
      const pendingMsgs = Number(s.pending ?? 0);
      let state: string;
      if (asmUpdated && Date.now() - asmUpdated.getTime() < 2 * 60_000) {
        const elapsed = Math.floor((Date.now() - asmUpdated.getTime()) / 1000);
        state = `🔄 работает (heartbeat ${elapsed}s назад)`;
      } else if (pendingMsgs > 0) {
        state = `📨 ${pendingMsgs} сообщений в очереди`;
      } else {
        const lastActive = s.last_active ? new Date(s.last_active as string) : null;
        const idleSec = lastActive ? Math.floor((Date.now() - lastActive.getTime()) / 1000) : null;
        const idle = idleSec === null ? "?" :
          idleSec < 3600 ? `${Math.floor(idleSec / 60)}m` : `${Math.floor(idleSec / 3600)}h`;
        state = `⚪ idle ${idle}`;
      }
      lines.push(`  ${state} — <b>${project}</b>`);
    }
    lines.push("");
  } else {
    lines.push("Активных сессий нет", "");
  }

  // --- Queue ---
  const q = qRow[0] as any;
  const pending = Number(q?.pending ?? 0);
  const stuck   = Number(q?.stuck   ?? 0);
  lines.push(
    stuck > 0
      ? `<b>Очередь:</b> ⚠️ ${pending} pending, ${stuck} зависших`
      : pending > 0
        ? `<b>Очередь:</b> 📨 ${pending} pending`
        : `<b>Очередь:</b> ✅ пуста`,
  );

  // --- Process health ---
  const daemon     = (health as any[]).find((r) => r.name === "admin-daemon");
  const supervisor = (health as any[]).find((r) => r.name === "supervisor");

  if (daemon) {
    const stale = Date.now() - new Date(daemon.updated_at).getTime() > 90_000;
    const detail = daemon.detail as { pid?: number; uptime_ms?: number } | null;
    const uptime = detail?.uptime_ms != null ? fmtUptime(detail.uptime_ms) : "?";
    lines.push(`<b>admin-daemon:</b> ${stale ? "🟡 stale" : "🟢 ok"} · uptime ${uptime} · PID ${detail?.pid ?? "?"}`);
  }

  if (supervisor) {
    const stale  = Date.now() - new Date(supervisor.updated_at).getTime() > 90_000;
    const detail = supervisor.detail as { uptime_ms?: number; incident_count?: number } | null;
    const uptime = detail?.uptime_ms != null ? fmtUptime(detail.uptime_ms) : "?";
    const inc    = incRow[0] as any;
    lines.push(`<b>supervisor:</b> ${stale ? "🟡 stale" : "🛡 ok"} · uptime ${uptime} · инцидентов: ${Number(inc?.last_hour ?? 0)}/1h ${Number(inc?.last_day ?? 0)}/24h`);
  }

  // --- Ollama summary ---
  const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";
  const summary = await getOllamaSummary(ollamaUrl, {
    sessionCount: sessions.length,
    workingSessions: sessions.filter((s: any) => {
      const asmUpdated = s.asm_updated ? new Date(s.asm_updated as string) : null;
      return asmUpdated && Date.now() - asmUpdated.getTime() < 2 * 60_000;
    }).length,
    pendingQueue: pending,
    stuckQueue: stuck,
    incidentsLastHour: Number((incRow[0] as any)?.last_hour ?? 0),
    daemonOk: !!daemon && Date.now() - new Date(daemon.updated_at).getTime() < 90_000,
    supervisorOk: !!supervisor && Date.now() - new Date(supervisor.updated_at).getTime() < 90_000,
  }, text);

  if (summary) lines.push("", `💬 ${summary}`);

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    message_thread_id: ctx.message?.message_thread_id,
  } as any);
}

interface StatusSnapshot {
  sessionCount: number;
  workingSessions: number;
  pendingQueue: number;
  stuckQueue: number;
  incidentsLastHour: number;
  daemonOk: boolean;
  supervisorOk: boolean;
}

async function getOllamaSummary(ollamaUrl: string, snap: StatusSnapshot, userMessage?: string): Promise<string> {
  const safeMsg = (userMessage ?? "").slice(0, 500);
  const system = `Ты — Helyx Supervisor, интеллектуальный мониторинг Telegram-бота Helyx.

Helyx — это бот, который управляет сессиями Claude Code для разработчиков. Каждая сессия — это отдельный проект, где Claude выполняет задачи программирования. Ты следишь за здоровьем этих сессий.

Твоя роль:
- Оценивать состояние системы и давать живые, осмысленные комментарии
- Предупреждать если что-то выглядит подозрительно (давно не активно, очередь растёт)
- Отвечать на вопросы администратора только в контексте работы Helyx и его компонентов
- Говорить по-русски, кратко и по делу (3-5 предложений)
- Не выходить за рамки мониторинга Helyx — если вопрос не о боте, игнорируй его`;

  const prompt = `Текущее состояние системы:
- Активных сессий: ${snap.sessionCount} (сейчас работают: ${snap.workingSessions})
- Очередь сообщений: ${snap.pendingQueue} pending, ${snap.stuckQueue} зависших (>5 мин)
- Инцидентов за последний час: ${snap.incidentsLastHour}
- admin-daemon: ${snap.daemonOk ? "✅ работает" : "❌ не отвечает"}
- supervisor: ${snap.supervisorOk ? "✅ работает" : "❌ не отвечает"}

${safeMsg && safeMsg !== "?" ? `Вопрос администратора: ${safeMsg}` : "Дай оценку текущего состояния, укажи на любые подозрительные моменты."}`;

  try {
    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OLLAMA_CHAT_MODEL ?? process.env.SUMMARIZE_MODEL ?? "gemma4:e4b",
        think: false,
        messages: [
          { role: "system", content: system },
          { role: "user",   content: prompt },
        ],
        stream: false,
        options: { num_predict: 150, temperature: 0.4 },
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

export function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
