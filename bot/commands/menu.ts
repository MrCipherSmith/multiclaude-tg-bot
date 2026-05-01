/**
 * /menu — two-level command navigator.
 *
 * Level 1: group buttons (Projects, Memory, System, …)
 * Level 2: command buttons within a group
 * Tap a command → calls the handler directly (handlers handle no-arg case themselves)
 *
 * Callback prefix: menu:
 *   menu:home          — show group list (topic-aware: encodes 't' flag)
 *   menu:g:<groupId>   — show commands for group
 *   menu:r:<command>   — run command
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getForumChatId } from "../forum-cache.ts";

interface CommandDef {
  name: string;
  label: string;
}

interface Group {
  id: string;
  label: string;
  topicOnly?: boolean;   // show only in topic context
  dmOnly?: boolean;      // show only in DM context
  commands: CommandDef[];
}

const GROUPS: Group[] = [
  {
    id: "projects",
    label: "📁 Projects",
    commands: [
      { name: "projects",      label: "📋 List" },
      { name: "project_add",   label: "➕ Add" },
      { name: "project_facts", label: "🔍 Facts" },
      { name: "project_scan",  label: "🔄 Scan" },
    ],
  },
  {
    id: "session",
    label: "💬 Session",
    dmOnly: true,
    commands: [
      { name: "sessions",   label: "📋 List" },
      { name: "switch",     label: "🔀 Switch" },
      { name: "session",    label: "ℹ️ Info" },
      { name: "resume",     label: "▶️ Resume" },
      { name: "model",      label: "🤖 Model" },
      { name: "standalone", label: "🔌 Standalone" },
      { name: "rename",     label: "✏️ Rename" },
      { name: "clear",      label: "🗑 Clear" },
      { name: "summarize",  label: "📝 Summarize" },
      { name: "cleanup",    label: "🧹 Cleanup" },
    ],
  },
  {
    id: "memory",
    label: "🧠 Memory",
    commands: [
      { name: "remember",      label: "💾 Remember" },
      { name: "recall",        label: "🔍 Recall" },
      { name: "memories",      label: "📚 List" },
      { name: "forget",        label: "🗑 Forget" },
      { name: "memory_export", label: "📤 Export" },
      { name: "memory_import", label: "📥 Import" },
    ],
  },
  {
    id: "system",
    label: "🖥 System",
    commands: [
      { name: "system",         label: "🖥 Control" },
      { name: "monitor",        label: "📊 Monitor" },
      { name: "remote_control", label: "🎮 Remote" },
      { name: "interrupt",      label: "⚡ Interrupt" },
    ],
  },
  {
    id: "stats",
    label: "📊 Stats",
    commands: [
      { name: "stats",            label: "📈 API stats" },
      { name: "logs",             label: "📋 Logs" },
      { name: "status",           label: "💚 Health" },
      { name: "pending",          label: "⏳ Pending" },
      { name: "permission_stats", label: "🔐 Perms" },
      { name: "session_export",   label: "📤 Export" },
    ],
  },
  {
    id: "tools",
    label: "🔧 Tools",
    commands: [
      { name: "skills",   label: "⚡ Skills" },
      { name: "rules",    label: "📏 Rules" },
      { name: "commands", label: "📋 Commands" },
      { name: "hooks",    label: "🪝 Hooks" },
      { name: "tools",    label: "🔧 Tools" },
    ],
  },
  {
    id: "codex",
    label: "🤖 Codex",
    commands: [
      { name: "codex_setup",  label: "🔑 Setup" },
      { name: "codex_review", label: "👁 Review" },
    ],
  },
  {
    id: "forum",
    label: "🗂 Forum",
    commands: [
      { name: "forum_setup",  label: "⚙️ Setup" },
      { name: "forum_sync",   label: "🔄 Sync" },
      { name: "forum_clean",  label: "🧹 Clean" },
      { name: "forum_hub",    label: "📌 Hub" },
      { name: "topic_rename", label: "✏️ Rename topic" },
      { name: "topic_close",  label: "🔒 Close topic" },
      { name: "topic_reopen", label: "🔓 Reopen topic" },
    ],
  },
];

const GROUP_MAP = new Map(GROUPS.map((g) => [g.id, g]));

// ── Topic detection ────────────────────────────────────────────────────────

async function isForumTopic(ctx: Context): Promise<boolean> {
  const chatId = String(ctx.chat?.id ?? "");
  const threadId = ctx.message?.message_thread_id
    ?? (ctx.callbackQuery?.message as any)?.message_thread_id;
  if (!threadId || threadId <= 1) return false;
  const forumChatId = await getForumChatId();
  return forumChatId !== null && chatId === forumChatId;
}

// ── Keyboards ──────────────────────────────────────────────────────────────

function groupsKeyboard(isTopic: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  const visible = GROUPS.filter((g) => {
    if (isTopic && g.dmOnly) return false;
    if (!isTopic && g.topicOnly) return false;
    return true;
  });
  visible.forEach((g, i) => {
    kb.text(g.label, `menu:g:${g.id}`);
    if (i % 2 === 1) kb.row();
  });
  if (visible.length % 2 !== 0) kb.row();
  kb.text("❓ Help", "menu:r:help").text("📖 Quickstart", "menu:r:quickstart");
  return kb;
}

function commandsKeyboard(group: Group): InlineKeyboard {
  const kb = new InlineKeyboard();
  group.commands.forEach((cmd, i) => {
    kb.text(cmd.label, `menu:r:${cmd.name}`);
    if (i % 2 === 1) kb.row();
  });
  if (group.commands.length % 2 !== 0) kb.row();
  kb.text("◀️ Back", "menu:home");
  return kb;
}

// ── Handlers ───────────────────────────────────────────────────────────────

export async function handleMenu(ctx: Context): Promise<void> {
  const topic = await isForumTopic(ctx);
  await ctx.reply("Choose a category:", { reply_markup: groupsKeyboard(topic) });
}

function ignoreNotModified(err: unknown): void {
  if (err instanceof Error && err.message.includes("message is not modified")) return;
  throw err;
}

export async function handleMenuCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const rest = data.slice("menu:".length); // "home" | "g:<id>" | "r:<cmd>"

  if (rest === "home") {
    const topic = await isForumTopic(ctx);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Choose a category:", { reply_markup: groupsKeyboard(topic) }).catch(ignoreNotModified);
    return;
  }

  if (rest.startsWith("g:")) {
    const groupId = rest.slice(2);
    const group = GROUP_MAP.get(groupId);
    if (!group) { await ctx.answerCallbackQuery({ text: "Unknown group" }); return; }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(group.label, { reply_markup: commandsKeyboard(group) }).catch(ignoreNotModified);
    return;
  }

  if (rest.startsWith("r:")) {
    const cmdName = rest.slice(2);
    await ctx.answerCallbackQuery({ text: `/${cmdName}` });
    await ctx.deleteMessage().catch(() => {});
    await dispatch(ctx, cmdName);
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown action" });
}

// ── Command dispatcher ─────────────────────────────────────────────────────

async function dispatch(ctx: Context, name: string): Promise<void> {
  switch (name) {
    // Session
    case "sessions":    { const { handleSessions }    = await import("./session.ts");  await handleSessions(ctx);    break; }
    case "switch":      { const { handleSwitch }      = await import("./session.ts");  await handleSwitch(ctx);      break; }
    case "session":     { const { handleSessionInfo } = await import("./session.ts");  await handleSessionInfo(ctx); break; }
    case "resume":      { const { handleResume }      = await import("./resume.ts");   await handleResume(ctx);      break; }
    case "model":       { const { handleModel }       = await import("./model.ts");    await handleModel(ctx);       break; }
    case "standalone":  { const { handleSwitchTo }    = await import("./session.ts");  await handleSwitchTo(ctx, 0); break; }
    case "rename":      { const { handleRename }      = await import("./session.ts");  await handleRename(ctx);      break; }
    case "clear":       { const { handleClear }       = await import("./memory.ts");   await handleClear(ctx);       break; }
    case "summarize":   { const { handleSummarize }   = await import("./memory.ts");   await handleSummarize(ctx);   break; }
    case "cleanup":     { const { handleCleanup }     = await import("./session.ts");  await handleCleanup(ctx);     break; }
    // Memory
    case "remember":      { const { handleRemember }     = await import("./memory.ts");        await handleRemember(ctx);     break; }
    case "recall":        { const { handleRecall }       = await import("./memory.ts");        await handleRecall(ctx);       break; }
    case "memories":      { const { handleMemories }     = await import("./memory.ts");        await handleMemories(ctx);     break; }
    case "forget":        { const { handleForget }       = await import("./memory.ts");        await handleForget(ctx);       break; }
    case "memory_export": { const { handleMemoryExport } = await import("./memory-export.ts"); await handleMemoryExport(ctx); break; }
    case "memory_import": { const { handleMemoryImport } = await import("./memory-export.ts"); await handleMemoryImport(ctx); break; }
    // Projects
    case "projects":      { const { handleProjects }     = await import("./projects.ts");      await handleProjects(ctx);     break; }
    case "project_add":   { const { handleProjectAdd }   = await import("./project-add.ts");   await handleProjectAdd(ctx);   break; }
    case "project_facts": { const { handleProjectFacts } = await import("./project-facts.ts"); await handleProjectFacts(ctx); break; }
    case "project_scan":  { const { handleProjectScan }  = await import("./project-facts.ts"); await handleProjectScan(ctx);  break; }
    // System
    case "system":         { const { handleSystem }        = await import("./system.ts");        await handleSystem(ctx);        break; }
    case "monitor":        { const { handleMonitor }       = await import("./monitor.ts");        await handleMonitor(ctx);       break; }
    case "remote_control": { const { handleRemoteControl } = await import("./remote-control.ts"); await handleRemoteControl(ctx); break; }
    case "interrupt":      { const { handleInterrupt }     = await import("./interrupt.ts");      await handleInterrupt(ctx);     break; }
    // Stats
    case "stats":            { const { handleStats }           = await import("./admin.ts"); await handleStats(ctx);           break; }
    case "logs":             { const { handleLogs }            = await import("./admin.ts"); await handleLogs(ctx);            break; }
    case "status":           { const { handleStatus }          = await import("./admin.ts"); await handleStatus(ctx);          break; }
    case "pending":          { const { handlePending }         = await import("./admin.ts"); await handlePending(ctx);         break; }
    case "permission_stats": { const { handlePermissionStats } = await import("./admin.ts"); await handlePermissionStats(ctx); break; }
    case "session_export":   { const { handleSessionExport }   = await import("./admin.ts"); await handleSessionExport(ctx);   break; }
    // Tools
    case "skills":   { const { handleSkills }   = await import("./admin.ts"); await handleSkills(ctx);   break; }
    case "rules":    { const { handleRules }    = await import("./admin.ts"); await handleRules(ctx);    break; }
    case "commands": { const { handleCommands } = await import("./admin.ts"); await handleCommands(ctx); break; }
    case "hooks":    { const { handleHooks }    = await import("./admin.ts"); await handleHooks(ctx);    break; }
    case "tools":    { const { handleTools }    = await import("./admin.ts"); await handleTools(ctx);    break; }
    // Codex
    case "codex_setup":  { const { handleCodexSetup }  = await import("./codex.ts"); await handleCodexSetup(ctx);  break; }
    case "codex_review": { const { handleCodexReview } = await import("./codex.ts"); await handleCodexReview(ctx); break; }
    // Forum
    case "forum_setup":  { const { handleForumSetup }  = await import("./forum.ts"); await handleForumSetup(ctx);  break; }
    case "forum_sync":   { const { handleForumSync }   = await import("./forum.ts"); await handleForumSync(ctx);   break; }
    case "forum_clean":  { const { handleForumClean }  = await import("./forum.ts"); await handleForumClean(ctx);  break; }
    case "forum_hub":    { const { handleForumHub }    = await import("./forum.ts"); await handleForumHub(ctx);    break; }
    case "topic_rename": { const { handleTopicRename } = await import("./forum.ts"); await handleTopicRename(ctx); break; }
    case "topic_close":  { const { handleTopicClose }  = await import("./forum.ts"); await handleTopicClose(ctx);  break; }
    case "topic_reopen": { const { handleTopicReopen } = await import("./forum.ts"); await handleTopicReopen(ctx); break; }
    // Help
    case "help":       { const { handleHelp }       = await import("./session.ts");   await handleHelp(ctx);       break; }
    case "quickstart": { const { handleQuickstart } = await import("./quickstart.ts"); await handleQuickstart(ctx); break; }

    default:
      await ctx.reply(`Unknown command: /${name}`);
  }
}
