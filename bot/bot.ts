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
  bot.api.setMyCommands([
    { command: "start", description: "Начать работу" },
    { command: "help", description: "Справка" },
    { command: "sessions", description: "Список сессий" },
    { command: "switch", description: "Переключить сессию" },
    { command: "session", description: "Инфо о текущей сессии" },
    { command: "rename", description: "Переименовать сессию" },
    { command: "standalone", description: "Автономный режим" },
    { command: "remember", description: "Сохранить в память" },
    { command: "recall", description: "Поиск по памяти" },
    { command: "memories", description: "Список воспоминаний" },
    { command: "forget", description: "Удалить воспоминание" },
    { command: "clear", description: "Очистить контекст сессии" },
    { command: "summarize", description: "Суммаризировать диалог" },
    { command: "status", description: "Статус бота" },
    { command: "stats", description: "Статистика" },
    { command: "logs", description: "Логи сессии" },
    { command: "pending", description: "Ожидающие разрешения" },
    { command: "tools", description: "Доступные MCP инструменты" },
    { command: "skills", description: "Список skills из goodai-base" },
    { command: "rules", description: "Список rules из goodai-base" },
  ]).catch((err) => console.error("[bot] failed to set commands:", err.message));

  // Error handler
  bot.catch((err) => {
    console.error("[bot] error:", err.message);
  });

  return bot;
}
