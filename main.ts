import { CONFIG } from "./config.ts";
import { migrate, sql } from "./memory/db.ts";
import { createBot } from "./bot/bot.ts";
import { startMcpHttpServer } from "./mcp/server.ts";
import { stopAllTimers } from "./memory/summarizer.ts";
import { runCleanup } from "./cleanup/runner.ts";
import { permissionService } from "./services/permission-service.ts";
import { recoverStaleStatusMessages, deliverPendingReplies } from "./channel/recovery.ts";
import "./adapters/index.ts"; // Register all CLI adapters at startup

const DRY_RUN = process.env.DRY_RUN === "true";

function startCleanupTimer() {
  const INTERVAL = 60 * 60 * 1000; // 1 hour
  runCleanup(DRY_RUN, true); // run once at startup — skip markStale to let clients reconnect
  return setInterval(() => runCleanup(DRY_RUN), INTERVAL);
}

async function main() {
  console.log("[main] starting helyx...");

  // 1. Database migrations
  await migrate();

  // Recover stale pending permissions (process may have crashed mid-timeout)
  const expired = await permissionService.expireStale(120_000);
  if (expired > 0) console.log(`[main] expired ${expired} stale pending permission(s)`);

  // Recover stale status messages and undelivered replies from crashed channel processes
  await recoverStaleStatusMessages(sql, CONFIG.TELEGRAM_BOT_TOKEN);
  await deliverPendingReplies(sql, CONFIG.TELEGRAM_BOT_TOKEN);

  // Security check — fail fast if no access control is configured
  if (CONFIG.ALLOWED_USERS.length === 0 && !CONFIG.ALLOW_ALL_USERS) {
    console.error(
      "[main] FATAL: ALLOWED_USERS is not set and ALLOW_ALL_USERS is not 'true'.\n" +
      "  Set ALLOWED_USERS=<your_telegram_id> in .env, or set ALLOW_ALL_USERS=true to explicitly allow all users."
    );
    process.exit(1);
  }
  if (CONFIG.ALLOW_ALL_USERS) {
    console.warn("[main] ⚠ ALLOW_ALL_USERS=true — bot is open to ALL Telegram users");
  }

  // 2. Create Telegram bot
  const bot = createBot();

  // 3. Start MCP HTTP server
  const httpServer = startMcpHttpServer(bot);

  // 5. Start cleanup timer
  const cleanupTimer = startCleanupTimer();

  // 6. Start Telegram transport
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
