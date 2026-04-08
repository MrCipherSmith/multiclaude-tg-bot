/**
 * Stdio channel adapter for Claude Code.
 *
 * Usage: claude --channels "bun /path/to/claude-bot/channel.ts"
 *
 * This process:
 * 1. Connects to the shared PostgreSQL database
 * 2. Registers/adopts a named session (from CLAUDE.md set_session_name or auto-detected from cwd)
 * 3. Polls message_queue for incoming Telegram messages
 * 4. Sends them as notifications/claude/channel to Claude Code via stdio
 * 5. Exposes MCP tools (reply, react, edit_message, memory tools) over stdio
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startTypingRaw, type TypingHandle } from "./utils/typing.ts";
import { markdownToTelegramHtml } from "./bot/format.ts";
import { startTmuxMonitor, type TmuxMonitorHandle } from "./utils/tmux-monitor.ts";
import { startOutputMonitor, getOutputFilePath, type OutputMonitorHandle } from "./utils/output-monitor.ts";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  NotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import postgres from "postgres";
import { basename } from "path";

const PermissionRequestSchema = NotificationSchema.extend({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string().optional(),
    description: z.string().optional(),
    input_preview: z.string().optional(),
  }).passthrough(),
});

// Config read directly from env (not via config.ts) because channel.ts runs
// as a separate stdio process, not part of the main bot. This is intentional.
const DATABASE_URL = process.env.DATABASE_URL!;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
const POLL_INTERVAL_MS = 500;
const BOT_API_URL = process.env.BOT_API_URL ?? "http://localhost:3847";

if (!DATABASE_URL) {
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 3 });

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Detect project name from cwd
const projectName = basename(process.cwd());
const projectPath = process.cwd();
let sessionId: number | null = null;

// --- Embedding helper ---
async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`);
  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings[0];
}

// --- Session management ---
// source: "remote" (launched via run-cli.sh/tmux) or "local" (manual terminal)
const channelSource: "remote" | "local" = (process.env.CHANNEL_SOURCE === "remote") ? "remote" : "local";
let sessionName = `${projectName} · ${channelSource}`; // for logs only

async function resolveSession(): Promise<number> {
  // Look up session by project + source (not by name string)
  const existing = await sql`
    SELECT id FROM sessions
    WHERE project = ${projectName} AND source = ${channelSource} AND id != 0
    LIMIT 1
  `;

  if (existing.length > 0) {
    // Try to acquire the advisory lock (previous process may still be closing)
    for (let attempt = 0; attempt < 5; attempt++) {
      const lockResult = await sql`SELECT pg_try_advisory_lock(${existing[0].id}) as locked`;
      if (lockResult[0].locked) {
        sessionId = existing[0].id;
        hasPollingLock = true;
        // Also update project_id in case it wasn't set before
        let reattachProjectId: number | null = null;
        if (projectPath) {
          const [proj] = await sql`SELECT id FROM projects WHERE path = ${projectPath}`;
          reattachProjectId = proj?.id ?? null;
        }
        await sql`UPDATE sessions SET status = 'active', last_active = now(), project_id = ${reattachProjectId} WHERE id = ${sessionId}`;
        process.stderr.write(`[channel] attached to session #${sessionId} (${sessionName})\n`);
        return sessionId;
      }
      if (attempt < 4) {
        process.stderr.write(`[channel] session "${sessionName}" locked, retrying (${attempt + 1}/5)...\n`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // Lock failed — another instance is running
    if (channelSource === 'remote') {
      process.stderr.write(`[channel] remote session for project already active, exiting\n`);
      process.exit(0);
    }

    // Local session: create a parallel session with instance suffix
    const displacedSessionId = existing[0].id;
    const instanceNum = (Date.now() % 10000);
    sessionName = `${projectName} · ${channelSource} #${instanceNum}`;
    const clientId = `channel-${projectName}-${channelSource}-${Date.now()}`;
    process.stderr.write(`[channel] session busy, creating parallel: "${sessionName}"\n`);

    // Look up project_id from projects table
    let projectId: number | null = null;
    if (projectPath) {
      const [proj] = await sql`SELECT id FROM projects WHERE path = ${projectPath}`;
      projectId = proj?.id ?? null;
    }

    const [row] = await sql`
      INSERT INTO sessions (name, project, source, project_path, project_id, client_id, status)
      VALUES (${sessionName}, ${projectName}, ${channelSource}, ${projectPath}, ${projectId}, ${clientId}, 'active')
      RETURNING id
    `;
    sessionId = row.id;
    hasPollingLock = true;
    await sql`SELECT pg_advisory_lock(${sessionId})`;

    // Transfer chat routing from the busy session to this new one
    await sql`
      UPDATE chat_sessions SET active_session_id = ${sessionId}
      WHERE active_session_id = ${displacedSessionId}
    `;
    process.stderr.write(`[channel] created session #${sessionId} (${sessionName})\n`);
    return sessionId;
  }

  // No existing session — create one
  const clientId = `channel-${projectName}-${channelSource}-${Date.now()}`;

  // Look up project_id from projects table
  let projectId: number | null = null;
  if (projectPath) {
    const [proj] = await sql`SELECT id FROM projects WHERE path = ${projectPath}`;
    projectId = proj?.id ?? null;
  }

  const [row] = await sql`
    INSERT INTO sessions (name, project, source, project_path, project_id, client_id, status)
    VALUES (${sessionName}, ${projectName}, ${channelSource}, ${projectPath}, ${projectId}, ${clientId}, 'active')
    RETURNING id
  `;
  sessionId = row.id;
  hasPollingLock = true;
  await sql`SELECT pg_advisory_lock(${sessionId})`;
  process.stderr.write(`[channel] created session #${sessionId} (${sessionName})\n`);

  // Transfer chat routing from any old sessions with the same project_path
  await sql`
    UPDATE chat_sessions SET active_session_id = ${sessionId}
    WHERE active_session_id IN (
      SELECT id FROM sessions WHERE project_path = ${projectPath} AND id != ${sessionId}
    )
  `;

  // Delete placeholder sessions (registered via API, never had a real process)
  // identified by client_id pattern 'claude-{project}-{timestamp}'
  await sql`
    DELETE FROM sessions
    WHERE project_path = ${projectPath}
      AND id != ${sessionId}
      AND status = 'disconnected'
      AND client_id LIKE 'claude-%'
  `;

  return sessionId;
}

// --- Idle timer for summarization ---
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS ?? 900_000); // 15 min
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function touchIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    await triggerSummarize();
  }, IDLE_TIMEOUT_MS);
}

async function triggerSummarize(): Promise<void> {
  if (sessionId === null) return;
  try {
    if (channelSource === "local") {
      // Work session summary — endpoint handles status='terminated' and archival
      process.stderr.write(`[channel] triggering work summary for local session #${sessionId}\n`);
      await fetch(`${BOT_API_URL}/api/sessions/${sessionId}/summarize-work`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
    } else {
      // Remote session — Telegram conversation summary
      process.stderr.write(`[channel] triggering summarization for session #${sessionId}\n`);
      await fetch(`${BOT_API_URL}/api/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, project_path: projectPath }),
      });
    }
  } catch (err) {
    process.stderr.write(`[channel] summarize request failed: ${err}\n`);
  }
}

// --- Graceful disconnect ---
async function markDisconnected(): Promise<void> {
  if (sessionId === null) return;
  // Summarize before disconnect so context is preserved
  await triggerSummarize();
  try {
    const newStatus = channelSource === "remote" ? "inactive" : "terminated";
    await sql`
      UPDATE sessions SET status = ${newStatus}, last_active = now()
      WHERE id = ${sessionId}
    `;
    process.stderr.write(`[channel] session #${sessionId} marked ${newStatus}\n`);
    if (hasPollingLock) {
      await releasePollingLock();
      process.stderr.write(`[channel] released polling lock\n`);
    }
  } catch (err) {
    process.stderr.write(`[channel] failed to mark disconnected: ${err}\n`);
  }
}

// --- Auto-approve rules ---
// Loaded from settings.local.json and updated when user taps "Always"
const autoApprovePatterns = new Set<string>();

async function loadAutoApproveRules(): Promise<void> {
  const homeDir = process.env.HOME ?? "/root";
  const encodedPath = projectPath.replace(/\//g, "-");
  const paths = [
    `${homeDir}/.claude/projects/${encodedPath}/settings.local.json`,
    `${homeDir}/.claude/settings.local.json`,
  ];
  for (const p of paths) {
    try {
      const text = await Bun.file(p).text();
      const settings = JSON.parse(text);
      const patterns = settings?.permissions?.allow ?? [];
      for (const pat of patterns) autoApprovePatterns.add(pat);
    } catch {}
  }
  if (autoApprovePatterns.size > 0) {
    process.stderr.write(`[channel] auto-approve patterns: ${[...autoApprovePatterns].join(", ")}\n`);
  }
}

function isAutoApproved(toolName: string): boolean {
  if (autoApprovePatterns.has(`${toolName}(*)`)) return true;
  if (autoApprovePatterns.has(toolName)) return true;
  return false;
}

// --- MCP Server ---
const mcp = new Server(
  { name: "claude-bot-channel", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
    },
  },
);

// Handle permission requests from Claude Code
mcp.setNotificationHandler(
  PermissionRequestSchema,
  async (notification: any) => {
    const params = notification.params ?? notification;
    const request_id = params.request_id;
    const tool_name = params.tool_name;
    const description = params.description;

    // Auto-approve if tool is in always-allowed list
    if (isAutoApproved(tool_name)) {
      process.stderr.write(`[channel] auto-approved: ${tool_name}\n`);
      await mcp.notification({
        method: "notifications/claude/channel/permission",
        params: { request_id, behavior: "allow" },
      });
      return;
    }

    // input_preview is a JSON string, often truncated to ~200 chars
    let input: Record<string, any> = {};
    const rawPreview = params.input_preview ?? params.input ?? "";
    const previewStr = typeof rawPreview === "string" ? rawPreview : JSON.stringify(rawPreview);
    try {
      input = JSON.parse(previewStr);
    } catch {
      // Truncated JSON — extract fields with regex
      const fileMatch = previewStr.match(/"file_path"\s*:\s*"([^"]+)"/);
      const cmdMatch = previewStr.match(/"command"\s*:\s*"([^"]+)"/);
      const patternMatch = previewStr.match(/"pattern"\s*:\s*"([^"]+)"/);
      if (fileMatch) input.file_path = fileMatch[1];
      if (cmdMatch) input.command = cmdMatch[1];
      if (patternMatch) input.pattern = patternMatch[1];
      // Extract old_string/new_string — they sit between known JSON keys
      const oldMatch = previewStr.match(/"old_string"\s*:\s*"([\s\S]*?)(?:","new_string"|"$)/);
      const newMatch = previewStr.match(/"new_string"\s*:\s*"([\s\S]*?)(?:","replace_all"|","file_path"|"$|\s*\}?\s*$)/);
      if (oldMatch) input.old_string = oldMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
      if (newMatch) input.new_string = newMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
      // Extract content for Write
      const contentMatch = previewStr.match(/"content"\s*:\s*"([\s\S]*?)(?:"$|\s*\}?\s*$)/);
      if (contentMatch) input.content = contentMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }

    process.stderr.write(`[channel] permission: ${tool_name} input=${JSON.stringify(input).slice(0, 200)} raw_keys=${Object.keys(params).join(",")}\n`);
    if (Object.keys(input).length === 0) {
      process.stderr.write(`[channel] permission raw params: ${JSON.stringify(params).slice(0, 500)}\n`);
    }
    if (!sessionId) return;

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;

    // Find which chat_id this session is connected to
    const chatRows = await sql`
      SELECT chat_id FROM chat_sessions WHERE active_session_id = ${sessionId}
    `;
    const chatId = chatRows.length > 0 ? chatRows[0].chat_id : null;
    if (!chatId) {
      process.stderr.write(`[channel] no chat for session ${sessionId}, auto-denying\n`);
      return;
    }

    // Build detailed description
    let detail = "";
    if (tool_name === "Bash" && input.command) detail = `$ ${input.command}`;
    else if (tool_name === "Read" && input.file_path) detail = input.file_path;
    else if ((tool_name === "Edit" || tool_name === "Write") && input.file_path) {
      detail = input.file_path;
      if (input.old_string != null && input.new_string != null) {
        const oldLines = String(input.old_string).split("\n").map((l: string) => `- ${l}`);
        const newLines = String(input.new_string).split("\n").map((l: string) => `+ ${l}`);
        detail += `\n\n${[...oldLines, ...newLines].join("\n").slice(0, 1500)}`;
      } else if (input.content) {
        detail += `\n\n${String(input.content).slice(0, 1500)}`;
      }
    } else if (tool_name === "Grep" && input.pattern) detail = `grep "${input.pattern}"`;
    else if (input._raw) detail = input._raw;
    else detail = JSON.stringify(input).slice(0, 200);
    // Always show description from Claude Code
    if (description && detail && !detail.includes("\n\n")) {
      detail += `\n${description}`;
    } else if (description && !detail) {
      detail = description;
    }

    // Separate diff/content from the main description for <pre> formatting
    let descMain = tool_name;
    let descDiff = "";
    if (detail.includes("\n\n")) {
      const idx = detail.indexOf("\n\n");
      descMain += `\n${detail.slice(0, idx)}`;
      descDiff = detail.slice(idx + 2);
    } else {
      descMain += `\n${detail}`;
    }
    descMain = descMain.trim();
    const desc = descMain;

    // Build preview content from raw input_preview for Edit/Write/Bash (sent as separate message)
    let previewContent = "";
    if ((tool_name === "Edit" || tool_name === "Write" || tool_name === "Bash") && previewStr.length > 10) {
      // For Edit: try to build a readable diff from parsed input
      if (tool_name === "Edit" && input.old_string != null && input.new_string != null) {
        const oldLines = String(input.old_string).split("\n").map((l: string) => `- ${l}`);
        const newLines = String(input.new_string).split("\n").map((l: string) => `+ ${l}`);
        previewContent = [...oldLines, ...newLines].join("\n").slice(0, 3000);
      } else if (tool_name === "Write" && input.content) {
        previewContent = String(input.content).slice(0, 3000);
      } else if (tool_name === "Bash" && input.command && input.command.length > 80) {
        previewContent = input.command.slice(0, 3000);
      }
      // No raw JSON fallback — only show structured previews
    }

    // Update status message with what CLI is doing
    const shortDesc = tool_name === "Bash" ? `Running: ${String(input?.command ?? "").slice(0, 60)}`
      : tool_name === "Read" ? `Reading: ${String(input?.file_path ?? "").split("/").pop()}`
      : tool_name === "Edit" || tool_name === "Write" ? `Editing: ${String(input?.file_path ?? "").split("/").pop()}`
      : tool_name === "Grep" ? `Searching: ${String(input?.pattern ?? "").slice(0, 40)}`
      : `${tool_name}`;
    await updateStatus(chatId, shortDesc);

    // Send preview as a separate message (will be deleted after user responds)
    let previewMsgId: number | null = null;
    if (previewContent) {
      try {
        const lang = tool_name === "Edit" ? "diff" : "";
        const filePath = String(input?.file_path ?? input?.command ?? "").split("/").slice(-2).join("/");
        const header = filePath ? `${filePath}:\n` : "";
        const previewRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: Number(chatId),
            text: `${escapeHtml(header)}<pre><code class="language-${lang}">${escapeHtml(previewContent)}</code></pre>`,
            parse_mode: "HTML",
          }),
        });
        if (previewRes.ok) {
          const previewData = (await previewRes.json()) as any;
          previewMsgId = previewData.result?.message_id ?? null;
        }
      } catch {}
    }

    // Send inline keyboard to Telegram (3 buttons: Allow / Always / Deny)
    // If preview was already sent as separate message, don't duplicate diff in permission message
    const showDiffInline = descDiff && !previewContent;
    const msgText = showDiffInline
      ? `🔐 Allow?\n\n${escapeHtml(descMain)}\n\n<pre><code class="language-diff">${escapeHtml(descDiff)}</code></pre>`
      : `🔐 Allow?\n\n${escapeHtml(descMain)}`;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: Number(chatId),
        text: msgText,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Yes", callback_data: `perm:allow:${request_id}` },
            { text: "✅ Always", callback_data: `perm:always:${request_id}` },
            { text: "❌ No", callback_data: `perm:deny:${request_id}` },
          ]],
        },
      }),
    });

    let telegramMsgId: number | null = null;
    if (res.ok) {
      const data = (await res.json()) as any;
      telegramMsgId = data.result?.message_id;

      await sql`
        INSERT INTO permission_requests (id, session_id, chat_id, tool_name, description, message_id)
        VALUES (${request_id}, ${sessionId}, ${chatId}, ${tool_name ?? "unknown"}, ${desc}, ${telegramMsgId})
        ON CONFLICT (id) DO NOTHING
      `;
    }

    // Poll for response (from Telegram buttons)
    const startTime = Date.now();
    const TIMEOUT = 120_000;
    let resolved = false;

    while (Date.now() - startTime < TIMEOUT) {
      // Check if Telegram user responded
      const rows = await sql`
        SELECT response FROM permission_requests WHERE id = ${request_id} AND response IS NOT NULL
      `;
      if (rows.length > 0) {
        const behavior = rows[0].response;
        await mcp.notification({
          method: "notifications/claude/channel/permission",
          params: { request_id, behavior },
        });
        process.stderr.write(`[channel] permission ${request_id}: ${behavior} (telegram)\n`);
        if (previewMsgId) deleteTelegramMessage(chatId, previewMsgId);
        await updateStatus(chatId, "Processing...");
        // Reload auto-approve rules in case user tapped "Always"
        loadAutoApproveRules().catch(() => {});
        resolved = true;
        break;
      }

      // Check if permission was resolved in terminal (record deleted = CLI moved on)
      const exists = await sql`SELECT 1 FROM permission_requests WHERE id = ${request_id}`;
      if (exists.length === 0) {
        // Record deleted by another path — resolved elsewhere
        process.stderr.write(`[channel] permission ${request_id}: resolved externally\n`);
        if (previewMsgId) deleteTelegramMessage(chatId, previewMsgId);
        if (telegramMsgId) {
          await editTelegramMessage(chatId, telegramMsgId, `⚡ Resolved in terminal\n\n${desc}`);
        }
        await updateStatus(chatId, "Processing...");
        resolved = true;
        break;
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    if (!resolved) {
      // Timeout — deny
      process.stderr.write(`[channel] permission ${request_id}: timeout, denying\n`);
      await mcp.notification({
        method: "notifications/claude/channel/permission",
        params: { request_id, behavior: "deny" },
      });
      if (previewMsgId) deleteTelegramMessage(chatId, previewMsgId);
      if (telegramMsgId) {
        await editTelegramMessage(chatId, telegramMsgId, `⏰ Timeout\n\n${desc}`);
      }
    }

    await sql`DELETE FROM permission_requests WHERE id = ${request_id}`;
  },
);

// --- Tools ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a message to a Telegram chat",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "Telegram chat ID" },
          text: { type: "string", description: "Message text" },
        },
        required: ["chat_id", "text"],
      },
    },
    {
      name: "remember",
      description: "Save information to long-term memory",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "What to remember" },
          type: { type: "string", enum: ["fact", "summary", "decision", "note"], default: "note" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["content"],
      },
    },
    {
      name: "recall",
      description: "Semantic search through long-term memory",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", default: 5 },
        },
        required: ["query"],
      },
    },
    {
      name: "forget",
      description: "Delete a memory by ID",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Memory ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "update_status",
      description: "Update the status message shown to the user in Telegram while processing. Call this before major operations to keep the user informed. Optionally include a diff to show file changes.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "Telegram chat ID" },
          status: { type: "string", description: "Short status text, e.g. 'Analyzing code', 'Running tests'" },
          diff: { type: "string", description: "Optional diff/code block to display as a separate message. Supports markdown formatting." },
        },
        required: ["chat_id", "status"],
      },
    },
    {
      name: "list_memories",
      description: "List memories with optional filters",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["fact", "summary", "decision", "note"] },
          limit: { type: "number", default: 20 },
        },
      },
    },
    {
      name: "search_project_context",
      description: "Semantic search over long-term project context and work summaries. Use when you need knowledge from prior sessions about this project.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          project_path: { type: "string", description: "Project path to search in. Defaults to current session project_path." },
          limit: { type: "number", description: "Number of results to return (default: 5, max: 20)" },
        },
        required: ["query"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  // Touch session activity on every tool call
  if (sessionId !== null) {
    sql`UPDATE sessions SET last_active = now() WHERE id = ${sessionId}`.catch(() => {});
  }

  switch (name) {
    case "reply": {
      const chatId = String(args!.chat_id);
      // Stop everything: typing, status, tmux monitor
      stopTypingForChat(chatId);
      stopProgressMonitorForChat(chatId);
      await deleteStatusMessage(chatId);

      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        process.stderr.write(`[channel] reply failed: no TELEGRAM_BOT_TOKEN\n`);
        return text("TELEGRAM_BOT_TOKEN not set");
      }

      // Check if this session is still active for this chat
      const activeCheck = await sql`
        SELECT active_session_id FROM chat_sessions WHERE chat_id = ${chatId}
      `;
      const isActive = activeCheck.length === 0 || activeCheck[0].active_session_id === sessionId;

      // If not active, prefix with session name so user knows the source
      let replyText = String(args!.text);
      const isBackground = !isActive && sessionId;
      if (isBackground) {
        const bgName = sessionName || `#${sessionId}`;
        replyText = `📌 **${bgName}**\n\n${replyText}\n\n_/switch ${sessionId} — switch_`;
        process.stderr.write(`[channel] reply from background session ${bgName}\n`);
      }

      process.stderr.write(`[channel] sending reply to ${chatId}: ${replyText.slice(0, 50)}...\n`);
      const htmlText = markdownToTelegramHtml(replyText);

      // Inline button for background sessions
      const replyMarkup = isBackground
        ? { inline_keyboard: [[{ text: "↩️ Switch and reply", callback_data: `switch:${sessionId}` }]] }
        : undefined;

      // Try HTML first, fallback to plain text
      let res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: Number(args!.chat_id),
          text: htmlText,
          parse_mode: "HTML",
          ...(replyMarkup && { reply_markup: replyMarkup }),
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        if (errBody.includes("can't parse entities")) {
          // Fallback to plain text
          res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: Number(args!.chat_id),
              text: replyText,
              ...(replyMarkup && { reply_markup: replyMarkup }),
            }),
          });
          if (!res.ok) {
            const fallbackErr = await res.text();
            process.stderr.write(`[channel] Telegram API error: ${res.status} ${fallbackErr}\n`);
            return text(`Telegram API error: ${res.status}`);
          }
        } else {
          process.stderr.write(`[channel] Telegram API error: ${res.status} ${errBody}\n`);
          return text(`Telegram API error: ${res.status}`);
        }
      }
      process.stderr.write(`[channel] reply sent OK\n`);
      // Save assistant response to short-term memory
      if (sessionId) {
        await sql`
          INSERT INTO messages (session_id, project_path, chat_id, role, content)
          VALUES (${sessionId}, ${projectPath}, ${String(args!.chat_id)}, 'assistant', ${String(args!.text)})
        `;
      }
      touchIdleTimer();
      return text(`Sent to chat ${args!.chat_id}`);
    }

    case "remember": {
      const content = String(args!.content);
      const embedding = await embed(content);
      const embeddingStr = `[${embedding.join(",")}]`;
      const [row] = await sql`
        INSERT INTO memories (source, session_id, project_path, type, content, tags, embedding)
        VALUES ('cli', ${sessionId}, ${projectPath}, ${String(args!.type ?? "note")}, ${content}, ${(args!.tags as string[]) ?? []}, ${embeddingStr}::vector)
        RETURNING id
      `;
      return text(`Saved memory #${row.id}`);
    }

    case "recall": {
      const queryEmb = await embed(String(args!.query));
      const embStr = `[${queryEmb.join(",")}]`;
      const limit = Number(args!.limit ?? 5);
      const rows = await sql`
        SELECT id, type, content, embedding <=> ${embStr}::vector AS distance
        FROM memories
        WHERE project_path = ${projectPath} OR project_path IS NULL
        ORDER BY embedding <=> ${embStr}::vector
        LIMIT ${limit}
      `;
      if (rows.length === 0) return text("No relevant memories found.");
      const formatted = rows
        .map((r: any) => `#${r.id} [${r.type}] (${Number(r.distance).toFixed(3)}) ${r.content}`)
        .join("\n\n");
      return text(formatted);
    }

    case "forget": {
      const result = await sql`DELETE FROM memories WHERE id = ${Number(args!.id)} RETURNING id`;
      return text(result.length > 0 ? `Deleted #${args!.id}` : `#${args!.id} not found`);
    }

    case "update_status": {
      const chatId = String(args!.chat_id);
      await updateStatus(chatId, String(args!.status));

      // Send optional diff as a separate formatted message
      if (args!.diff) {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (token) {
          const htmlDiff = markdownToTelegramHtml(String(args!.diff));
          let res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: Number(chatId),
              text: htmlDiff,
              parse_mode: "HTML",
            }),
          });
          // Fallback to plain text if HTML parse fails
          if (!res.ok) {
            const errBody = await res.text();
            if (errBody.includes("can't parse entities")) {
              await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id: Number(chatId),
                  text: String(args!.diff),
                }),
              });
            }
          }
        }
      }

      return text(`Status updated: ${args!.status}`);
    }

    case "list_memories": {
      const rows = await sql`
        SELECT id, type, content FROM memories
        WHERE (project_path = ${projectPath} OR project_path IS NULL)
          ${args!.type ? sql`AND type = ${String(args!.type)}` : sql``}
        ORDER BY created_at DESC
        LIMIT ${Number(args!.limit ?? 20)}
      `;
      if (rows.length === 0) return text("No memories found.");
      return text(rows.map((r: any) => `#${r.id} [${r.type}] ${r.content.slice(0, 100)}`).join("\n"));
    }

    case "search_project_context": {
      const query = String(args!.query ?? "");
      if (!query) return text("query is required");

      const searchPath = String(args!.project_path ?? projectPath ?? "");
      if (!searchPath) return text("no project_path available — pass it explicitly");

      const limit = Math.min(Number(args!.limit ?? 5), 20);

      const queryEmb = await embed(query);
      const embStr = `[${queryEmb.join(",")}]`;

      const rows = await sql`
        SELECT content, type, created_at,
               1 - (embedding <=> ${embStr}::vector) AS score
        FROM memories
        WHERE project_path = ${searchPath}
          AND type IN ('project_context', 'summary')
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${embStr}::vector
        LIMIT ${limit}
      `;

      process.stderr.write(`[search] project_context query="${query.slice(0, 50)}" project=${searchPath} → ${rows.length} results\n`);

      if (rows.length === 0) return text("No project context found.");
      return text(JSON.stringify({
        results: rows.map((r: any) => ({
          content: r.content as string,
          type: r.type as string,
          score: Number(r.score).toFixed(3),
          date: (r.created_at as Date).toISOString(),
        })),
      }, null, 2));
    }

    default:
      return text(`Unknown tool: ${name}`);
  }
});

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

// --- Telegram helpers ---

async function editTelegramMessage(chatId: string, messageId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(chatId), message_id: messageId, text }),
    });
  } catch {}
}

function deleteTelegramMessage(chatId: string, messageId: number): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(chatId), message_id: messageId }),
  }).catch(() => {});
}

// --- Status messages ---
interface StatusState {
  chatId: string;
  messageId: number;
  startedAt: number;
  stage: string;
  timer: ReturnType<typeof setInterval> | null;
}

const activeStatus = new Map<string, StatusState>();
// Last known token count per chat, extracted from tmux monitor spinner lines
const lastTokenInfo = new Map<string, string>();

function formatElapsed(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

async function getSessionPrefix(chatId: string): Promise<string> {
  if (!sessionId) return "";
  const activeCheck = await sql`
    SELECT active_session_id FROM chat_sessions WHERE chat_id = ${chatId}
  `;
  const isActive = activeCheck.length === 0 || activeCheck[0].active_session_id === sessionId;
  return isActive ? "" : `📌 ${sessionName} · `;
}

async function sendStatusMessage(chatId: string, stage: string): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    process.stderr.write(`[status] no TELEGRAM_BOT_TOKEN\n`);
    return "no TELEGRAM_BOT_TOKEN";
  }

  const prefix = await getSessionPrefix(chatId);

  // If status already exists, check if it needs to be re-sent (pushed up by other messages)
  const existing = activeStatus.get(chatId);
  if (existing) {
    // If stage changed significantly, delete old and send new (stays at bottom)
    if (existing.stage !== `${prefix}${stage}`) {
      // Delete old status silently
      try {
        await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: Number(chatId), message_id: existing.messageId }),
        });
      } catch {}

      // Clear timer but keep startedAt for elapsed time
      if (existing.timer) clearInterval(existing.timer);
      activeStatus.delete(chatId);

      // Fall through to create new message at bottom
    } else {
      // Same stage — just update elapsed time in place
      await editStatusMessage(existing);
      return null;
    }
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(chatId), text: `⏳ ${prefix}${stage}` }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      process.stderr.write(`[status] sendMessage error: ${res.status} ${errBody}\n`);
      return `Telegram API error: ${res.status}`;
    }

    const data = (await res.json()) as any;
    // Preserve original startedAt if re-creating (status was moved to bottom)
    const prevStartedAt = existing?.startedAt;
    const state: StatusState = {
      chatId,
      messageId: data.result?.message_id,
      startedAt: prevStartedAt ?? Date.now(),
      stage: `${prefix}${stage}`,
      timer: null,
    };

    // Update elapsed time every 5 seconds
    state.timer = setInterval(() => {
      editStatusMessage(state);
    }, 5000);
    activeStatus.set(chatId, state);
    process.stderr.write(`[status] created for chat ${chatId}, msg ${state.messageId}\n`);
    return null;
  } catch (e) {
    process.stderr.write(`[status] sendMessage exception: ${e}\n`);
    return `Exception: ${e}`;
  }
}

async function updateStatus(chatId: string, stage: string): Promise<void> {
  const state = activeStatus.get(chatId);
  if (!state) {
    await sendStatusMessage(chatId, stage);
    return;
  }
  state.stage = stage;
  await editStatusMessage(state);
}

async function editStatusMessage(state: StatusState): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const elapsed = formatElapsed(Date.now() - state.startedAt);
  const tokens = lastTokenInfo.get(state.chatId);
  const tokenStr = tokens ? ` · ↓ ${tokens}` : "";
  const text = `⏳ ${state.stage} (${elapsed}${tokenStr})`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: Number(state.chatId),
        message_id: state.messageId,
        text,
      }),
    });
  } catch {}
}

async function deleteStatusMessage(chatId: string): Promise<void> {
  const state = activeStatus.get(chatId);
  if (!state) return;

  if (state.timer) clearInterval(state.timer);
  activeStatus.delete(chatId);
  lastTokenInfo.delete(chatId);

  // Also stop typing indicator
  stopTypingForChat(chatId);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(state.chatId), message_id: state.messageId }),
    });
  } catch {}
}

// --- Typing indicators ---
// Track active typing handles per chat_id
const activeTyping = new Map<string, TypingHandle>();

const TYPING_TIMEOUT_MS = 30_000; // 30 seconds max

// --- progress monitor (tmux → output file fallback) ---
const activeMonitors = new Map<string, TmuxMonitorHandle | OutputMonitorHandle>();

async function startProgressMonitorForChat(chatId: string): Promise<void> {
  stopProgressMonitorForChat(chatId);

  const onStatus = (status: string) => {
    // Extract token count from spinner lines: "↓ 12.1k tokens" or "↓ 386 tokens"
    const tokenMatch = status.match(/↓\s*([\d.]+[kmKM]?\s*tokens)/i);
    if (tokenMatch) lastTokenInfo.set(chatId, tokenMatch[1].trim());
    updateStatus(chatId, status);
  };

  // Try tmux first, fall back to output file monitor
  let monitor = await startTmuxMonitor(projectName, onStatus);
  if (monitor) {
    activeMonitors.set(chatId, monitor);
    process.stderr.write(`[channel] tmux monitor started for ${projectName}\n`);
    return;
  }

  // Fallback: output file (written by run-cli.sh via `script`)
  const outputFile = getOutputFilePath(projectName);
  monitor = await startOutputMonitor(outputFile, onStatus);
  if (monitor) {
    activeMonitors.set(chatId, monitor);
    process.stderr.write(`[channel] output monitor started: ${outputFile}\n`);
  }
}

function stopProgressMonitorForChat(chatId: string): void {
  const monitor = activeMonitors.get(chatId);
  if (monitor) {
    monitor.stop();
    activeMonitors.delete(chatId);
  }
}

function startTypingForChat(chatId: string): void {
  // Don't start if already typing for this chat
  if (activeTyping.has(chatId)) return;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const handle = startTypingRaw(token, chatId);
  activeTyping.set(chatId, handle);

  // Auto-stop after timeout
  setTimeout(() => stopTypingForChat(chatId), TYPING_TIMEOUT_MS);
}

function stopTypingForChat(chatId: string): void {
  const handle = activeTyping.get(chatId);
  if (handle) {
    handle.stop();
    activeTyping.delete(chatId);
  }
}

// --- Message queue poller ---
let polling = true;
let hasPollingLock = false;

async function acquirePollingLock(): Promise<boolean> {
  if (sessionId === null) return false;
  const result = await sql`SELECT pg_try_advisory_lock(${sessionId}) as locked`;
  return result[0].locked;
}

async function releasePollingLock(): Promise<void> {
  if (sessionId === null) return;
  await sql`SELECT pg_advisory_unlock(${sessionId})`.catch(() => {});
}

// Wake signal: LISTEN/NOTIFY triggers immediate poll instead of waiting POLL_INTERVAL_MS
let wakeResolve: (() => void) | null = null;

async function setupListenNotify(): Promise<void> {
  try {
    // Use a separate connection for LISTEN (it stays open)
    const listenSql = postgres(DATABASE_URL, { max: 1 });
    await listenSql.listen(`message_queue_${sessionId}`, () => {
      if (wakeResolve) { wakeResolve(); wakeResolve = null; }
    });
    process.stderr.write(`[channel] LISTEN/NOTIFY active for session #${sessionId}\n`);
  } catch (err) {
    process.stderr.write(`[channel] LISTEN/NOTIFY setup failed, falling back to polling: ${err}\n`);
  }
}

function waitForWakeOrTimeout(): Promise<void> {
  return new Promise((resolve) => {
    wakeResolve = resolve;
    setTimeout(() => { wakeResolve = null; resolve(); }, POLL_INTERVAL_MS);
  });
}

async function pollMessages() {
  // Try to set up instant wake via LISTEN/NOTIFY
  if (sessionId !== null) await setupListenNotify();

  while (polling) {
    try {
      if (sessionId === null) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      const rows = await sql`
        UPDATE message_queue
        SET delivered = true
        WHERE id IN (
          SELECT id FROM message_queue
          WHERE session_id = ${sessionId} AND delivered = false
          ORDER BY created_at
          LIMIT 10
        )
        RETURNING id, chat_id, from_user, content, message_id, created_at
      `;

      for (const row of rows) {
        process.stderr.write(`[channel] polling found msg #${row.id} for session ${sessionId}: ${row.content.slice(0, 50)}\n`);

        // Start typing indicator — will keep sending until CLI replies
        startTypingForChat(row.chat_id);

        // Send status message to Telegram
        await sendStatusMessage(row.chat_id, "Thinking...");

        // Start tmux monitor for real-time progress
        await startProgressMonitorForChat(row.chat_id);

        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: row.content,
            meta: {
              chat_id: row.chat_id,
              user: row.from_user,
              message_id: row.message_id || undefined,
              ts: new Date(row.created_at).toISOString(),
            },
          },
        });
        process.stderr.write(`[channel] delivered message from ${row.from_user}: ${row.content.slice(0, 50)}\n`);
        touchIdleTimer();
      }
    } catch (err) {
      process.stderr.write(`[channel] poll error: ${err}\n`);
    }

    // Wait for NOTIFY wake signal or fall back to polling interval
    await waitForWakeOrTimeout();
  }
}

// --- Main ---
async function main() {
  await resolveSession();

  // Notify the HTTP MCP server that an HTTP transport is expected for this session.
  // This allows the server to auto-link the transport without LLM calling set_session_name.
  if (sessionId !== null) {
    try {
      const res = await fetch(`${BOT_API_URL}/api/sessions/expect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (res.ok) {
        process.stderr.write(`[channel] registered expect for session #${sessionId}\n`);
      } else {
        process.stderr.write(`[channel] expect registration failed: ${res.status}\n`);
      }
    } catch (err: any) {
      process.stderr.write(`[channel] expect registration error: ${err?.message}\n`);
    }
  }

  await loadAutoApproveRules();

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  process.stderr.write(`[channel] connected to Claude Code via stdio\n`);

  // Start polling
  pollMessages();

  // Heartbeat: keep last_active fresh so cleanup doesn't mark this session stale
  // during long autonomous tasks where no MCP tools are called for >10 minutes.
  const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const heartbeatTimer = setInterval(async () => {
    if (sessionId === null) return;
    await sql`UPDATE sessions SET last_active = now() WHERE id = ${sessionId}`.catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  // Graceful shutdown (guard against multiple calls)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    polling = false;
    clearInterval(heartbeatTimer);
    if (idleTimer) clearTimeout(idleTimer);
    await markDisconnected();
    await sql.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
  process.stdin.on("end", shutdown);
}

main().catch(async (err) => {
  process.stderr.write(`[channel] fatal: ${err}\n`);
  await markDisconnected();
  await sql.end();
  process.exit(1);
});
