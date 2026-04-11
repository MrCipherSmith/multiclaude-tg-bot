import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type Bot } from "grammy";
import { randomUUID } from "crypto";
import { basename, resolve as resolvePath } from "path";
import { z } from "zod";
import { executeTool } from "./tools.ts";
import { registerMcpSession, unregisterMcpSession } from "./bridge.ts";
import { handleDashboardRequest } from "./dashboard-api.ts";
import { sessionManager, setTerminationCallback } from "../sessions/manager.ts";
import { getForumChatId } from "../bot/forum-cache.ts";
import { escapeHtml } from "../bot/format.ts";
import { CONFIG } from "../config.ts";
import { sql } from "../memory/db.ts";
import { summarizeOnDisconnect, summarizeWork, extractFactsFromTranscript } from "../memory/summarizer.ts";
import { verifyJwt } from "../dashboard/auth.ts";
import { IncomingMessage, ServerResponse } from "http";
import { createServer } from "http";

function parseCookie(req: IncomingMessage, name: string): string | undefined {
  const cookies = req.headers.cookie;
  if (!cookies) return undefined;
  const match = cookies.split(";").find((c) => c.trim().startsWith(`${name}=`));
  return match?.split("=").slice(1).join("=").trim();
}

async function isAuthenticated(req: IncomingMessage): Promise<boolean> {
  const token = parseCookie(req, "token");
  if (!token) return false;
  return (await verifyJwt(token)) !== null;
}

function isLocalRequest(req: IncomingMessage): boolean {
  const raw = req.socket.remoteAddress ?? "";
  if (raw === "127.0.0.1" || raw === "::1" || raw === "::ffff:127.0.0.1" || raw === "") return true;
  // Normalize IPv4-mapped IPv6
  const addr = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  const parts = addr.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;
  const [a, b] = parts;
  // Only Docker default bridge (172.17.x.x) — remove broad RFC 1918 trust
  return a === 172 && b === 17;
}

function isAllowedTranscriptPath(p: string): boolean {
  const resolved = resolvePath(String(p));
  return resolved.startsWith("/home") || resolved.startsWith("/root") || resolved.startsWith("/tmp");
}

// Track active transports by session
const transports = new Map<string, StreamableHTTPServerTransport>();

import { pendingExpects, pushExpect, tryAutoLink } from "./pending-expects.ts";

function registerTools(server: McpServer, bot: Bot | null, getClientId?: () => string | undefined): void {
  const exec = (name: string, args: Record<string, unknown>) =>
    executeTool(name, { ...args, _clientId: getClientId?.() }, bot);
  // Memory tools
  server.tool(
    "remember",
    "Save information to long-term memory with semantic embedding",
    {
      content: z.string().describe("The information to remember"),
      type: z.enum(["fact", "summary", "decision", "note"]).default("note").describe("Type of memory"),
      tags: z.array(z.string()).optional().describe("Tags for categorization"),
      source: z.enum(["telegram", "cli", "api"]).default("cli").describe("Source of the memory"),
    },
    async (args) => exec("remember", args),
  );

  server.tool(
    "recall",
    "Semantic search through long-term memory",
    {
      query: z.string().describe("Search query"),
      limit: z.number().default(5).describe("Max results"),
      type: z.enum(["fact", "summary", "decision", "note"]).optional().describe("Filter by type"),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
    },
    async (args) => exec("recall", args),
  );

  server.tool(
    "forget",
    "Delete a memory by ID",
    { id: z.number().describe("Memory ID to delete") },
    async (args) => exec("forget", args),
  );

  server.tool(
    "list_memories",
    "List memories with optional filters",
    {
      type: z.enum(["fact", "summary", "decision", "note"]).optional(),
      tags: z.array(z.string()).optional(),
      limit: z.number().default(20),
      offset: z.number().default(0),
    },
    async (args) => exec("list_memories", args),
  );

  // Telegram tools
  server.tool(
    "reply",
    "Send a message to a Telegram chat",
    {
      chat_id: z.string().describe("Telegram chat ID"),
      text: z.string().describe("Message text"),
      parse_mode: z.enum(["Markdown", "MarkdownV2", "HTML"]).optional(),
    },
    async (args) => exec("reply", args),
  );

  server.tool(
    "react",
    "Set a reaction on a Telegram message",
    {
      chat_id: z.string().describe("Telegram chat ID"),
      message_id: z.number().describe("Message ID"),
      emoji: z.string().describe("Reaction emoji"),
    },
    async (args) => exec("react", args),
  );

  server.tool(
    "edit_message",
    "Edit a bot message in Telegram",
    {
      chat_id: z.string().describe("Telegram chat ID"),
      message_id: z.number().describe("Message ID to edit"),
      text: z.string().describe("New text"),
      parse_mode: z.enum(["Markdown", "MarkdownV2", "HTML"]).optional(),
    },
    async (args) => exec("edit_message", args),
  );

  // Session tools
  server.tool(
    "list_sessions",
    "List all registered sessions",
    {},
    async (args) => exec("list_sessions", args),
  );

  server.tool(
    "session_info",
    "Get details about a specific session",
    { session_id: z.number().describe("Session ID") },
    async (args) => exec("session_info", args),
  );

  server.tool(
    "set_session_name",
    "Set a human-readable name and project path for this CLI session. Call this at the start of a session.",
    {
      name: z.string().describe("Human-readable session name (e.g. project name)"),
      project_path: z.string().optional().describe("Working directory path"),
    },
    async (args) => exec("set_session_name", args),
  );

  server.tool(
    "search_project_context",
    "Semantic search over long-term project context and work summaries. Use when you need knowledge from prior sessions about this project.",
    {
      query: z.string().describe("Natural language search query"),
      project_path: z.string().optional().describe("Project path to search in. Defaults to current session project_path."),
      limit: z.number().optional().describe("Number of results to return (default: 5, max: 20)"),
    },
    async (args) => exec("search_project_context", args),
  );
}

