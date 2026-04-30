import type { Context } from "grammy";
import { sessionManager } from "../sessions/manager.ts";
import { sql } from "../memory/db.ts";
import { appendLog } from "../utils/stats.ts";
import { readSkills, readCommands, toolIcon } from "../utils/tools-reader.ts";
import { setPendingTool, setPendingInput } from "./handlers.ts";
import { enqueueToolCommand } from "./text-handler.ts";
import { doSwitch } from "./commands/session.ts";
import { permissionService } from "../services/permission-service.ts";
import { approveSkill, rejectSkill } from "../utils/skill-distiller.ts";
import { logger } from "../logger.ts";

export async function handleCallbackQuery(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  if (data.startsWith("perm:")) return handlePermissionCallback(ctx);
  if (data.startsWith("switch:")) return handleSwitchCallback(ctx);
  // FR-C-10: agent-created skill approval. `skill:save:` / `skill:reject:` /
  // `skill:editname:` use the same `skill:` prefix as the existing tool
  // launcher, so they must be routed FIRST by their action subkey.
  if (
    data.startsWith("skill:save:") ||
    data.startsWith("skill:reject:") ||
    data.startsWith("skill:editname:")
  ) return handleSkillApprovalCallback(ctx);
  if (data.startsWith("cur:approve:") || data.startsWith("cur:skip:")) return handleCuratorApprovalCallback(ctx);
  if (data.startsWith("skill:") || data.startsWith("cmd:")) return handleToolCallback(ctx);
  if (data.startsWith("set_model:")) {
    const { handleSetModelCallback } = await import("./commands/model.ts");
    return handleSetModelCallback(ctx, data.slice("set_model:".length));
  }
  if (data.startsWith("rc:")) {
    const { handleRemoteControlCallback } = await import("./commands/remote-control.ts");
    return handleRemoteControlCallback(ctx);
  }
  if (data.startsWith("poll_submit:")) {
    const { handlePollSubmit } = await import("./poll-handler.ts");
    const pollSessionId = Number(data.slice("poll_submit:".length));
    return handlePollSubmit(ctx, pollSessionId);
  }
  if (data.startsWith("proj:")) {
    const { handleProjectCallback } = await import("./commands/projects.ts");
    return handleProjectCallback(ctx);
  }
  if (data.startsWith("sess:delete:")) {
    const { handleDeleteSession } = await import("./commands/session.ts");
    return handleDeleteSession(ctx);
  }
  if (data.startsWith("tmux:")) {
    const { handleTmuxActionCallback } = await import("./commands/tmux-actions.ts");
    return handleTmuxActionCallback(ctx);
  }
  if (data.startsWith("mon:")) {
    const { handleMonitorCallback } = await import("./commands/monitor.ts");
    return handleMonitorCallback(ctx);
  }
  if (data.startsWith("sup:")) {
    const { handleSupervisorCallback } = await import("./commands/supervisor-actions.ts");
    return handleSupervisorCallback(ctx);
  }
  await ctx.answerCallbackQuery({ text: "Unknown action" });
}

// FR-C-10: handle [Save] / [Reject] / [Edit name…] inline buttons on the
// agent-created skill approval message.
async function handleSkillApprovalCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");
  const action = parts[1]; // 'save' | 'reject' | 'editname'
  const skillId = Number(parts[2]);
  if (!Number.isFinite(skillId) || skillId <= 0) {
    await ctx.answerCallbackQuery({ text: "Invalid skill id" });
    return;
  }

  const rows = await sql`SELECT name, status FROM agent_created_skills WHERE id = ${skillId}`;
  if (rows.length === 0) {
    await ctx.answerCallbackQuery({ text: "Skill not found" });
    return;
  }
  const skill = rows[0] as { name: string; status: string };
  if (skill.status !== "proposed") {
    await ctx.answerCallbackQuery({ text: `Already ${skill.status}` });
    return;
  }

  if (action === "save") {
    const ok = await approveSkill(skillId);
    if (ok) {
      await ctx.answerCallbackQuery({ text: `Saved: ${skill.name}` });
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await ctx.reply(`✅ Skill <code>${skill.name}</code> saved.`, { parse_mode: "HTML" });
    } else {
      await ctx.answerCallbackQuery({ text: "Save failed" });
    }
  } else if (action === "reject") {
    const ok = await rejectSkill(skillId);
    if (ok) {
      await ctx.answerCallbackQuery({ text: "Rejected" });
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await ctx.reply(`❌ Skill <code>${skill.name}</code> rejected.`, { parse_mode: "HTML" });
    } else {
      await ctx.answerCallbackQuery({ text: "Reject failed" });
    }
  } else if (action === "editname") {
    const chatIdStr = String(ctx.chat?.id ?? "");
    setPendingInput(chatIdStr, async (textCtx) => {
      const newName = (textCtx.message?.text ?? "").trim();
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(newName)) {
        await textCtx.reply("Invalid name — must be kebab-case, 1-64 chars, lowercase + digits + hyphens.");
        return;
      }
      try {
        await sql`UPDATE agent_created_skills SET name = ${newName} WHERE id = ${skillId} AND status = 'proposed'`;
        await textCtx.reply(`✏️ Renamed to <code>${newName}</code>.`, { parse_mode: "HTML" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await textCtx.reply(`Rename failed: ${msg}`);
      }
    }, 5 * 60_000);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `✏️ Send the new kebab-case name for skill <code>${skill.name}</code> (id=${skillId}):`,
      { parse_mode: "HTML" },
    );
  } else {
    await ctx.answerCallbackQuery({ text: "Unknown action" });
  }
}

