import type { Bot } from "grammy";
import { remember, recall, forget, listMemories, type Memory } from "../memory/long-term.ts";
import { sessionManager } from "../sessions/manager.ts";
import { sql } from "../memory/db.ts";
import { chunkText } from "../utils/chunk.ts";

// Tool definitions for MCP registration
export const TOOL_DEFINITIONS = [
  // Memory tools
  {
    name: "remember",
    description: "Save information to long-term memory with semantic embedding for future retrieval",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: { type: "string", description: "The information to remember" },
        type: {
          type: "string",
          enum: ["fact", "summary", "decision", "note"],
          description: "Type of memory",
          default: "note",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization",
        },
        source: {
          type: "string",
          enum: ["telegram", "cli", "api"],
          description: "Source of the memory",
          default: "cli",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "recall",
    description: "Semantic search through long-term memory. Returns the most relevant memories for a query.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 5)", default: 5 },
        type: {
          type: "string",
          enum: ["fact", "summary", "decision", "note"],
          description: "Filter by type",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "forget",
    description: "Delete a memory by ID",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Memory ID to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_memories",
    description: "List memories with optional filters",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: { type: "string", enum: ["fact", "summary", "decision", "note"] },
        tags: { type: "array", items: { type: "string" } },
        limit: { type: "number", default: 20 },
        offset: { type: "number", default: 0 },
      },
    },
  },
  // Telegram tools
  {
    name: "reply",
    description: "Send a message to a Telegram chat",
    inputSchema: {
      type: "object" as const,
      properties: {
        chat_id: { type: "string", description: "Telegram chat ID" },
        text: { type: "string", description: "Message text" },
        parse_mode: {
          type: "string",
          enum: ["Markdown", "MarkdownV2", "HTML"],
          description: "Message formatting",
        },
      },
      required: ["chat_id", "text"],
    },
  },
  {
    name: "react",
    description: "Set a reaction on a Telegram message",
    inputSchema: {
      type: "object" as const,
      properties: {
        chat_id: { type: "string", description: "Telegram chat ID" },
        message_id: { type: "number", description: "Message ID" },
        emoji: { type: "string", description: "Reaction emoji" },
      },
      required: ["chat_id", "message_id", "emoji"],
    },
  },
  {
    name: "edit_message",
    description: "Edit a bot message in Telegram",
    inputSchema: {
      type: "object" as const,
      properties: {
        chat_id: { type: "string", description: "Telegram chat ID" },
        message_id: { type: "number", description: "Message ID to edit" },
        text: { type: "string", description: "New text" },
        parse_mode: { type: "string", enum: ["Markdown", "MarkdownV2", "HTML"] },
      },
      required: ["chat_id", "message_id", "text"],
    },
  },
  // Session tools
  {
    name: "list_sessions",
    description: "List all registered sessions (CLI and standalone)",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "session_info",
    description: "Get details about a specific session",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "number", description: "Session ID" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "set_session_name",
    description: "Set a human-readable name and project path for this CLI session. Call this at the start of a session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Human-readable session name (e.g. project name)" },
        project_path: { type: "string", description: "Working directory path" },
      },
      required: ["name"],
    },
  },
];

