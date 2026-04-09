import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { CONFIG } from "../config.ts";
import { accessMiddleware } from "./access.ts";
import { registerHandlers, setBotRef } from "./handlers.ts";
import { logger } from "../logger.ts";

export function createBot(): Bot {
  const bot = new Bot(CONFIG.TELEGRAM_BOT_TOKEN);

  // Auto-retry on 429 Too Many Requests — waits retry_after and retries automatically
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, rethrowInternalServerErrors: false }));

  // Access control middleware
  bot.use(accessMiddleware);

  // Register all handlers
  setBotRef(bot);
  registerHandlers(bot);

  // Set bot commands menu in Telegram
  // Sorted by frequency of use: most common first
  bot.api.setMyCommands([
    // Daily use
    { command: "sessions", description: "List sessions" },
    { command: "switch", description: "Switch session (with context)" },
    { command: "session", description: "Current session" },
    { command: "standalone", description: "Standalone mode" },
    { command: "pending", description: "Pending CLI permissions" },
    { command: "permission_stats", description: "Permission history analytics" },
    // Memory
    { command: "remember", description: "Save to memory" },
    { command: "recall", description: "Search memory" },
    { command: "memories", description: "List memories" },
    { command: "forget", description: "Delete memory" },
    { command: "memory_export", description: "Export memories as JSON" },
    { command: "memory_import", description: "Import memories from JSON file" },
    // Monitoring
    { command: "stats", description: "API stats, tokens, transcriptions" },
    { command: "logs", description: "Session logs" },
    { command: "status", description: "Bot health (DB, Ollama)" },
    { command: "session_export", description: "Export session as markdown transcript" },
    // Knowledge base
    { command: "skills", description: "Skills from goodai-base" },
    { command: "rules", description: "Rules from goodai-base" },
    { command: "tools", description: "MCP tools" },
    // Remote control
    { command: "remote_control", description: "tmux bots status (Kill/Start)" },
    { command: "projects", description: "List projects (Start/Stop)" },
    { command: "project_add", description: "Add project to config" },
    { command: "project_facts", description: "Show project knowledge facts" },
    { command: "project_scan", description: "Scan project for knowledge (rescan)" },
    // Maintenance
    { command: "clear", description: "Clear context" },
    { command: "summarize", description: "Summarize conversation" },
    { command: "rename", description: "Rename session" },
    { command: "cleanup", description: "Clean up inactive sessions" },
    // Help
    { command: "help", description: "Help" },
  ]).catch((err) => logger.error({ err }, "failed to set bot commands"));

  // Set WebApp menu button (requires HTTPS URL for production)
  const webAppUrl = (CONFIG.TELEGRAM_WEBHOOK_URL || "")
    .replace(/\/$/, "")
    .replace(/\/[^/]*$/, "") + "/webapp/";
  if (CONFIG.TELEGRAM_WEBHOOK_URL) {
    bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "Dev Hub", web_app: { url: webAppUrl } } })
      .catch((err) => logger.error({ err }, "failed to set menu button"));
  }

  // Error handler
  bot.catch((err) => {
    logger.error({ err }, "bot error");
  });

  return bot;
}
