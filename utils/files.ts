import type { Bot } from "grammy";
import { join } from "path";
import { mkdir } from "fs/promises";

const INBOX_DIR = join(
  process.env.HOME ?? "/tmp",
  ".claude/channels/telegram/inbox",
);

export async function downloadFile(
  bot: Bot,
  fileId: string,
  filename?: string,
): Promise<string> {
  await mkdir(INBOX_DIR, { recursive: true });

  const file = await bot.api.getFile(fileId);
  const filePath = file.file_path!;
  const ext = filePath.split(".").pop() ?? "bin";
  const safeName = filename ?? `${fileId}.${ext}`;
  const destPath = join(INBOX_DIR, safeName);

  const url = `https://api.telegram.org/file/bot${bot.token}/${filePath}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Failed to download file: ${res.status}`);
  }

  await Bun.write(destPath, res);
  return destPath;
}
