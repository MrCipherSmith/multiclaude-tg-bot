import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Bot } from "grammy";
import { randomUUID } from "crypto";
import { z } from "zod";
import { executeTool } from "./tools.ts";
import { registerMcpSession, unregisterMcpSession } from "./bridge.ts";
import { sessionManager } from "../sessions/manager.ts";
import { CONFIG } from "../config.ts";
import { IncomingMessage, ServerResponse } from "http";
import { createServer } from "http";

// Track active transports by session
const transports = new Map<string, StreamableHTTPServerTransport>();

function registerTools(server: McpServer, bot: Bot | null, getClientId?: () => string | undefined): void {
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
    async (args) => executeTool("remember", args, bot),
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
    async (args) => executeTool("recall", args, bot),
  );

  server.tool(
    "forget",
    "Delete a memory by ID",
    { id: z.number().describe("Memory ID to delete") },
    async (args) => executeTool("forget", args, bot),
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
    async (args) => executeTool("list_memories", args, bot),
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
    async (args) => executeTool("reply", args, bot),
  );

  server.tool(
    "react",
    "Set a reaction on a Telegram message",
    {
      chat_id: z.string().describe("Telegram chat ID"),
      message_id: z.number().describe("Message ID"),
      emoji: z.string().describe("Reaction emoji"),
    },
    async (args) => executeTool("react", args, bot),
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
    async (args) => executeTool("edit_message", args, bot),
  );

  // Session tools
  server.tool(
    "list_sessions",
    "List all registered sessions",
    {},
    async (args) => executeTool("list_sessions", args, bot),
  );

  server.tool(
    "session_info",
    "Get details about a specific session",
    { session_id: z.number().describe("Session ID") },
    async (args) => executeTool("session_info", args, bot),
  );

  server.tool(
    "set_session_name",
    "Set a human-readable name and project path for this CLI session. Call this at the start of a session.",
    {
      name: z.string().describe("Human-readable session name (e.g. project name)"),
      project_path: z.string().optional().describe("Working directory path"),
    },
    async (args) => {
      const clientId = getClientId?.();
      return executeTool("set_session_name", { ...args, _clientId: clientId }, bot);
    },
  );
}

function createMcpServer(bot: Bot | null, getClientId?: () => string | undefined): McpServer {
  const server = new McpServer({
    name: "claude-bot",
    version: "0.1.0",
  });

  registerTools(server, bot, getClientId);
  return server;
}

export function startMcpHttpServer(bot: Bot | null): ReturnType<typeof createServer> {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${CONFIG.PORT}`);

    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not Found");
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
          transportSessionId = id;
          const session = await sessionManager.register(id, name ?? `cli-${id.slice(0, 8)}`, cwd);
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
        req.on("data", (chunk) => (data += chunk));
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
