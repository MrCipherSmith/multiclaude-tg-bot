/**
 * channel/index.ts — entry point for the Claude Code stdio channel adapter.
 *
 * Wires together session, permissions, tools, status, and poller modules.
 * All mutable state lives in class instances; this file orchestrates startup/shutdown.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import postgres from "postgres";
import { basename } from "path";

import { SessionManager } from "./session.ts";
import { StatusManager } from "./status.ts";
import { PermissionHandler } from "./permissions.ts";
import { MessageQueuePoller } from "./poller.ts";
import { SkillEvaluator } from "./skill-evaluator.ts";
import { registerTools } from "./tools.ts";
import { channelLogger } from "../logger.ts";

// --- Env ---
const ChannelEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  OLLAMA_URL: z.string().default("http://localhost:11434"),
  EMBEDDING_MODEL: z.string().default("nomic-embed-text"),
  BOT_API_URL: z.string().default("http://localhost:3847"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  CHANNEL_SOURCE: z.enum(["remote", "local"]).optional(),
  IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  HOME: z.string().default("/root"),
});

const channelEnvResult = ChannelEnvSchema.safeParse(process.env);
if (!channelEnvResult.success) {
  for (const issue of channelEnvResult.error.issues) {
    channelLogger.fatal({ field: issue.path.join("."), message: issue.message }, "config error");
  }
  process.exit(1);
}
const ENV = channelEnvResult.data;

// --- MCP server ---
const PermissionRequestSchema = NotificationSchema.extend({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string().optional(),
    description: z.string().optional(),
    input_preview: z.string().optional(),
  }).passthrough(),
});

const mcp = new Server(
  { name: "helyx-channel", version: "0.1.0" },
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

// --- DB ---
const sql = postgres(ENV.DATABASE_URL, { max: 3 });

// --- Project ---
const projectName = basename(process.cwd());
const projectPath = process.cwd();
const channelSource: "remote" | "local" | null =
  ENV.CHANNEL_SOURCE === "remote" ? "remote" :
  ENV.CHANNEL_SOURCE === "local" ? "local" :
  null;

// --- Forum config (mutable — loaded after session resolve) ---
let forumChatId: string | null = null;
let forumTopicId: number | null = null;

// --- Voice reply flag (set by poller, read by tools) ---
let forceVoice = false;

// --- Session ---
const sessionMgr = new SessionManager({
  sql,
  projectName,
  projectPath,
  channelSource,
  botApiUrl: ENV.BOT_API_URL,
  idleTimeoutMs: ENV.IDLE_TIMEOUT_MS,
});

// --- Status ---
const statusMgr = new StatusManager({
  sql,
  sessionId: () => sessionMgr.sessionId,
  sessionName: () => sessionMgr.sessionName,
  projectName,
  token: () => ENV.TELEGRAM_BOT_TOKEN,
  forumChatId: () => forumChatId,
  forumTopicId: () => forumTopicId,
});

// --- Permissions ---
const permHandler = new PermissionHandler(
  {
    sql,
    mcp,
    sessionId: () => sessionMgr.sessionId,
    projectPath,
    token: () => ENV.TELEGRAM_BOT_TOKEN,
    homeDir: ENV.HOME,
    forumChatId: () => forumChatId,
    forumTopicId: () => forumTopicId,
  },
  statusMgr,
);

mcp.setNotificationHandler(PermissionRequestSchema, async (notification: any) => {
  const params = notification.params ?? notification;
  await permHandler.handle(params);
});

// --- Tools ---
const triggerSummarize = () => sessionMgr.triggerSummarize();

registerTools(
  {
    sql,
    mcp,
    sessionId: () => sessionMgr.sessionId,
    sessionName: () => sessionMgr.sessionName,
    projectPath,
    token: () => ENV.TELEGRAM_BOT_TOKEN,
    ollamaUrl: ENV.OLLAMA_URL,
    embeddingModel: ENV.EMBEDDING_MODEL,
    forumChatId: () => forumChatId,
    forumTopicId: () => forumTopicId,
    forceVoice: () => forceVoice,
  },
  statusMgr,
  () => sessionMgr.touchIdleTimer(triggerSummarize),
);

// --- Skill Evaluator ---
const skillEval = new SkillEvaluator();
// Load asynchronously — if registry not found, hints are simply skipped
skillEval.load(ENV.HOME).catch(() => {});

// --- Poller ---
const poller = new MessageQueuePoller(
  {
    sql,
    mcp,
    sessionId: () => sessionMgr.sessionId,
    pollIntervalMs: 500,
    databaseUrl: ENV.DATABASE_URL,
    setForceVoice: (v) => { forceVoice = v; },
  },
  statusMgr,
  () => sessionMgr.touchIdleTimer(triggerSummarize),
  skillEval,
);

// --- Main ---
async function main() {
  await sessionMgr.resolve();

  // Load forum config: forum_chat_id from bot_config, forum_topic_id from projects table
  try {
    const configRows = await sql`SELECT value FROM bot_config WHERE key = 'forum_chat_id'`;
    const rawChatId = configRows[0]?.value as string | undefined;
    if (rawChatId && rawChatId.length > 0) {
      forumChatId = rawChatId;
      const projectRows = await sql`SELECT forum_topic_id FROM projects WHERE path = ${projectPath}`;
      const rawTopicId = projectRows[0]?.forum_topic_id as number | null | undefined;
      if (rawTopicId) {
        forumTopicId = rawTopicId;
        channelLogger.info({ forumChatId, forumTopicId }, "forum mode active");
      }
    }
  } catch {
    // bot_config table may not exist yet (pre-migration) — silently skip
  }

  if (sessionMgr.sessionId !== null && channelSource === "remote") {
    try {
      const res = await fetch(`${ENV.BOT_API_URL}/api/sessions/expect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionMgr.sessionId }),
      });
      if (res.ok) {
        channelLogger.info({ sessionId: sessionMgr.sessionId }, "registered expect for session");
      } else {
        channelLogger.warn({ sessionId: sessionMgr.sessionId, status: res.status }, "expect registration failed");
      }
    } catch (err: any) {
      channelLogger.error({ err }, "expect registration error");
    }
  }

  await permHandler.loadAutoApproveRules();

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  channelLogger.info({ sessionId: sessionMgr.sessionId }, "connected to Claude Code via stdio");

  poller.start();

  // Renew session lease + last_active every 60s (lease TTL is 3 min, so 60s is safe margin)
  const HEARTBEAT_INTERVAL_MS = 60_000;
  const heartbeatTimer = setInterval(async () => {
    if (sessionMgr.sessionId === null) return;
    await sessionMgr.renewLease().catch(() => {});
    // Refresh forum topic ID — may have changed if topic was recreated or project added after startup
    if (forumChatId) {
      try {
        const rows = await sql`SELECT forum_topic_id FROM projects WHERE path = ${projectPath}`;
        forumTopicId = rows[0]?.forum_topic_id ?? null;
      } catch { /* non-critical */ }
    }
  }, HEARTBEAT_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    poller.stop();
    clearInterval(heartbeatTimer);
    sessionMgr.clearIdleTimer();

    // Auto-summarize before disconnect — saves context for /resume in the next session
    if (sessionMgr.sessionId !== null) {
      try {
        await fetch(`${ENV.BOT_API_URL}/api/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionMgr.sessionId, project_path: projectPath }),
          signal: AbortSignal.timeout(5_000),
        });
        channelLogger.info({ sessionId: sessionMgr.sessionId }, "auto-summarize triggered on shutdown");
      } catch (err) {
        channelLogger.warn({ err }, "auto-summarize request failed");
      }
    }

    await sessionMgr.markDisconnected();
    await sql.end();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
  process.stdin.on("end", shutdown);
}

main().catch(async (err) => {
  channelLogger.fatal({ err }, "channel fatal error");
  await sessionMgr.markDisconnected();
  await sql.end();
  process.exit(1);
});