function createMcpServer(bot: Bot | null, getClientId?: () => string | undefined): McpServer {
  const server = new McpServer(
    {
      name: "helyx",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        experimental: {
          "claude/channel": {},
        },
      },
    },
  );

  registerTools(server, bot, getClientId);
  return server;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += String(chunk); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function startMcpHttpServer(bot: Bot | null): ReturnType<typeof createServer> {
  if (CONFIG.TELEGRAM_TRANSPORT === "webhook" && !CONFIG.TELEGRAM_WEBHOOK_SECRET) {
    console.error("[security] FATAL: TELEGRAM_WEBHOOK_SECRET must be set in webhook mode. Generate with: openssl rand -hex 32");
    process.exit(1);
  }

  // Register session crash notification callback
  if (bot) {
    setTerminationCallback((sessionId, projectPath, sessionName) => {
      (async () => {
        try {
          const forumChatId = await getForumChatId();
          if (!forumChatId) return;

          let forumTopicId: number | null = null;
          if (projectPath) {
            const proj = await sql`SELECT forum_topic_id FROM projects WHERE project_path = ${projectPath} AND forum_topic_id IS NOT NULL LIMIT 1`;
            forumTopicId = proj[0]?.forum_topic_id ?? null;
          }
          if (!forumTopicId) return;

          const label = escapeHtml(sessionName ?? `#${sessionId}`);
          const pathLine = projectPath ? `\n📁 <code>${escapeHtml(projectPath)}</code>` : "";
          await bot.api.sendMessage(
            Number(forumChatId),
            `⚠️ Сессия <b>${label}</b> завершилась.${pathLine}\n` +
            `Запусти Claude Code заново — бот подключится автоматически.`,
            { parse_mode: "HTML", message_thread_id: forumTopicId },
          );
        } catch (err) {
          console.error("[session-notify] failed to send termination notification:", err);
        }
      })();
    });
  }


  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${CONFIG.PORT}`);

    if (url.pathname === "/health") {
      try {
        await sql`SELECT 1`;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          db: "connected",
          uptime: Math.round(process.uptime()),
          sessions: transports.size,
        }));
      } catch (err: any) {
        console.error("[health] db check failed:", err?.message);
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", db: "disconnected" }));
      }
      return;
    }

    // API: trigger summarization for a session (requires auth or local)
    if (url.pathname === "/api/summarize" && req.method === "POST") {
      if (!isLocalRequest(req) && !(await isAuthenticated(req))) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      try {
        const body = await new Promise<string>((resolve, reject) => {
          let data = "";
          req.on("data", (chunk) => (data += chunk));
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });
        const { session_id, project_path } = JSON.parse(body);
        if (!session_id) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "session_id required" }));
          return;
        }
        // Run summarization in background
        summarizeOnDisconnect(session_id, project_path).catch((err) =>
          console.error("[api] summarize failed:", err)
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message }));
      }
      return;
    }

    // API: register a project session from shell CLI (local requests only)
    if (url.pathname === "/api/sessions/register" && req.method === "POST") {
      if (!isLocalRequest(req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }
      try {
        const body = await new Promise<string>((resolve, reject) => {
          let data = "";
          req.on("data", (chunk) => (data += chunk));
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });
        const parsed = JSON.parse(body);
        const { projectPath, name } = parsed;
        const cliType = parsed.cliType ?? "claude";
        const rawConfig = parsed.cliConfig ?? {};

        if (!projectPath || typeof projectPath !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "projectPath required" }));
          return;
        }
        const { basename } = await import("path");
        const sessionName = name ?? basename(projectPath);
        const clientId = `claude-${basename(projectPath)}-${Date.now()}`;
        // Sanitize optional model from cliConfig
        const cliConfig: Record<string, unknown> = {};
        if (typeof rawConfig.model === "string") cliConfig.model = rawConfig.model;
        const session = await sessionManager.register(clientId, sessionName, projectPath, cliConfig);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessionId: session.id, name: session.name }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message }));
      }
      return;
    }


    // API: pre-register an expected HTTP MCP connection from channel.ts (local only)
    if (url.pathname === "/api/sessions/expect" && req.method === "POST") {
      if (!isLocalRequest(req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }
      try {
        const body = await new Promise<string>((resolve, reject) => {
          let data = "";
          req.on("data", (chunk) => (data += chunk));
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });
        const { session_id } = JSON.parse(body);
        if (!session_id || typeof session_id !== "number") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "session_id required" }));
          return;
        }
        pushExpect(session_id);
        console.log(`[mcp] pending expect registered: session #${session_id} (queue: ${pendingExpects.length})`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message }));
      }
      return;
    }

    // POST /api/sessions/:id/summarize-work
    const workSumMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/summarize-work$/);
    if (req.method === "POST" && workSumMatch) {
      if (!isLocalRequest(req) && !(await isAuthenticated(req))) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      const sessionId = parseInt(workSumMatch[1], 10);
      try {
        const ok = await summarizeWork(sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, skipped: !ok }));
      } catch (err: any) {
        console.error("[api] summarize-work error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/hooks/stop — Claude Code Stop hook: extract facts from transcript
    if (url.pathname === "/api/hooks/stop" && req.method === "POST") {
      if (!isLocalRequest(req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }
      try {
        const body = await new Promise<string>((resolve, reject) => {
          let data = "";
          req.on("data", (chunk) => (data += chunk));
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });
        const { transcript_path, project_path } = JSON.parse(body);
        if (!transcript_path || !project_path) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "transcript_path and project_path required" }));
          return;
        }
        if (!isAllowedTranscriptPath(transcript_path)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid transcript_path" }));
          return;
        }
        // Non-blocking — respond immediately, extract in background
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        extractFactsFromTranscript(transcript_path as string, project_path as string)
          .catch((err) => console.error("[hooks/stop] extractFactsFromTranscript error:", err?.message));
      } catch (err: any) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err?.message }));
        }
      }
      return;
    }

    // Telegram webhook endpoint — return 200 immediately, process in background
    if (bot && CONFIG.TELEGRAM_TRANSPORT === "webhook" && req.method === "POST" && url.pathname === CONFIG.TELEGRAM_WEBHOOK_PATH) {
      // Validate secret token
      const secretToken = req.headers["x-telegram-bot-api-secret-token"];
      if (CONFIG.TELEGRAM_WEBHOOK_SECRET && secretToken !== CONFIG.TELEGRAM_WEBHOOK_SECRET) {
        res.writeHead(401);
        res.end();
        return;
      }

      const body = await readBody(req);

      // Acknowledge immediately — prevents Telegram retries and unblocks next update
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");

      // Process update in background (non-blocking)
      try {
        const update = JSON.parse(body);
        bot.handleUpdate(update).catch((err: any) =>
          console.error("[webhook] handleUpdate error:", err?.message ?? err)
        );
      } catch (err: any) {
        console.error("[webhook] parse error:", err?.message);
      }
      return;
    }

    // Dashboard API + static files
    try {
      const handled = await handleDashboardRequest(req, res, url);
      if (handled) return;
    } catch (err: any) {
      console.error("[dashboard] error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    // MCP endpoint restricted to local/Docker network
    if (!isLocalRequest(req)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (req.method === "GET" || req.method === "DELETE") {
        res.writeHead(400);
        res.end("Missing session ID");
        return;
      }

      // Track transport's MCP session ID (UUID)
      let transportSessionId: string | undefined;

      const mcpServer = createMcpServer(bot, () => transportSessionId);

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          transports.set(id, transport!);
          registerMcpSession(id, mcpServer);
          transportSessionId = id;
          sessionManager.trackTransport(id);
          console.log(`[mcp] transport initialized: ${id.slice(0, 12)}`);
          // Try auto-link immediately (if channel.ts registered expect before us)
          tryAutoLink(id).catch((err) => console.error("[mcp] auto-link failed:", err?.message));
        },
      });

      transport.onclose = async () => {
        const sid = transport!.sessionId;
        if (sid) {
          transports.delete(sid);
          unregisterMcpSession(sid);
          const hasDbSession = sessionManager.getSessionIdByClient(sid) !== undefined;
          sessionManager.untrackTransport(sid);
          if (hasDbSession) {
            await sessionManager.disconnect(sid);
          }
          console.log(`[mcp] transport closed: ${sid.slice(0, 12)}${hasDbSession ? " (db session cleaned up)" : ""}`);
        }
      };

      await mcpServer.connect(transport);
    }

    let body: unknown = undefined;
    if (req.method === "POST") {
      body = await new Promise<unknown>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => {
          data += chunk;
          if (data.length > 5_000_000) { req.destroy(); reject(new Error("Body too large")); }
        });
        req.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
        req.on("error", reject);
      });
    }

    await transport.handleRequest(req, res, body);
  });

  httpServer.listen(CONFIG.PORT, () => {
    console.log(`[mcp] HTTP server listening on port ${CONFIG.PORT}`);
  });

  return httpServer;
}
