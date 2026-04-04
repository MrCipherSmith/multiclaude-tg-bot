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
    { command: "sessions", description: "Список сессий" },
    { command: "switch", description: "Переключить сессию (с контекстом)" },
    { command: "session", description: "Текущая сессия" },
    { command: "standalone", description: "Автономный режим" },
    { command: "pending", description: "Ожидающие разрешения CLI" },
    // Memory
    { command: "remember", description: "Сохранить в память" },
    { command: "recall", description: "Поиск по памяти" },
    { command: "memories", description: "Список воспоминаний" },
    { command: "forget", description: "Удалить воспоминание" },
    // Monitoring
    { command: "stats", description: "Статистика API, токены, транскрипции" },
    { command: "logs", description: "Логи сессии" },
    { command: "status", description: "Здоровье бота (DB, Ollama)" },
    // Knowledge base
    { command: "skills", description: "Skills из goodai-base" },
    { command: "rules", description: "Правила из goodai-base" },
    { command: "tools", description: "MCP инструменты" },
    // Maintenance
    { command: "clear", description: "Очистить контекст" },
    { command: "summarize", description: "Суммаризировать диалог" },
    { command: "rename", description: "Переименовать сессию" },
    { command: "cleanup", description: "Очистить неактивные сессии" },
    // Help
    { command: "help", description: "Справка" },
  ]).catch((err) => console.error("[bot] failed to set commands:", err.message));

  // Error handler
  bot.catch((err) => {
    console.error("[bot] error:", err.message);
  });

  return bot;
}
