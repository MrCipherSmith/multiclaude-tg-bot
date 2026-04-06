import { CONFIG } from "./config.ts";
import { migrate, sql } from "./memory/db.ts";
import { createBot } from "./bot/bot.ts";
import { startMcpHttpServer } from "./mcp/server.ts";
import { stopAllTimers, cleanupStaleTimers } from "./memory/summarizer.ts";
import { sessionManager } from "./sessions/manager.ts";
import "./adapters/index.ts"; // Register all CLI adapters at startup

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
      // Clear chat_sessions referencing disconnected sessions, then delete them
      // Must delete child rows first to satisfy FK constraints
      await sql`DELETE FROM chat_sessions WHERE active_session_id IN (SELECT id FROM sessions WHERE status = 'disconnected' AND id != 0)`;
      await sql`DELETE FROM memories WHERE session_id IN (SELECT id FROM sessions WHERE status = 'disconnected' AND id != 0)`;
      await sql`DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE status = 'disconnected' AND id != 0)`;
      await sql`DELETE FROM permission_requests WHERE session_id IN (SELECT id FROM sessions WHERE status = 'disconnected' AND id != 0)`;
      await sql`DELETE FROM message_queue WHERE session_id IN (SELECT id FROM sessions WHERE status = 'disconnected' AND id != 0)`;
      await sql`DELETE FROM request_logs WHERE session_id IN (SELECT id FROM sessions WHERE status = 'disconnected' AND id != 0)`;
      await sql`DELETE FROM api_request_stats WHERE session_id IN (SELECT id FROM sessions WHERE status = 'disconnected' AND id != 0)`;
      await sql`DELETE FROM transcription_stats WHERE session_id IN (SELECT id FROM sessions WHERE status = 'disconnected' AND id != 0)`;
      const cliJunk = await sql`DELETE FROM sessions WHERE status = 'disconnected' AND id != 0`;
      // Clean up stale idle timers for disconnected sessions
      await cleanupStaleTimers();
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

  // Security warnings
  if (CONFIG.ALLOWED_USERS.length === 0) {
    console.warn("[main] ⚠ WARNING: ALLOWED_USERS is empty — bot and dashboard are open to ALL Telegram users!");
  }

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

  // Graceful shutdown with request drain
  const shutdown = async () => {
    console.log("[main] shutting down...");
    clearInterval(cleanupTimer);
    stopAllTimers();

    // Stop accepting new connections, drain in-flight requests (5s timeout)
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      setTimeout(resolve, 5000);
    });

    if (CONFIG.TELEGRAM_TRANSPORT === "webhook") {
      await bot.api.deleteWebhook().catch(() => {});
    } else {
      await bot.stop();
    }
    await sql.end();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException:", err);
});

main().catch((err) => {
  console.error("[main] fatal:", err);
  process.exit(1);
});
