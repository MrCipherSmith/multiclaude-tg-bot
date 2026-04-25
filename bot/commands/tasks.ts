/**
 * /tasks — list agent_tasks (read-only for Phase 4).
 * Supports optional argument: /tasks <agent_instance_name> to filter.
 * Phase 7 will add CRUD via this command.
 */
import type { Context } from "grammy";
import { sql } from "../../memory/db.ts";

export async function handleTasks(ctx: Context): Promise<void> {
  const arg = (ctx.match as string)?.trim();

  let rows: Array<{
    id: number; title: string; status: string; priority: number;
    agent_instance_id: number | null; agent_name: string | null;
    project_name: string | null; created_at: Date;
  }>;

  try {
    if (arg) {
      rows = await sql`
        SELECT
          t.id, t.title, t.status, t.priority,
          t.agent_instance_id, ai.name AS agent_name,
          p.name AS project_name, t.created_at
        FROM agent_tasks t
        LEFT JOIN agent_instances ai ON ai.id = t.agent_instance_id
        LEFT JOIN projects p ON p.id = ai.project_id
        WHERE ai.name = ${arg} OR p.name = ${arg}
        ORDER BY t.priority DESC, t.created_at DESC
        LIMIT 50
      ` as any;
    } else {
      rows = await sql`
        SELECT
          t.id, t.title, t.status, t.priority,
          t.agent_instance_id, ai.name AS agent_name,
          p.name AS project_name, t.created_at
        FROM agent_tasks t
        LEFT JOIN agent_instances ai ON ai.id = t.agent_instance_id
        LEFT JOIN projects p ON p.id = ai.project_id
        WHERE t.status IN ('pending', 'in_progress', 'blocked', 'review')
        ORDER BY t.priority DESC, t.created_at DESC
        LIMIT 30
      ` as any;
    }
  } catch (err) {
    await ctx.reply(
      "⚠️ <b>agent_tasks</b> table not available.\n\n" +
        "Run the migration first: <code>bun memory/db.ts</code>",
      { parse_mode: "HTML" },
    );
    return;
  }

  if (rows.length === 0) {
    await ctx.reply(arg
      ? `No tasks for "<i>${arg}</i>".`
      : "No active tasks.\n\n<i>Use /tasks &lt;name&gt; to filter by agent or project.</i>",
      { parse_mode: "HTML" });
    return;
  }

  const lines: string[] = arg
    ? [`<b>Tasks for "${arg}"</b>:`]
    : ["<b>Active tasks</b>:"];

  const statusEmoji: Record<string, string> = {
    pending:     "⏳",
    in_progress: "🔧",
    blocked:     "🚧",
    review:      "👀",
    done:        "✅",
    cancelled:   "🚫",
    failed:      "❌",
  };

  for (const r of rows) {
    const emoji = statusEmoji[r.status] ?? "❓";
    const where = r.agent_name ? ` <i>(@${r.agent_name}${r.project_name ? ` / ${r.project_name}` : ""})</i>` : "";
    const prio = r.priority > 0 ? ` <b>p${r.priority}</b>` : "";
    lines.push(`${emoji} #${r.id}${prio} ${r.title}${where}`);
  }

  if (rows.length === 50 || rows.length === 30) {
    lines.push("");
    lines.push(`<i>Showing first ${rows.length}. CRUD comes in Phase 7.</i>`);
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}
