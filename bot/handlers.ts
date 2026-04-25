import type { Bot, Context } from "grammy";

// === Shared state ===

// Pending input: chatId -> handler that processes the next text message
export const pendingInput = new Map<string, (ctx: Context) => Promise<void>>();
const pendingInputTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Pending tool invocation: waiting for user to supply arguments
export interface PendingTool {
  type: "skill" | "cmd";
  name: string;
}
export const pendingToolInput = new Map<string, PendingTool>();
const pendingToolTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function setPendingTool(chatId: string, tool: PendingTool): void {
  const existing = pendingToolTimers.get(chatId);
  if (existing) clearTimeout(existing);
  pendingToolInput.set(chatId, tool);
  pendingToolTimers.set(chatId, setTimeout(() => {
    pendingToolInput.delete(chatId);
    pendingToolTimers.delete(chatId);
  }, 5 * 60_000)); // 5 min TTL
}

export function clearPendingTool(chatId: string): void {
  pendingToolInput.delete(chatId);
  const t = pendingToolTimers.get(chatId);
  if (t) { clearTimeout(t); pendingToolTimers.delete(chatId); }
}

export function setPendingInput(
  chatId: string,
  handler: (ctx: Context) => Promise<void>,
  ttlMs = 60_000,
): void {
  const existing = pendingInputTimers.get(chatId);
  if (existing) clearTimeout(existing);

  pendingInput.set(chatId, handler);
  pendingInputTimers.set(chatId, setTimeout(() => {
    pendingInput.delete(chatId);
    pendingInputTimers.delete(chatId);
  }, ttlMs));
}

export function clearPendingInput(chatId: string): void {
  pendingInput.delete(chatId);
  const timer = pendingInputTimers.get(chatId);
  if (timer) { clearTimeout(timer); pendingInputTimers.delete(chatId); }
}

// Bot reference set from bot.ts
let bot: Bot | null = null;
export function setBotRef(b: Bot): void {
  bot = b;
}
export function getBotRef(): Bot {
  if (!bot) throw new Error("Bot reference not set — call setBotRef() first");
  return bot;
}

// === Handler imports ===

import { handleSessions, handleSwitch, handleSwitchTo, handleSessionInfo, handleRename, handleRemove, handleCleanup, handleStart, handleHelp } from "./commands/session.ts";
import { handleRemember, handleRecall, handleMemories, handleForget, handleSummarize, handleClear } from "./commands/memory.ts";
import { handleStats, handleLogs, handleStatus, handlePending, handleTools, handleSkills, handleCommands, handleHooks, handleRules, handlePermissionStats, handleSessionExport } from "./commands/admin.ts";
import { handleAdd } from "./commands/add.ts";
import { handleModel } from "./commands/model.ts";
import { handleProviders } from "./commands/providers.ts";
import { handleModels } from "./commands/models.ts";
import { handleAgents, handleAgentCallback } from "./commands/agents.ts";
import { handleTasks } from "./commands/tasks.ts";
import { handleOrchestrate } from "./commands/orchestrate.ts";
import { handleTask } from "./commands/task.ts";
import { handleRemoteControl } from "./commands/remote-control.ts";
import { handleInterrupt } from "./commands/interrupt.ts";
import { handleMonitor } from "./commands/monitor.ts";
import { handleProjects } from "./commands/projects.ts";
import { handleProjectAdd } from "./commands/project-add.ts";
import { handleProjectFacts, handleProjectScan } from "./commands/project-facts.ts";
import { handleMemoryExport, handleMemoryImport } from "./commands/memory-export.ts";
import { handleForumSetup, handleForumSync, handleForumClean, handleTopicRename, handleTopicClose, handleTopicReopen, handleForumHub } from "./commands/forum.ts";
import { handleQuickstart } from "./commands/quickstart.ts";
import { handleResume } from "./commands/resume.ts";
import { handleCodexSetup, handleCodexStatus, handleCodexReview } from "./commands/codex.ts";
import { handleVoice, handlePhoto, handleDocument, handleVideo, handleVideoNote, handleSticker } from "./media.ts";
import { handleCallbackQuery } from "./callbacks.ts";
import { handleText } from "./text-handler.ts";
import { handlePollAnswer } from "./poll-handler.ts";

