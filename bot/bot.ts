import { Bot } from "grammy";
import { CONFIG } from "../config.ts";
import { accessMiddleware } from "./access.ts";
import { registerHandlers, setBotRef } from "./handlers.ts";

export function createBot(): Bot {
  const bot = new Bot(CONFIG.TELEGRAM_BOT_TOKEN);

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
    // Memory
    { command: "remember", description: "Save to memory" },
    { command: "recall", description: "Search memory" },
    { command: "memories", description: "List memories" },
    { command: "forget", description: "Delete memory" },
    // Monitoring
    { command: "stats", description: "API stats, tokens, transcriptions" },
    { command: "logs", description: "Session logs" },
    { command: "status", description: "Bot health (DB, Ollama)" },
    // Knowledge base
    { command: "skills", description: "Skills from goodai-base" },
    { command: "rules", description: "Rules from goodai-base" },
    { command: "tools", description: "MCP tools" },
    // Maintenance
    { command: "clear", description: "Clear context" },
    { command: "summarize", description: "Summarize conversation" },
    { command: "rename", description: "Rename session" },
    { command: "cleanup", description: "Clean up inactive sessions" },
    // Help
    { command: "help", description: "Help" },
  ]).catch((err) => console.error("[bot] failed to set commands:", err.message));

  // Error handler
  bot.catch((err) => {
    console.error("[bot] error:", err.message);
  });

  return bot;
}
