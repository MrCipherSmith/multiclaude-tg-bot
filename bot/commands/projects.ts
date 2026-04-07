import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sql } from "../../memory/db.ts";

interface Project {
  id: number;
  name: string;
  path: string;
  tmuxSessionName: string;
  config: Record<string, unknown>;
}

async function loadProjects(): Promise<Project[]> {
  const rows = await sql`SELECT id, name, path, tmux_session_name, config FROM projects ORDER BY name`;
  return rows.map(r => ({
    id: r.id as number,
    name: r.name as string,
    path: r.path as string,
    tmuxSessionName: r.tmux_session_name as string,
    config: r.config as Record<string, unknown>,
  }));
}

export async function handleProjects(ctx: Context): Promise<void> {
  const projects = await loadProjects();

  if (projects.length === 0) {
    await ctx.reply("No projects configured.\nUse /project-add to add one.");
    return;
  }

  // Get remote session status keyed by project_id
  const remoteSessions = await sql`
    SELECT project_id, status FROM sessions WHERE source = 'remote'
  `;
  const statusMap = new Map(remoteSessions.map(r => [r.project_id as number, r.status as string]));

  const kb = new InlineKeyboard();
  const lines: string[] = ["Projects:\n"];

  for (const p of projects) {
    const sessionStatus = statusMap.get(p.id);
    const isActive = sessionStatus === "active";
    const icon = isActive ? "🟢" : "⚪";
    lines.push(`${icon} ${p.name}  (${p.path})`);
    if (isActive) {
      kb.text(`⏹ Stop ${p.name}`, `proj:stop:${p.name}`).row();
    } else {
      kb.text(`▶️ Start ${p.name}`, `proj:start:${p.name}`).row();
    }
  }

  await ctx.reply(lines.join("\n"), { reply_markup: kb });
}

export async function handleProjectCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");
  const action = parts[1]; // "start" | "stop"
  const name = parts.slice(2).join(":"); // project name

  if (!action || !name) {
    await ctx.answerCallbackQuery({ text: "Invalid" });
    return;
  }

  const projects = await loadProjects();
  const project = projects.find((p) => p.name === name);

  if (!project && action === "start") {
    await ctx.answerCallbackQuery({ text: "Project not found" });
    return;
  }

  await sql`
    INSERT INTO admin_commands (command, payload)
    VALUES (
      ${action === "start" ? "proj_start" : "proj_stop"},
      ${JSON.stringify({ name, path: project?.path ?? "" })}::jsonb
    )
  `;

  await ctx.answerCallbackQuery({
    text: action === "start" ? `Starting ${name}...` : `Stopping ${name}...`,
  });

  // Refresh the message
  await ctx.deleteMessage().catch(() => {});
  await handleProjects(ctx);
}
