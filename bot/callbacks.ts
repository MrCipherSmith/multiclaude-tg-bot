import type { Context } from "grammy";
import { sessionManager } from "../sessions/manager.ts";
import { sql } from "../memory/db.ts";
import { appendLog } from "../utils/stats.ts";
import { readSkills, readCommands, toolIcon } from "../utils/tools-reader.ts";
import { setPendingTool } from "./handlers.ts";
import { enqueueToolCommand } from "./text-handler.ts";
import { doSwitch } from "./commands/session.ts";

export async function handleCallbackQuery(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  if (data.startsWith("perm:")) return handlePermissionCallback(ctx);
  if (data.startsWith("switch:")) return handleSwitchCallback(ctx);
  if (data.startsWith("skill:") || data.startsWith("cmd:")) return handleToolCallback(ctx);
  if (data.startsWith("set_model:")) {
    const { handleSetModelCallback } = await import("./commands/model.ts");
    return handleSetModelCallback(ctx, data.slice("set_model:".length));
  }
  if (data.startsWith("rc:")) {
    const { handleRemoteControlCallback } = await import("./commands/remote-control.ts");
    return handleRemoteControlCallback(ctx);
  }
  if (data.startsWith("proj:")) {
    const { handleProjectCallback } = await import("./commands/projects.ts");
    return handleProjectCallback(ctx);
  }
  await ctx.answerCallbackQuery({ text: "Unknown action" });
}

async function handleToolCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const chatId = String(ctx.chat?.id ?? "");
  const fromUser = ctx.from?.username ?? ctx.from?.first_name ?? "user";

  const isSkill = data.startsWith("skill:");
  const type = isSkill ? "skill" : "cmd";
  const name = data.slice(data.indexOf(":") + 1);

  if (!name) {
    await ctx.answerCallbackQuery({ text: "Invalid action" });
    return;
  }

  // Resolve requiresArgs
  const items = isSkill ? await readSkills() : await readCommands();
  const tool = items.find((t) => t.name === name);
  const requiresArgs = tool?.requiresArgs ?? true; // safe default

  const icon = toolIcon(name);

  if (!requiresArgs) {
    await ctx.answerCallbackQuery({ text: `Running /${name}…` });
    await enqueueToolCommand(chatId, fromUser, `/${name}`);
    return;
  }

  // Ask for arguments — show description too
  setPendingTool(chatId, { type, name });
  await ctx.answerCallbackQuery();
  const desc = tool?.description ? `\n<i>${tool.description.slice(0, 120)}</i>\n` : "";
  await ctx.reply(`${icon} <b>/${name}</b>${desc}\nEnter arguments:`, { parse_mode: "HTML" });
}

async function handleSwitchCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const targetSessionId = Number(data?.split(":")[1]);
  const chatId = String(ctx.chat?.id);

  if (isNaN(targetSessionId)) {
    await ctx.answerCallbackQuery({ text: "Invalid session" });
    return;
  }

  const session = await sessionManager.get(targetSessionId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: "Session not found" });
    return;
  }

  appendLog(targetSessionId, chatId, "switch", `switched via inline button`);

  // Remove the button from the message
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {}

  await ctx.answerCallbackQuery({ text: `Switching to ${session.name ?? session.project ?? String(targetSessionId)}` });
  await doSwitch(ctx, targetSessionId);
}

async function handlePermissionCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("perm:")) return;

  const parts = data.split(":");
  const action = parts[1]; // 'allow', 'always', or 'deny'
  const requestId = parts.slice(2).join(":");

  // For "always" — treat as allow + save auto-approve rule
  const dbAction = action === "always" ? "allow" : action;

  const chatId = String(ctx.chat?.id ?? "");
  const result = await sql`
    UPDATE permission_requests SET response = ${dbAction} WHERE id = ${requestId} AND chat_id = ${chatId} RETURNING id, tool_name, session_id
  `;

  if (result.length > 0) {
    const originalText = ctx.callbackQuery?.message?.text ?? "";
    // Match both old (Russian) and new (English) header for backward compat
    const descPart = originalText.replace(/^🔐 (Allow\?|Разрешить\?)\n*/, "").trim();

    if (action === "always") {
      const toolName = result[0].tool_name;
      const sessionId = result[0].session_id;

      // Add to auto-approve in both project and global settings
      const settingsPaths: string[] = [];
      const hostConfig = process.env.HOST_CLAUDE_CONFIG;

      // Project settings (use Claude Code convention: ~/.claude/projects/{encoded-path}/)
      const sessionRows = await sql`SELECT project_path FROM sessions WHERE id = ${sessionId}`;
      const projectPath = sessionRows[0]?.project_path;
      if (projectPath && hostConfig) {
        const encodedPath = projectPath.replace(/\//g, "-");
        settingsPaths.push(`${hostConfig}/projects/${encodedPath}/settings.local.json`);
      }

      // Global settings (host path mounted into Docker)
      if (hostConfig) {
        settingsPaths.push(`${hostConfig}/settings.local.json`);
      }

      // MCP tools use plain name or wildcard (mcp__server__tool), not ToolName(*) pattern
      const isMcp = toolName.startsWith("mcp__");
      const pattern = isMcp ? toolName : `${toolName}(*)`;
      for (const settingsPath of settingsPaths) {
        try {
          let settings: any = {};
          try {
            settings = JSON.parse(await Bun.file(settingsPath).text());
          } catch {}
          if (!settings.permissions) settings.permissions = {};
          if (!settings.permissions.allow) settings.permissions.allow = [];
          if (!settings.permissions.allow.includes(pattern)) {
            settings.permissions.allow.push(pattern);
            const dir = settingsPath.split("/").slice(0, -1).join("/");
            await import("fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
            await Bun.write(settingsPath, JSON.stringify(settings, null, 2) + "\n");
            console.log(`[perm] added ${pattern} to ${settingsPath}`);
          }
        } catch (err) {
          console.error(`[perm] failed to write ${settingsPath}:`, err);
        }
      }

      await ctx.editMessageText(`✅ Always allowed: ${toolName}\n\n${descPart}`);
      await ctx.answerCallbackQuery({ text: `Always: ${toolName}` });
    } else if (action === "allow") {
      await ctx.editMessageText(`✅ Allowed\n\n${descPart}`);
      await ctx.answerCallbackQuery({ text: "Allowed" });
    } else {
      await ctx.editMessageText(`❌ Denied\n\n${descPart}`);
      await ctx.answerCallbackQuery({ text: "Denied" });
    }
  } else {
    await ctx.answerCallbackQuery({ text: "Request expired" });
  }
}
