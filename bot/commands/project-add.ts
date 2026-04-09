import type { Context } from "grammy";
import { basename, join } from "path";
import { setPendingInput } from "../handlers.ts";
import { sql } from "../../memory/db.ts";
import { sessionManager } from "../../sessions/manager.ts";
import { logger } from "../../logger.ts";

export async function handleProjectAdd(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const arg = text.replace(/^\/project[_-]add\s*/, "").trim();

  if (arg) {
    await addProject(ctx, arg);
  } else {
    const chatId = String(ctx.chat!.id);
    const hostHome = process.env.HOST_HOME ?? "/home/user";
    await ctx.reply(`Enter project path:\ne.g. ${join(hostHome, "my-project")}`);
    setPendingInput(chatId, async (replyCtx) => {
      const path = replyCtx.message?.text?.trim() ?? "";
      await addProject(replyCtx, path);
    });
  }
}

async function addProject(ctx: Context, path: string): Promise<void> {
  if (!path.startsWith("/")) {
    await ctx.reply("Path must be absolute (start with /).");
    return;
  }

  const name = basename(path);

  let rows: any[];
  try {
    rows = await sql`
      INSERT INTO projects (name, path, tmux_session_name)
      VALUES (${name}, ${path}, ${name})
      ON CONFLICT (path) DO UPDATE SET
        tmux_session_name = EXCLUDED.tmux_session_name,
        config = EXCLUDED.config
      RETURNING id, name, path, tmux_session_name
    `;
  } catch (err: any) {
    if (err.code === '23505') { // unique_violation
      await ctx.reply(`Project already exists with that name or path.`);
      return;
    }
    throw err;
  }

  const project = rows[0];
  await sessionManager.registerRemote(project.id as number, project.path as string, project.name as string);
  await ctx.reply(`Added: ${project.name}\n${project.path}\n\nUse /projects to start it.`);

  // Trigger async project knowledge scan (non-blocking)
  const { scanProjectKnowledge } = await import("../../memory/project-scanner.ts");
  scanProjectKnowledge(project.path as string).catch((err) =>
    logger.error({ err, path: project.path }, "project-add: scan error")
  );
}
