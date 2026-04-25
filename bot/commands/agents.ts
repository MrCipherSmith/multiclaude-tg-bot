/**
 * /agents — list agent_instances with desired/actual state and start/stop buttons.
 *
 * For each agent_instance:
 *   - Show: name, project, desired_state, actual_state, last_health_at
 *   - If desired=stopped: button "▶️ Start"  → set desired=running
 *   - If desired=running: button "⏹ Stop"   → set desired=stopped
 *   - Always: button "↻ Restart"             → set desired=running (reconciler converges)
 *
 * Callback patterns:
 *   agent:start:<id>
 *   agent:stop:<id>
 *   agent:restart:<id>
 */
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sql } from "../../memory/db.ts";
import { agentManager } from "../../agents/agent-manager.ts";

export async function handleAgents(ctx: Context): Promise<void> {
  let rows: Array<{
    id: number; name: string; desired_state: string; actual_state: string;
    project_id: number | null; project_name: string | null;
    last_health_at: Date | null; restart_count: number;
  }>;
  try {
    rows = await sql`
      SELECT
        ai.id, ai.name, ai.desired_state, ai.actual_state,
        ai.project_id, p.name AS project_name,
        ai.last_health_at, ai.restart_count
      FROM agent_instances ai
      LEFT JOIN projects p ON p.id = ai.project_id
      ORDER BY p.name NULLS LAST, ai.name
    ` as any;
  } catch (err) {
    await ctx.reply(
      "⚠️ <b>agent_instances</b> table not available.\n\n" +
        "Run the migration first: <code>bun memory/db.ts</code>",
      { parse_mode: "HTML" },
    );
    return;
  }

  if (rows.length === 0) {
    await ctx.reply("No agent instances configured.");
    return;
  }

  const lines: string[] = ["<b>Agent instances</b>:"];
  const keyboard = new InlineKeyboard();

  function stateEmoji(actual: string, desired: string): string {
    // Permission/approval pending — special state. The watchdog set this when it
    // detected a permission prompt and is awaiting human response via Telegram.
    // Show before any other classification so it's never hidden behind 🟢/🟡.
    if (actual === "waiting_approval") return "🟣";
    // "new" means the reconciler has never probed yet — treat as equivalent to stopped
    // for display purposes (no actuating activity has happened)
    const effectiveActual = actual === "new" ? "stopped" : actual;
    if (desired === effectiveActual) return desired === "running" ? "🟢" : "⚫";
    if (desired === "running" && effectiveActual !== "running") return "🟡"; // converging up
    if (desired === "stopped" && effectiveActual !== "stopped") return "🟠"; // converging down
    return "❓";
  }

  for (const r of rows) {
    const proj = r.project_name ? ` <i>(${r.project_name})</i>` : " <i>(no project)</i>";
    const emoji = stateEmoji(r.actual_state, r.desired_state);
    const health = r.last_health_at ? ` · last health: ${humanRelative(r.last_health_at)}` : "";
    const restarts = r.restart_count > 0 ? ` · restarts: ${r.restart_count}` : "";
    lines.push(`${emoji} <b>${r.name}</b>${proj} — desired=<code>${r.desired_state}</code>, actual=<code>${r.actual_state}</code>${health}${restarts}`);

    const startStop = r.desired_state === "stopped"
      ? { text: `▶️ Start ${r.name}`, data: `agent:start:${r.id}` }
      : { text: `⏹ Stop ${r.name}`, data: `agent:stop:${r.id}` };
    keyboard.text(startStop.text, startStop.data).text(`↻ ${r.name}`, `agent:restart:${r.id}`).row();
  }

  lines.push("");
  lines.push("<i>🟢 running   ⚫ stopped   🟡 converging↑   🟠 converging↓   🟣 waiting approval   ❓ unknown</i>");

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: keyboard });
}

function humanRelative(d: Date): string {
  const ms = Date.now() - new Date(d).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** Callback handler for `agent:start|stop|restart:<id>`. */
export async function handleAgentCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const m = data?.match(/^agent:(start|stop|restart):(\d+)$/);
  if (!m) {
    await ctx.answerCallbackQuery({ text: "Invalid callback" });
    return;
  }
  const action = m[1];
  const id = parseInt(m[2], 10);

  const inst = await agentManager.getInstance(id);
  if (!inst) {
    await ctx.answerCallbackQuery({ text: "Agent instance not found", show_alert: true });
    return;
  }

  try {
    if (action === "start") {
      await agentManager.setDesiredState(id, "running", "telegram /agents");
      await ctx.answerCallbackQuery({ text: `${inst.name}: desired=running` });
    } else if (action === "stop") {
      await agentManager.setDesiredState(id, "stopped", "telegram /agents");
      await ctx.answerCallbackQuery({ text: `${inst.name}: desired=stopped` });
    } else if (action === "restart") {
      // The reconciler probes health each tick. If we just need a kick-restart,
      // setting desired_state='running' triggers driver.start when actual='stopped'
      // (after first observation). For a forced restart of an already-running agent,
      // we'd need a separate restart_requested flag — out of scope here. The 100ms
      // back-to-back stop/start hack from the original implementation was racy and
      // generated misleading audit events.
      await agentManager.setDesiredState(id, "running", "telegram /agents restart");
      await ctx.answerCallbackQuery({ text: `${inst.name}: desired=running (reconciler will probe)` });
    }
  } catch (err) {
    await ctx.answerCallbackQuery({ text: `Error: ${String(err).slice(0, 100)}`, show_alert: true });
  }
}
