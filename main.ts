import { CONFIG } from "./config.ts";
import { migrate, sql } from "./memory/db.ts";
import { createBot } from "./bot/bot.ts";
import { startMcpHttpServer } from "./mcp/server.ts";
import { stopAllTimers } from "./memory/summarizer.ts";
import { sessionManager } from "./sessions/manager.ts";

function startCleanupTimer() {
  const INTERVAL = 60 * 60 * 1000; // 1 hour

  const cleanup = async () => {
    try {
      const mq = await sql`DELETE FROM message_queue WHERE delivered = true AND created_at < now() - interval '24 hours'`;
      const logs = await sql`DELETE FROM request_logs WHERE created_at < now() - interval '7 days'`;
      const stats = await sql`DELETE FROM api_request_stats WHERE created_at < now() - interval '30 days'`;
      const perms = await sql`DELETE FROM permission_requests WHERE created_at < now() - interval '1 hour'`;
      // Mark stale "active" sessions that have no live transport (10 min threshold)
      const stale = await sessionManager.markStale(600);
      // Delete all disconnected sessions (except standalone #0)
      const cliJunk = await sql`DELETE FROM sessions WHERE status = 'disconnected' AND id != 0`;
      // Always reset sequence to avoid ID gaps
      await sessionManager.resetSequence();
      const total = mq.count + logs.count + stats.count + perms.count + cliJunk.count + stale;
      if (total > 0) {
        console.log(`[cleanup] queue=${mq.count} logs=${logs.count} stats=${stats.count} perms=${perms.count} cli_junk=${cliJunk.count} stale=${stale}`);
      }
    } catch (err) {
      console.error("[cleanup] error:", err);
    }
  };

  cleanup(); // run once at startup
  return setInterval(cleanup, INTERVAL);
}

async function main() {
  console.log("[main] starting claude-bot...");

  // 1. Database migrations
  await migrate();

  // 2. Create Telegram bot
  const bot = createBot();

  // 3. Start MCP HTTP server
  const httpServer = startMcpHttpServer(bot);

  // 4. Start cleanup timer
  const cleanupTimer = startCleanupTimer();

  // 5. Start Telegram transport
  if (CONFIG.TELEGRAM_TRANSPORT === "webhook") {
    await bot.api.setWebhook(CONFIG.TELEGRAM_WEBHOOK_URL, {
      secret_token: CONFIG.TELEGRAM_WEBHOOK_SECRET || undefined,
      allowed_updates: ["message", "callback_query"],
    });
    await bot.init();
    console.log(`[main] webhook registered at ${CONFIG.TELEGRAM_WEBHOOK_URL}`);
    console.log(`[main] bot @${bot.botInfo.username} is running (webhook)`);
  } else {
    console.log("[main] starting Telegram polling...");
    bot.start({
      onStart: () => console.log(`[main] bot @${bot.botInfo.username} is running (polling)`),
    });
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[main] shutting down...");
    clearInterval(cleanupTimer);
    stopAllTimers();
    httpServer.close();
    if (CONFIG.TELEGRAM_TRANSPORT === "webhook") {
      await bot.api.deleteWebhook();
    } else {
      await bot.stop();
    }
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
