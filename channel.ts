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
    input: z.any().optional(),
    message: z.string().optional(),
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
  async (params: any) => {
    const { request_id, tool_name, input, message } = params.params ?? params;
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

    const desc = message ?? `${tool_name}(${JSON.stringify(input ?? {}).slice(0, 200)})`;

    // Send inline keyboard to Telegram
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: Number(chatId),
        text: `🔐 Разрешить?\n\n${desc}`,
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Разрешить", callback_data: `perm:allow:${request_id}` },
            { text: "❌ Запретить", callback_data: `perm:deny:${request_id}` },
          ]],
        },
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as any;
      const msgId = data.result?.message_id;

      // Save to DB for the main bot to handle callback
      await sql`
        INSERT INTO permission_requests (id, session_id, chat_id, tool_name, description, message_id)
        VALUES (${request_id}, ${sessionId}, ${chatId}, ${tool_name ?? "unknown"}, ${desc}, ${msgId})
        ON CONFLICT (id) DO NOTHING
      `;
    }

    // Poll for response
    const startTime = Date.now();
    const TIMEOUT = 120_000; // 2 minutes

    while (Date.now() - startTime < TIMEOUT) {
      const rows = await sql`
        SELECT response FROM permission_requests WHERE id = ${request_id} AND response IS NOT NULL
      `;
      if (rows.length > 0) {
        const behavior = rows[0].response; // 'allow' or 'deny'
        await mcp.notification({
          method: "notifications/claude/channel/permission",
          params: { request_id, behavior },
        });
        process.stderr.write(`[channel] permission ${request_id}: ${behavior}\n`);

        // Cleanup
        await sql`DELETE FROM permission_requests WHERE id = ${request_id}`;
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // Timeout — deny
    process.stderr.write(`[channel] permission ${request_id}: timeout, denying\n`);
    await mcp.notification({
      method: "notifications/claude/channel/permission",
      params: { request_id, behavior: "deny" },
    });
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
      // Stop typing indicator and remove status message
      stopTypingForChat(chatId);
      await deleteStatusMessage(chatId);

      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        process.stderr.write(`[channel] reply failed: no TELEGRAM_BOT_TOKEN\n`);
        return text("TELEGRAM_BOT_TOKEN not set");
      }
      process.stderr.write(`[channel] sending reply to ${chatId}: ${String(args!.text).slice(0, 50)}...\n`);
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: Number(args!.chat_id),
          text: args!.text,
        }),
      });
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

// --- Status messages ---
// Track status message IDs per chat so we can delete them when CLI replies
const statusMessages = new Map<string, number>();

async function sendStatusMessage(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(chatId), text: `⏳ ${text}` }),
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      statusMessages.set(chatId, data.result?.message_id);
    }
  } catch {}
}

async function deleteStatusMessage(chatId: string): Promise<void> {
  const msgId = statusMessages.get(chatId);
  if (!msgId) return;
  statusMessages.delete(chatId);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(chatId), message_id: msgId }),
    });
  } catch {}
}

// --- Typing indicators ---
// Track active typing handles per chat_id
const activeTyping = new Map<string, TypingHandle>();

function startTypingForChat(chatId: string): void {
  // Don't start if already typing for this chat
  if (activeTyping.has(chatId)) return;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const handle = startTypingRaw(token, chatId);
  activeTyping.set(chatId, handle);
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

async function pollMessages() {
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
        await sendStatusMessage(row.chat_id, "Думаю...");

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
    await sql.end();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    polling = false;
    await sql.end();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[channel] fatal: ${err}\n`);
  process.exit(1);
});
