import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type Bot, webhookCallback } from "grammy";
import { randomUUID } from "crypto";
import { basename } from "path";
import { z } from "zod";
import { executeTool } from "./tools.ts";
import { registerMcpSession, unregisterMcpSession } from "./bridge.ts";
import { handleDashboardRequest } from "./dashboard-api.ts";
import { sessionManager } from "../sessions/manager.ts";
import { CONFIG } from "../config.ts";
import { sql } from "../memory/db.ts";
import { summarizeOnDisconnect } from "../memory/summarizer.ts";
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
  if (raw === "127.0.0.1" || raw === "::1" || raw === "::ffff:127.0.0.1") return true;
  // Normalize IPv4-mapped IPv6
  const addr = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  const parts = addr.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;
  const [a, b] = parts;
  // RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  return a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
}

// Track active transports by session
const transports = new Map<string, StreamableHTTPServerTransport>();

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
}

function createMcpServer(bot: Bot | null, getClientId?: () => string | undefined): McpServer {
  const server = new McpServer(
    {
      name: "claude-bot",
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

export function startMcpHttpServer(bot: Bot | null): ReturnType<typeof createServer> {
  // Pre-create webhook handler if in webhook mode
  const webhookHandler = CONFIG.TELEGRAM_TRANSPORT === "webhook" && bot
    ? webhookCallback(bot, "http", {
        secretToken: CONFIG.TELEGRAM_WEBHOOK_SECRET || undefined,
        timeoutMilliseconds: 180_000,
        onTimeout: "return",
      })
    : null;

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
        // Validate cliType against allowed values
        if (!["claude", "opencode"].includes(cliType)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "cliType must be 'claude' or 'opencode'" }));
          return;
        }
        // Validate and sanitize cliConfig — only allow known safe fields
        const port = Number(rawConfig.port ?? 4096);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "cliConfig.port must be an integer between 1024 and 65535" }));
          return;
        }
        const cliConfig: Record<string, unknown> = { port };
        if (rawConfig.autostart === true) cliConfig.autostart = true;
        if (typeof rawConfig.tmuxSession === "string" && /^[a-zA-Z0-9_\-]{1,64}$/.test(rawConfig.tmuxSession)) {
          cliConfig.tmuxSession = rawConfig.tmuxSession;
        }
        const { basename } = await import("path");
        const sessionName = name ?? `${basename(projectPath)} · ${cliType}`;
        const clientId = `${cliType}-${basename(projectPath)}-${Date.now()}`;
        const session = await sessionManager.register(clientId, sessionName, projectPath, undefined, cliType, cliConfig);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessionId: session.id, name: session.name }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message }));
      }
      return;
    }

    // Telegram webhook endpoint
    if (webhookHandler && req.method === "POST" && url.pathname === CONFIG.TELEGRAM_WEBHOOK_PATH) {
      try {
        await webhookHandler(req, res);
      } catch (err: any) {
        console.error("[webhook] unhandled error:", err?.message ?? err);
        if (!res.headersSent) {
          res.writeHead(200); // 200 to prevent Telegram retries
          res.end();
        }
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
        onsessioninitialized: async (id: string) => {
          transports.set(id, transport!);
          registerMcpSession(id, mcpServer);
          const cwd = req.headers["x-project-path"] as string | undefined;
          const name = req.headers["x-session-name"] as string | undefined;
          const autoName = cwd ? `${basename(cwd)} · cli` : `cli-${id.slice(0, 8)}`;
          transportSessionId = id;
          const session = await sessionManager.register(id, name ?? autoName, cwd);
          console.log(`[mcp] session initialized: ${id} (db #${session.id})`);
        },
      });

      transport.onclose = async () => {
        const sid = transport!.sessionId;
        if (sid) {
          transports.delete(sid);
          unregisterMcpSession(sid);
          await sessionManager.disconnect(sid);
          console.log(`[mcp] session closed: ${sid}`);
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
