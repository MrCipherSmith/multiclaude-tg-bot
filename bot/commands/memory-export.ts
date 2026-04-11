import type { Context } from "grammy";
import { sql } from "../../memory/db.ts";
import { sessionManager } from "../../sessions/manager.ts";
import { rememberSmart } from "../../memory/long-term.ts";

interface ExportedMemory {
  id: number;
  source: string;
  type: string;
  content: string;
  tags: string[];
  project_path: string | null;
  created_at: string;
  updated_at: string;
}

interface ExportManifest {
  exported_at: string;
  bot_version: string;
  total: number;
  filters: Record<string, string | null>;
  memories: ExportedMemory[];
}

/**
 * /memory_export — export all active memories as a JSON file.
 * Usage: /memory_export [project_path]
 * Example: /memory_export /home/altsay/bots/helyx
 */
export async function handleMemoryExport(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const arg = text.replace(/^\/memory_export\s*/, "").trim() || null;

  const chatId = String(ctx.chat!.id);
  const activeSessionId = await sessionManager.getActiveSession(chatId);
  const session = activeSessionId ? await sessionManager.get(activeSessionId) : null;

  // If no arg given and session has a project_path, offer to filter by it
  const projectFilter = arg ?? null;

  const conditions = [sql`archived_at IS NULL`];
  if (projectFilter) conditions.push(sql`project_path = ${projectFilter}`);

  const where = conditions.reduce((a, b) => sql`${a} AND ${b}`);

  const rows = await sql`
    SELECT id, source, type, content, tags, project_path, created_at, updated_at
    FROM memories
    WHERE ${where}
    ORDER BY created_at ASC
  `;

  if (rows.length === 0) {
    await ctx.reply(projectFilter
      ? `No memories found for project: ${projectFilter}`
      : "No memories found.");
    return;
  }

  const manifest: ExportManifest = {
    exported_at: new Date().toISOString(),
    bot_version: "1.15.0",
    total: rows.length,
    filters: { project_path: projectFilter },
    memories: rows.map((r) => ({
      id: r.id as number,
      source: r.source as string,
      type: r.type as string,
      content: r.content as string,
      tags: (r.tags as string[]) ?? [],
      project_path: r.project_path as string | null,
      created_at: (r.created_at as Date).toISOString(),
      updated_at: (r.updated_at as Date).toISOString(),
    })),
  };

  const json = JSON.stringify(manifest, null, 2);
  const filename = projectFilter
    ? `memories-${projectFilter.split("/").pop()}-${Date.now()}.json`
    : `memories-${Date.now()}.json`;

  await ctx.replyWithDocument(
    { source: Buffer.from(json, "utf8"), filename },
    { caption: `Exported ${rows.length} memories${projectFilter ? ` (project: ${projectFilter})` : ""}` },
  );
}

/**
 * /memory_import — import memories from a previously exported JSON file.
 * Send the JSON file with /memory_import as caption.
 */
export async function handleMemoryImport(ctx: Context): Promise<void> {
  const doc = ctx.message?.document;
  if (!doc) {
    await ctx.reply(
      "Send a JSON export file with /memory_import as the caption.\n" +
      "Export first with: /memory_export",
    );
    return;
  }

  if (!doc.file_name?.endsWith(".json")) {
    await ctx.reply("File must be a .json export from /memory_export");
    return;
  }

  const chatId = String(ctx.chat!.id);
  const activeSessionId = await sessionManager.getActiveSession(chatId);

  const status = await ctx.reply("Importing memories...");

  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
    const text = await res.text();
    const manifest: ExportManifest = JSON.parse(text);

    if (!manifest.memories || !Array.isArray(manifest.memories)) {
      throw new Error("Invalid export format — missing memories array");
    }

    let added = 0, skipped = 0, updated = 0;

    for (const mem of manifest.memories) {
      if (!mem.content || !mem.type) { skipped++; continue; }
      try {
        const result = await rememberSmart({
          source: (mem.source as any) ?? "telegram",
          sessionId: activeSessionId ?? null,
          chatId,
          type: mem.type as any,
          content: mem.content,
          tags: mem.tags ?? [],
          projectPath: mem.project_path ?? null,
        });
        if (result.action === "added") added++;
        else if (result.action === "updated") updated++;
        else skipped++;
      } catch {
        skipped++;
      }
    }

    await ctx.api.editMessageText(
      chatId,
      status.message_id,
      `Import complete:\n✅ Added: ${added}\n🔄 Updated: ${updated}\n⏭ Skipped: ${skipped}\n\nTotal in file: ${manifest.memories.length}`,
    );
  } catch (err: any) {
    await ctx.api.editMessageText(
      chatId,
      status.message_id,
      `Import failed: ${err.message}`,
    );
  }
}