// Tool execution
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  bot: Bot | null,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // Touch session activity on every tool call
  const clientId = args._clientId as string | undefined;
  if (clientId) {
    const sessionId = sessionManager.getSessionIdByClient(clientId);
    if (sessionId !== undefined) {
      sessionManager.touchActivity(sessionId).catch(() => {});
    }
  }

  switch (name) {
    // Memory tools
    case "remember": {
      // Resolve project_path from session
      let projectPath: string | null = null;
      if (clientId) {
        const sid = sessionManager.getSessionIdByClient(clientId);
        if (sid !== undefined) {
          const sess = await sessionManager.get(sid);
          projectPath = sess?.projectPath ?? null;
        }
      }
      const m = await remember({
        content: args.content as string,
        type: (args.type as Memory["type"]) ?? "note",
        tags: (args.tags as string[]) ?? [],
        source: (args.source as Memory["source"]) ?? "cli",
        projectPath,
      });
      return text(`Saved memory #${m.id}: "${m.content.slice(0, 80)}..."`);
    }

    case "recall": {
      // Resolve project_path from session
      let projectPath: string | null = null;
      if (clientId) {
        const sid = sessionManager.getSessionIdByClient(clientId);
        if (sid !== undefined) {
          const sess = await sessionManager.get(sid);
          projectPath = sess?.projectPath ?? null;
        }
      }
      const results = await recall(args.query as string, {
        limit: (args.limit as number) ?? 5,
        type: args.type as string | undefined,
        tags: args.tags as string[] | undefined,
        projectPath,
      });
      if (results.length === 0) return text("No relevant memories found.");
      const formatted = results
        .map(
          (r) =>
            `#${r.id} [${r.type}] (distance: ${Number(r.distance).toFixed(3)}) ${r.content}` +
            (r.tags && r.tags.length > 0 ? ` [tags: ${r.tags.join(", ")}]` : ""),
        )
        .join("\n\n");
      return text(formatted);
    }

    case "forget": {
      const deleted = await forget(args.id as number);
      return text(deleted ? `Deleted memory #${args.id}` : `Memory #${args.id} not found`);
    }

    case "list_memories": {
      // Resolve project_path from session
      let projectPath: string | null = null;
      if (clientId) {
        const sid = sessionManager.getSessionIdByClient(clientId);
        if (sid !== undefined) {
          const sess = await sessionManager.get(sid);
          projectPath = sess?.projectPath ?? null;
        }
      }
      const mems = await listMemories({
        type: args.type as string | undefined,
        tags: args.tags as string[] | undefined,
        limit: (args.limit as number) ?? 20,
        offset: (args.offset as number) ?? 0,
        projectPath,
      });
      if (mems.length === 0) return text("No memories found.");
      const formatted = mems
        .map((m) => `#${m.id} [${m.type}] ${m.content.slice(0, 100)}`)
        .join("\n");
      return text(formatted);
    }

    // Telegram tools
    case "reply": {
      if (!bot) return text("Telegram bot not available");
      const chatId = Number(args.chat_id);
      const chunks = chunkText(args.text as string);
      for (const chunk of chunks) {
        await bot.api.sendMessage(chatId, chunk, {
          parse_mode: args.parse_mode as any,
        });
      }
      return text(`Sent ${chunks.length} message(s) to chat ${args.chat_id}`);
    }

    case "react": {
      if (!bot) return text("Telegram bot not available");
      await bot.api.setMessageReaction(
        Number(args.chat_id),
        args.message_id as number,
        [{ type: "emoji", emoji: args.emoji as string }],
      );
      return text(`Reacted with ${args.emoji}`);
    }

    case "edit_message": {
      if (!bot) return text("Telegram bot not available");
      await bot.api.editMessageText(
        Number(args.chat_id),
        args.message_id as number,
        args.text as string,
        { parse_mode: args.parse_mode as any },
      );
      return text(`Edited message ${args.message_id}`);
    }

    // Session tools
    case "list_sessions": {
      const sessions = await sessionManager.list();
      const formatted = sessions
        .map(
          (s) =>
            `#${s.id} ${s.name ?? s.clientId} [${s.status}]${s.projectPath ? ` (${s.projectPath})` : ""}`,
        )
        .join("\n");
      return text(formatted);
    }

    case "session_info": {
      const session = await sessionManager.get(args.session_id as number);
      if (!session) return text(`Session #${args.session_id} not found`);
      return text(
        `Session #${session.id}\n` +
          `Name: ${session.name}\n` +
          `Status: ${session.status}\n` +
          `Path: ${session.projectPath ?? "N/A"}\n` +
          `Client: ${session.clientId}\n` +
          `Connected: ${session.connectedAt}\n` +
          `Last active: ${session.lastActive}`,
      );
    }

    case "set_session_name": {
      const sessionName = args.name as string;
      const projectPath = args.project_path as string | undefined;
      const clientId = args._clientId as string | undefined;
      if (!clientId) return text("No session context");
      const session = await sessionManager.adoptOrRename(clientId, sessionName, projectPath);
      return text(`Session #${session.id} named "${sessionName}"`);
    }

    default:
      return text(`Unknown tool: ${name}`);
  }
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}
