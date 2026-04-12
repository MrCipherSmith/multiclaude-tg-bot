/**
 * /monitor — process health dashboard.
 *
 * Shows admin-daemon, Docker containers, and tmux sessions in one message.
 * Data comes from the `process_health` table (written by admin-daemon every 30 s).
 * Action buttons queue admin_commands that admin-daemon executes on the host.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sql } from "../../memory/db.ts";

function icon(status: string): string {
  return status === "running" ? "🟢" : "🔴";
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function fmtAge(updatedAt: Date): string {
  const s = Math.floor((Date.now() - updatedAt.getTime()) / 1000);
  if (s < 10)  return "now";
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export async function handleMonitor(ctx: Context): Promise<void> {
  const [health, sessions] = await Promise.all([
    sql`SELECT name, status, detail, updated_at FROM process_health ORDER BY name`,
    sql`SELECT COUNT(*) AS cnt FROM sessions WHERE status = 'active' AND id != 0`,
  ]);

  const lines: string[] = [];
  const kb = new InlineKeyboard();

  // --- admin-daemon ---
  const daemonRow = health.find((r) => r.name === "admin-daemon");
  if (daemonRow) {
    const detail = daemonRow.detail as { pid?: number; uptime_ms?: number } | null;
    const uptime = detail?.uptime_ms != null ? fmtUptime(detail.uptime_ms) : "?";
    const stale  = Date.now() - new Date(daemonRow.updated_at).getTime() > 90_000; // >90s = suspect
    const st     = stale ? "🟡" : icon(daemonRow.status);
    lines.push(`${st} <b>admin-daemon</b>  PID ${detail?.pid ?? "?"} · ${uptime}`);
    if (stale) lines.push(`   ⚠️ last heartbeat ${fmtAge(new Date(daemonRow.updated_at))}`);
    kb.text("🔄 Restart daemon", "mon:restart_daemon");
  } else {
    lines.push(`🔴 <b>admin-daemon</b>  not running`);
    lines.push(`   Run: <code>bun scripts/admin-daemon.ts</code>`);
  }

  lines.push("");

  // --- Docker containers ---
  const dockerRows = health.filter((r) => r.name.startsWith("docker:"));
  if (dockerRows.length > 0) {
    lines.push("<b>Docker</b>");
    for (const row of dockerRows) {
      const cname  = row.name.slice("docker:".length);
      const detail = row.detail as { status?: string } | null;
      lines.push(`${icon(row.status)} ${cname}  <i>${detail?.status ?? row.status}</i>`);
    }

    // Restart buttons for bot container only (postgres restart is risky)
    const botContainer = dockerRows.find((r) => r.name.includes("bot-") || r.name.includes("-bot"));
    if (botContainer) {
      kb.row().text("🔄 Restart bot", `mon:docker_restart:${botContainer.name.slice("docker:".length)}`);
    }
  } else {
    lines.push(`🔴 <b>Docker</b>  no containers found`);
    lines.push(`   admin-daemon might not have run yet`);
  }

  lines.push("");

  // --- tmux sessions ---
  const activeCount = Number((sessions[0] as any)?.cnt ?? 0);
  lines.push(`🪟 <b>tmux bots</b>  ${activeCount} active session${activeCount !== 1 ? "s" : ""}`);

  kb.row().text("🔄 Refresh", "mon:refresh");

  const now = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  await ctx.reply(
    `🖥 <b>Processes</b> — ${now}\n\n${lines.join("\n")}`,
    { parse_mode: "HTML", reply_markup: kb },
  );
}

export async function handleMonitorCallback(ctx: Context): Promise<void> {
  const data  = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");
  const action = parts[1];

  if (action === "refresh") {
    await ctx.answerCallbackQuery({ text: "Refreshed" });
    await ctx.deleteMessage().catch(() => {});
    await handleMonitor(ctx);
    return;
  }

  if (action === "restart_daemon") {
    await sql`INSERT INTO admin_commands (command, payload) VALUES ('restart_admin_daemon', '{}')`;
    await ctx.answerCallbackQuery({ text: "⏳ Restarting daemon..." });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text("🔄 Refresh", "mon:refresh") });
    return;
  }

  if (action === "docker_restart") {
    const container = parts.slice(2).join(":");
    if (!container) { await ctx.answerCallbackQuery({ text: "Missing container" }); return; }
    await sql`INSERT INTO admin_commands (command, payload) VALUES ('docker_restart', ${JSON.stringify({ container })}::jsonb)`;
    await ctx.answerCallbackQuery({ text: `⏳ Restarting ${container}...` });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text("🔄 Refresh", "mon:refresh") });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown action" });
}
