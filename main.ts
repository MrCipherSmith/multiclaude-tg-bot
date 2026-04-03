import { CONFIG } from "./config.ts";
import { migrate, sql } from "./memory/db.ts";
import { createBot } from "./bot/bot.ts";
import { startMcpHttpServer } from "./mcp/server.ts";

async function main() {
  console.log("[main] starting claude-bot...");

  // 1. Database migrations
  await migrate();

  // 2. Create Telegram bot
  const bot = createBot();

  // 3. Start MCP HTTP server
  const httpServer = startMcpHttpServer(bot);

  // 4. Start Telegram polling
  console.log("[main] starting Telegram polling...");
  bot.start({
    onStart: () => console.log(`[main] bot @${bot.botInfo.username} is running`),
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[main] shutting down...");
    httpServer.close();
    await bot.stop();
    await sql.end();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[main] fatal:", err);
  process.exit(1);
});
