import type { Bot } from "grammy";
import { join, basename } from "path";
import { mkdir } from "fs/promises";
import { CONFIG } from "../config.ts";

const INBOX_DIR = CONFIG.DOWNLOADS_DIR ?? join("/tmp", ".claude/channels/telegram/inbox");

// Map container path to host path for CLI sessions
const HOST_DOWNLOADS_DIR = CONFIG.HOST_DOWNLOADS_DIR;

/** Return the path as seen from the host (for CLI sessions) */
export function toHostPath(containerPath: string): string {
  if (!HOST_DOWNLOADS_DIR || !CONFIG.DOWNLOADS_DIR) return containerPath;
  return containerPath.replace(CONFIG.DOWNLOADS_DIR, HOST_DOWNLOADS_DIR);
}

export async function downloadFile(
  bot: Bot,
  fileId: string,
  filename?: string,
): Promise<string> {
  await mkdir(INBOX_DIR, { recursive: true });

  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    // Happens when the file exceeds the Bot API 20 MB limit — Telegram omits file_path.
    throw new Error(`File not accessible via Bot API (possibly >20 MB, file_id=${fileId})`);
  }
  const filePath = file.file_path;
  const ext = filePath.split(".").pop() ?? "bin";
  const safeName = filename
    ? basename(filename).replace(/[^a-zA-Z0-9._\-]/g, "_") || `${fileId}.${ext}`
    : `${fileId}.${ext}`;
  const destPath = join(INBOX_DIR, safeName);

  const url = `https://api.telegram.org/file/bot${bot.token}/${filePath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });

  if (!res.ok) {
    throw new Error(`Failed to download file: ${res.status}`);
  }

  await Bun.write(destPath, res);
  return destPath;
}