// === Register all handlers ===

export function registerHandlers(b: Bot): void {
  // Session commands
  b.command("sessions", handleSessions);
  b.command("switch", handleSwitch);
  b.command("standalone", (ctx) => handleSwitchTo(ctx, 0));
  b.command("session", handleSessionInfo);
  b.command("rename", handleRename);
  b.command("start", handleStart);
  b.command("help", handleHelp);
  b.command("quickstart", handleQuickstart);

  // Memory commands
  b.command("remember", handleRemember);
  b.command("recall", handleRecall);
  b.command("memories", handleMemories);
  b.command("forget", handleForget);
  b.command("memory_export", handleMemoryExport);
  b.command("memory_import", handleMemoryImport);
  // Import via document with /memory_import caption (must call next() for other docs to pass through)
  b.on("message:document", async (ctx, next) => {
    const caption = ctx.message.caption ?? "";
    if (caption.startsWith("/memory_import")) await handleMemoryImport(ctx);
    else await next();
  });

  // Utility commands
  b.command("clear", handleClear);
  b.command("remove", handleRemove);
  b.command("cleanup", handleCleanup);
  b.command("summarize", handleSummarize);
  b.command("resume", handleResume);
  b.command("status", handleStatus);
  b.command("stats", handleStats);
  b.command("logs", handleLogs);
  b.command("pending", handlePending);
  b.command("permission_stats", handlePermissionStats);
  b.command("session_export", handleSessionExport);
  b.command("tools", handleTools);
  b.command("skills", handleSkills);
  b.command("commands", handleCommands);
  b.command("hooks", handleHooks);
  b.command("rules", handleRules);

  // Session CLI commands
  b.command("add", handleAdd);
  b.command("model", handleModel);
  b.command("providers", handleProviders);
  b.command("models", handleModels);
  b.command("agents", handleAgents);
  b.command("tasks", handleTasks);
  b.command("orchestrate", handleOrchestrate);
  b.command("task", handleTask);

  // Codex
  b.command("codex_setup", handleCodexSetup);
  b.command("codex_status", handleCodexStatus);
  b.command("codex_review", handleCodexReview);

  // Remote control & project management
  b.command("interrupt", handleInterrupt);
  b.command("remote_control", handleRemoteControl);
  b.command("monitor", handleMonitor);
  b.command("projects", handleProjects);
  b.command("project_add", handleProjectAdd);
  b.command("project_facts", handleProjectFacts);
  b.command("project_scan", handleProjectScan);

  // Forum topic management
  b.command("forum_setup", handleForumSetup);
  b.command("forum_sync", handleForumSync);
  b.command("forum_clean", handleForumClean);
  b.command("forum_hub", handleForumHub);
  b.command("topic_rename", handleTopicRename);
  b.command("topic_close", handleTopicClose);
  b.command("topic_reopen", handleTopicReopen);

  // Inline keyboard callbacks (permissions, session switch)
  b.on("callback_query:data", handleCallbackQuery);

  // Media handlers
  b.on("message:photo", handlePhoto);
  b.on("message:document", handleDocument);
  b.on("message:voice", handleVoice);
  b.on("message:video", handleVideo);
  b.on("message:video_note", handleVideoNote);
  b.on("message:sticker", handleSticker);

  // Poll answers (non-anonymous polls)
  b.on("poll_answer", handlePollAnswer);

  // Supervisor topic — intercept text before sending to Claude
  b.on("message:text", async (ctx, next) => {
    const threadId = ctx.message?.message_thread_id;
    const supervisorTopicId = Number(process.env.SUPERVISOR_TOPIC_ID ?? "0");
    if (supervisorTopicId > 0 && threadId === supervisorTopicId) {
      const { handleSupervisorMessage } = await import("./commands/supervisor-actions.ts");
      return handleSupervisorMessage(ctx);
    }
    return next();
  });

  // Text messages → Claude (must be last)
  b.on("message:text", handleText);
}
