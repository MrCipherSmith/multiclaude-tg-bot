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

export function setPendingInput(chatId: string, handler: (ctx: Context) => Promise<void>): void {
  // Clear existing timer
  const existing = pendingInputTimers.get(chatId);
  if (existing) clearTimeout(existing);

  pendingInput.set(chatId, handler);
  pendingInputTimers.set(chatId, setTimeout(() => {
    pendingInput.delete(chatId);
    pendingInputTimers.delete(chatId);
  }, 60_000)); // 60s TTL
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
import { handleStats, handleLogs, handleStatus, handlePending, handleTools, handleSkills, handleCommands, handleHooks, handleRules } from "./commands/admin.ts";
import { handleAdd } from "./commands/add.ts";
import { handleModel } from "./commands/model.ts";
import { handleConnections } from "./commands/connections.ts";
import { handleVoice, handlePhoto, handleDocument, handleVideo, handleVideoNote, handleSticker } from "./media.ts";
import { handleCallbackQuery } from "./callbacks.ts";
import { handleText } from "./text-handler.ts";

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

  // Memory commands
  b.command("remember", handleRemember);
  b.command("recall", handleRecall);
  b.command("memories", handleMemories);
  b.command("forget", handleForget);

  // Utility commands
  b.command("clear", handleClear);
  b.command("remove", handleRemove);
  b.command("cleanup", handleCleanup);
  b.command("summarize", handleSummarize);
  b.command("status", handleStatus);
  b.command("stats", handleStats);
  b.command("logs", handleLogs);
  b.command("pending", handlePending);
  b.command("tools", handleTools);
  b.command("skills", handleSkills);
  b.command("commands", handleCommands);
  b.command("hooks", handleHooks);
  b.command("rules", handleRules);

  // Provider commands
  b.command("add", handleAdd);
  b.command("model", handleModel);
  b.command("connections", handleConnections);

  // Inline keyboard callbacks (permissions, session switch)
  b.on("callback_query:data", handleCallbackQuery);

  // Media handlers
  b.on("message:photo", handlePhoto);
  b.on("message:document", handleDocument);
  b.on("message:voice", handleVoice);
  b.on("message:video", handleVideo);
  b.on("message:video_note", handleVideoNote);
  b.on("message:sticker", handleSticker);

  // Text messages → Claude (must be last)
  b.on("message:text", handleText);
}
