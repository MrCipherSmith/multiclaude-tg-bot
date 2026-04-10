import pino from "pino";
import fs from "fs";

/**
 * Shared structured logger. Uses LOG_LEVEL env var (default: info).
 * In MCP stdio mode (channel processes), use channelLogger which writes to stderr.
 *
 * Log files:
 *   Bot process  → /app/logs/bot.log   (mounted as ./logs/bot.log on host)
 *   Channel proc → LOG_FILE env var or /tmp/channel-<project>.log
 */

function tryOpenLogFile(path: string): pino.DestinationStream | null {
  try {
    fs.mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
    return pino.destination({ dest: path, sync: false });
  } catch {
    return null;
  }
}

function makeMultistream(streams: Array<NodeJS.WritableStream | pino.DestinationStream>) {
  const entries = streams.map((s) => ({ stream: s }));
  return pino.multistream(entries as pino.StreamEntry[]);
}

const BOT_LOG_FILE = process.env.BOT_LOG_FILE ?? "/app/logs/bot.log";
const CHANNEL_LOG_FILE = process.env.CHANNEL_LOG_FILE ?? "";

const LOG_LEVEL = process.env.LOG_LEVEL ?? "debug";

// Bot logger: stderr + file
const botFileStream = tryOpenLogFile(BOT_LOG_FILE);
export const logger = pino(
  { level: LOG_LEVEL },
  botFileStream
    ? makeMultistream([process.stderr, botFileStream])
    : process.stderr,
);

// Channel logger: stderr (fd 2, MCP-safe) + optional file
const channelFileStream = CHANNEL_LOG_FILE ? tryOpenLogFile(CHANNEL_LOG_FILE) : null;
export const channelLogger = pino(
  { level: LOG_LEVEL },
  channelFileStream
    ? makeMultistream([pino.destination(2), channelFileStream])
    : pino.destination(2),
);

export type Logger = pino.Logger;
