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

// Read config from env or defaults
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

// Detect project name from cwd
const projectName = basename(process.cwd());
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
async function resolveSession(): Promise<number> {
  // Try to find existing named session for this project
  const existing = await sql`
    SELECT id FROM sessions WHERE name = ${projectName} AND id != 0 LIMIT 1
  `;
  if (existing.length > 0) {
    sessionId = existing[0].id;
    await sql`
      UPDATE sessions SET status = 'active', last_active = now()
      WHERE id = ${sessionId}
    `;
    process.stderr.write(`[channel] attached to session #${sessionId} (${projectName})\n`);
    return sessionId;
  }

  // Create new session
  const [row] = await sql`
    INSERT INTO sessions (name, project_path, client_id, status)
    VALUES (${projectName}, ${process.cwd()}, ${"channel-" + projectName}, 'active')
    ON CONFLICT (client_id) DO UPDATE SET status = 'active', last_active = now()
    RETURNING id
  `;
  sessionId = row.id;
  process.stderr.write(`[channel] created session #${sessionId} (${projectName})\n`);
  return sessionId;
}

// --- Graceful disconnect ---
async function markDisconnected(): Promise<void> {
  if (sessionId === null) return;
  try {
    await sql`
      UPDATE sessions SET status = 'disconnected', last_active = now()
      WHERE id = ${sessionId}
    `;
    process.stderr.write(`[channel] session #${sessionId} marked disconnected\n`);
    if (hasPollingLock) {
      await releasePollingLock();
      process.stderr.write(`[channel] released polling lock\n`);
    }
  } catch (err) {
    process.stderr.write(`[channel] failed to mark disconnected: ${err}\n`);
  }
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

    // input_preview is a JSON string, not an object
    let input: Record<string, any> = {};
    try {
      if (params.input_preview) input = JSON.parse(params.input_preview);
      else if (params.input) input = typeof params.input === "string" ? JSON.parse(params.input) : params.input;
    } catch {}

    process.stderr.write(`[channel] permission: ${tool_name}(${JSON.stringify(input).slice(0, 100)})\n`);
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
    else if ((tool_name === "Edit" || tool_name === "Write") && input.file_path) detail = input.file_path;
    else if (tool_name === "Grep" && input.pattern) detail = `grep "${input.pattern}"`;
    else detail = JSON.stringify(input).slice(0, 200);

    const desc = `${tool_name}: ${description ?? ""}\n${detail}`.trim();

    // Update status message with what CLI is doing
    const shortDesc = tool_name === "Bash" ? `Выполняю: ${String(input?.command ?? "").slice(0, 60)}`
      : tool_name === "Read" ? `Читаю: ${String(input?.file_path ?? "").split("/").pop()}`
      : tool_name === "Edit" || tool_name === "Write" ? `Редактирую: ${String(input?.file_path ?? "").split("/").pop()}`
      : tool_name === "Grep" ? `Ищу: ${String(input?.pattern ?? "").slice(0, 40)}`
      : `${tool_name}`;
    await updateStatus(chatId, shortDesc);

    // Send inline keyboard to Telegram (3 buttons: Allow / Always / Deny)
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: Number(chatId),
        text: `🔐 Разрешить?\n\n${desc}`,
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Да", callback_data: `perm:allow:${request_id}` },
            { text: "✅ Всегда", callback_data: `perm:always:${request_id}` },
            { text: "❌ Нет", callback_data: `perm:deny:${request_id}` },
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
        await updateStatus(chatId, "Выполняю...");
        resolved = true;
        break;
      }

      // Check if permission was resolved in terminal (record deleted = CLI moved on)
      const exists = await sql`SELECT 1 FROM permission_requests WHERE id = ${request_id}`;
      if (exists.length === 0) {
        // Record deleted by another path — resolved elsewhere
        process.stderr.write(`[channel] permission ${request_id}: resolved externally\n`);
        if (telegramMsgId) {
          await editTelegramMessage(chatId, telegramMsgId, `⚡ Resolved in terminal\n\n${desc}`);
        }
        await updateStatus(chatId, "Выполняю...");
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
      if (telegramMsgId) {
        await editTelegramMessage(chatId, telegramMsgId, `⏰ Таймаут\n\n${desc}`);
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
      description: "Update the status message shown to the user in Telegram while processing. Call this before major operations to keep the user informed.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "Telegram chat ID" },
          status: { type: "string", description: "Short status text, e.g. 'Analyzing code', 'Running tests'" },
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
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "reply": {
      const chatId = String(args!.chat_id);
      // Stop everything: typing, status, tmux monitor
      stopTypingForChat(chatId);
      stopTmuxMonitorForChat(chatId);
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
        const sessionName = projectName || `#${sessionId}`;
        replyText = `📌 **${sessionName}**\n\n${replyText}\n\n_/switch ${sessionId} — переключиться_`;
        process.stderr.write(`[channel] reply from background session ${sessionName}\n`);
      }

      process.stderr.write(`[channel] sending reply to ${chatId}: ${replyText.slice(0, 50)}...\n`);
      const htmlText = markdownToTelegramHtml(replyText);

      // Inline button for background sessions
      const replyMarkup = isBackground
        ? { inline_keyboard: [[{ text: "↩️ Переключиться и ответить", callback_data: `switch:${sessionId}` }]] }
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
        }
      }
      if (!res.ok) {
        const errBody = await res.text();
        process.stderr.write(`[channel] Telegram API error: ${res.status} ${errBody}\n`);
        return text(`Telegram API error: ${res.status} ${errBody}`);
      }
      process.stderr.write(`[channel] reply sent OK\n`);
      // Save assistant response to short-term memory
      if (sessionId) {
        await sql`
          INSERT INTO messages (session_id, chat_id, role, content)
          VALUES (${sessionId}, ${String(args!.chat_id)}, 'assistant', ${String(args!.text)})
        `;
      }
      return text(`Sent to chat ${args!.chat_id}`);
    }

    case "remember": {
      const content = String(args!.content);
      const embedding = await embed(content);
      const embeddingStr = `[${embedding.join(",")}]`;
      const [row] = await sql`
        INSERT INTO memories (source, session_id, type, content, tags, embedding)
        VALUES ('cli', ${sessionId}, ${String(args!.type ?? "note")}, ${content}, ${(args!.tags as string[]) ?? []}, ${embeddingStr}::vector)
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
        WHERE session_id = ${sessionId} OR session_id IS NULL
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
      return text(`Status updated: ${args!.status}`);
    }

    case "list_memories": {
      const rows = await sql`
        SELECT id, type, content FROM memories
        WHERE (session_id = ${sessionId} OR session_id IS NULL)
          ${args!.type ? sql`AND type = ${String(args!.type)}` : sql``}
        ORDER BY created_at DESC
        LIMIT ${Number(args!.limit ?? 20)}
      `;
      if (rows.length === 0) return text("No memories found.");
      return text(rows.map((r: any) => `#${r.id} [${r.type}] ${r.content.slice(0, 100)}`).join("\n"));
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

// --- Status messages ---
interface StatusState {
  chatId: string;
  messageId: number;
  startedAt: number;
  stage: string;
  timer: ReturnType<typeof setInterval> | null;
}

const activeStatus = new Map<string, StatusState>();

function formatElapsed(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}с`;
  return `${Math.floor(sec / 60)}м ${sec % 60}с`;
}

async function getSessionPrefix(chatId: string): Promise<string> {
  if (!sessionId) return "";
  const activeCheck = await sql`
    SELECT active_session_id FROM chat_sessions WHERE chat_id = ${chatId}
  `;
  const isActive = activeCheck.length === 0 || activeCheck[0].active_session_id === sessionId;
  return isActive ? "" : `📌 ${projectName} · `;
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
      // Auto-cleanup after 2 minutes
      if (Date.now() - state.startedAt > 120_000) {
        deleteStatusMessage(chatId);
        return;
      }
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
  const text = `⏳ ${state.stage} (${elapsed})`;

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

// --- tmux monitor ---
const activeTmuxMonitors = new Map<string, TmuxMonitorHandle>();

async function startTmuxMonitorForChat(chatId: string): Promise<void> {
  // Stop existing monitor for this chat
  stopTmuxMonitorForChat(chatId);

  const monitor = await startTmuxMonitor(projectName, (status) => {
    updateStatus(chatId, status);
  });

  if (monitor) {
    activeTmuxMonitors.set(chatId, monitor);
    process.stderr.write(`[channel] tmux monitor started for ${projectName}\n`);
  }
}

function stopTmuxMonitorForChat(chatId: string): void {
  const monitor = activeTmuxMonitors.get(chatId);
  if (monitor) {
    monitor.stop();
    activeTmuxMonitors.delete(chatId);
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

async function pollMessages() {
  while (polling) {
    try {
      if (sessionId === null) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      // Try to acquire polling lock — only one channel.ts per session can poll
      if (!hasPollingLock) {
        hasPollingLock = await acquirePollingLock();
        if (hasPollingLock) {
          process.stderr.write(`[channel] acquired polling lock for session #${sessionId}\n`);
        } else {
          // Another channel.ts is polling this session — wait and retry
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
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
        await sendStatusMessage(row.chat_id, "Думаю...");

        // Start tmux monitor for real-time progress
        await startTmuxMonitorForChat(row.chat_id);

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
      }
    } catch (err) {
      process.stderr.write(`[channel] poll error: ${err}\n`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// --- Main ---
async function main() {
  await resolveSession();

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  process.stderr.write(`[channel] connected to Claude Code via stdio\n`);

  // Start polling
  pollMessages();

  // Graceful shutdown
  process.on("SIGINT", async () => {
    polling = false;
    await markDisconnected();
    await sql.end();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    polling = false;
    await markDisconnected();
    await sql.end();
    process.exit(0);
  });
}

main().catch(async (err) => {
  process.stderr.write(`[channel] fatal: ${err}\n`);
  await markDisconnected();
  await sql.end();
  process.exit(1);
});