// FR-B-6: handle [Approve] / [Skip] inline buttons on curator pending actions.
async function handleCuratorApprovalCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");
  const action = parts[1]; // 'approve' | 'skip'
  const actionId = Number(parts[2]);
  if (!Number.isFinite(actionId) || actionId <= 0) {
    await ctx.answerCallbackQuery({ text: "Invalid action id" });
    return;
  }

  const rows = await sql`SELECT skill_name, action, status, created_at FROM curator_pending_actions WHERE id = ${actionId}`;
  if (rows.length === 0) {
    await ctx.answerCallbackQuery({ text: "Action not found" });
    return;
  }
  const pending = rows[0] as { skill_name: string; action: string; status: string; created_at: Date };
  if (pending.status !== "pending") {
    await ctx.answerCallbackQuery({ text: `Already ${pending.status}` });
    return;
  }
  if (Date.now() - new Date(pending.created_at).getTime() > 24 * 60 * 60 * 1000) {
    await sql`UPDATE curator_pending_actions SET status = 'expired', decided_at = now() WHERE id = ${actionId}`;
    await ctx.answerCallbackQuery({ text: "Expired" });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return;
  }

  const newStatus = action === "approve" ? "approved" : "skipped";
  await sql`UPDATE curator_pending_actions SET status = ${newStatus}, decided_at = now() WHERE id = ${actionId}`;
  await ctx.answerCallbackQuery({ text: newStatus });
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
  await ctx.reply(
    `${newStatus === "approved" ? "✅" : "⏭"} Curator action <code>${pending.action}</code> on <code>${pending.skill_name}</code> ${newStatus}.`,
    { parse_mode: "HTML" },
  );
  // Note: actually applying 'approve' (running consolidate/patch) is a follow-up.
  // The user decision is recorded; the application step needs the diff/target-skill
  // body fetch which is not yet wired through the aux-LLM.
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

  // Idempotency guard: ignore if already handled (Telegram may deliver callback twice)
  const current = await sql`SELECT status FROM permission_requests WHERE id = ${requestId} AND chat_id = ${chatId}`;
  if (!current[0] || current[0].status !== "pending") {
    await ctx.answerCallbackQuery({ text: "Already handled" });
    return;
  }

  const newStatus = dbAction === "allow" ? "approved" : "rejected";
  await permissionService.transition(requestId, newStatus);

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
            logger.info({ pattern, path: settingsPath }, "auto-approve pattern added");
          }
        } catch (err) {
          logger.error({ err, path: settingsPath }, "failed to write auto-approve settings");
        }
      }

      await ctx.editMessageText(`✅ Always allowed: ${toolName}\n\n${descPart}`).catch(() => {});
      await ctx.answerCallbackQuery({ text: `Always: ${toolName}` }).catch(() => {});
    } else if (action === "allow") {
      await ctx.editMessageText(`✅ Allowed\n\n${descPart}`).catch(() => {});
      await ctx.answerCallbackQuery({ text: "Allowed" }).catch(() => {});
    } else {
      await ctx.editMessageText(`❌ Denied\n\n${descPart}`).catch(() => {});
      await ctx.answerCallbackQuery({ text: "Denied" }).catch(() => {});
    }
  } else {
    await ctx.answerCallbackQuery({ text: "Request expired" }).catch(() => {});
  }
}
