import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { projectService } from "../../services/project-service.ts";
import { sql } from "../../memory/db.ts";

async function getPendingActions(): Promise<Map<number, "start" | "stop">> {
  const rows = await sql`
    SELECT payload, command FROM admin_commands
    WHERE command IN ('proj_start', 'proj_stop') AND status IN ('pending', 'processing')
  `;
  const map = new Map<number, "start" | "stop">();
  for (const row of rows) {
    const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    const id = Number(payload.project_id);
    if (id) map.set(id, row.command === "proj_start" ? "start" : "stop");
  }
  return map;
}

export async function handleProjects(ctx: Context): Promise<void> {
  const [projects, pending] = await Promise.all([
    projectService.list(),
    getPendingActions(),
  ]);

  if (projects.length === 0) {
    await ctx.reply("No projects configured.\nUse /project-add to add one.");
    return;
  }

  const kb = new InlineKeyboard();
  const lines: string[] = ["Projects:\n"];

  for (const p of projects) {
    const pendingAction = pending.get(p.id);
    if (pendingAction) {
      const icon = pendingAction === "start" ? "⏳▶️" : "⏳⏹";
      lines.push(`${icon} ${p.name}  (${p.path})`);
    } else {
      const isActive = p.session_status === "active";
      const icon = isActive ? "🟢" : "⚪";
      lines.push(`${icon} ${p.name}  (${p.path})`);
      if (isActive) {
        kb.text(`⏹ Stop ${p.name}`, `proj:stop:${p.id}`).row();
      } else {
        kb.text(`▶️ Start ${p.name}`, `proj:start:${p.id}`).row();
      }
    }
  }

  if (pending.size > 0) {
    kb.text("🔄 Refresh", "proj:refresh").row();
  }

  await ctx.reply(lines.join("\n"), { reply_markup: kb });
}

export async function handleProjectCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");
  const action = parts[1]; // "start" | "stop" | "refresh"
  const id = Number(parts[2]);

  if (action === "refresh") {
    await ctx.answerCallbackQuery({ text: "Refreshed" });
    await ctx.deleteMessage().catch(() => {});
    await handleProjects(ctx);
    return;
  }

  if (!action || !id) {
    await ctx.answerCallbackQuery({ text: "Invalid" });
    return;
  }

  const project = await projectService.get(id);
  if (!project) {
    await ctx.answerCallbackQuery({ text: "Project not found" });
    return;
  }

  if (action === "start") {
    await projectService.start(id);
  } else {
    await projectService.stop(id);
  }

  await ctx.answerCallbackQuery({
    text: action === "start" ? `Starting ${project.name}...` : `Stopping ${project.name}...`,
  });

  // Edit message in-place to show pending state immediately
  const [projects, pending] = await Promise.all([
    projectService.list(),
    getPendingActions(),
  ]);

  const kb = new InlineKeyboard();
  const lines: string[] = ["Projects:\n"];

  for (const p of projects) {
    const pendingAction = pending.get(p.id);
    if (pendingAction) {
      const icon = pendingAction === "start" ? "⏳▶️" : "⏳⏹";
      lines.push(`${icon} ${p.name}  (${p.path})`);
    } else {
      const isActive = p.session_status === "active";
      const icon = isActive ? "🟢" : "⚪";
      lines.push(`${icon} ${p.name}  (${p.path})`);
      if (isActive) {
        kb.text(`⏹ Stop ${p.name}`, `proj:stop:${p.id}`).row();
      } else {
        kb.text(`▶️ Start ${p.name}`, `proj:start:${p.id}`).row();
      }
    }
  }

  kb.text("🔄 Refresh", "proj:refresh").row();

  await ctx.editMessageText(lines.join("\n"), { reply_markup: kb }).catch(async () => {
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply(lines.join("\n"), { reply_markup: kb });
  });
}
