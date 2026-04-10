import pino from "pino";
import fs from "fs";

/**
 * Shared structured logger. Uses LOG_LEVEL env var (default: debug).
 * In MCP stdio mode (channel processes), use channelLogger which writes to stderr (fd 2).
 *
 * Log files:
 *   Bot process  → /app/logs/bot.log   (mounted as ./logs/bot.log on host)
 *   Channel proc → CHANNEL_LOG_FILE env var (set by run-cli.sh per project)
 */

const LOG_LEVEL = process.env.LOG_LEVEL ?? "debug";
const BOT_LOG_FILE = process.env.BOT_LOG_FILE ?? "/app/logs/bot.log";
const CHANNEL_LOG_FILE = process.env.CHANNEL_LOG_FILE ?? "";

function buildStreams(stderrFd: number, logFile: string): pino.MultiStreamRes | pino.DestinationStream {
  const streams: pino.StreamEntry[] = [
    { level: LOG_LEVEL as pino.Level, stream: pino.destination(stderrFd) },
  ];
  if (logFile) {
    try {
      fs.mkdirSync(logFile.replace(/\/[^/]+$/, ""), { recursive: true });
      streams.push({ level: LOG_LEVEL as pino.Level, stream: pino.destination({ dest: logFile, sync: true }) });
    } catch {
      // log dir not writable — stderr only
    }
  }
  return streams.length > 1 ? pino.multistream(streams) : streams[0].stream;
}

// Bot logger: stdout (fd 1 — default pino target) + bot.log file
export const logger = pino({ level: LOG_LEVEL }, buildStreams(1, BOT_LOG_FILE));

// Channel logger: stderr (fd 2 — MCP-safe, stdout used for JSON-RPC) + optional file
export const channelLogger = pino({ level: LOG_LEVEL }, buildStreams(2, CHANNEL_LOG_FILE));

export type Logger = pino.Logger;
