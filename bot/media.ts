import type { Context } from "grammy";
import { composePrompt } from "../claude/prompt.ts";
import { getProviderInfo, type ContentBlock } from "../claude/client.ts";
import { addMessage } from "../memory/short-term.ts";
import { streamToTelegram } from "./streaming.ts";
import { routeMessage } from "../sessions/router.ts";
import { downloadFile, toHostPath } from "../utils/files.ts";
import { transcribe } from "../utils/transcribe.ts";
import { touchIdleTimer } from "../memory/summarizer.ts";
import { sql } from "../memory/db.ts";
import { logger } from "../logger.ts";
import { appendLog } from "../utils/stats.ts";
import { getBotRef } from "./handlers.ts";

async function handleMedia(
  ctx: Context,
  fileId: string,
  description: string,
  caption?: string,
  filename?: string,
): Promise<void> {
  const bot = getBotRef();
  const chatId = String(ctx.chat!.id);
  const route = await routeMessage(chatId);

  // Show typing indicator while downloading
  await ctx.replyWithChatAction("typing");

  // Download file
  let filePath: string;
  try {
    filePath = await downloadFile(bot, fileId, filename);
  } catch (err) {
    logger.error({ err }, "file download failed");
    await ctx.reply("Failed to download file.");
    return;
  }

  const hostPath = toHostPath(filePath);
  const text = caption
    ? `${description}: ${caption}\n[file: ${hostPath}]`
    : `${description}\n[file: ${hostPath}]`;

  if (route.mode === "cli") {
    await addMessage({
      sessionId: route.sessionId,
      projectPath: route.projectPath,
      chatId,
      role: "user",
      content: text,
      metadata: { fileId, filePath, messageId: ctx.message?.message_id },
    });

    await sql`
      INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
      VALUES (
        ${route.sessionId},
        ${chatId},
        ${ctx.from?.username ?? ctx.from?.first_name ?? "user"},
        ${text},
        ${String(ctx.message?.message_id ?? "")}
      )
    `;
    return;
  }

  // Standalone: process with available provider
  const sessionId = route.sessionId;
  const { provider } = getProviderInfo();

  // Save text description to DB (no base64)
  await addMessage({
    sessionId,
    projectPath: route.projectPath,
    chatId,
    role: "user",
    content: text,
    metadata: { fileId, filePath, messageId: ctx.message?.message_id },
  });

  // If Anthropic provider and it's a photo, send image to Claude for analysis
  const isPhoto = description.startsWith("Photo");
  if (provider === "anthropic" && isPhoto) {
    try {
      const fileData = await Bun.file(filePath).arrayBuffer();
      const base64 = Buffer.from(fileData).toString("base64");
      const mimeType = "image/jpeg"; // Telegram always sends photos as JPEG

      const { system, messages } = await composePrompt(sessionId, chatId, caption || "Describe what's in the image");

      // Replace last message content with image + text blocks
      const lastMsg = messages[messages.length - 1];
      const imageBlocks: ContentBlock[] = [
        { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
        { type: "text", text: caption || "Describe what's in the image" },
      ];
      messages[messages.length - 1] = { role: lastMsg.role, content: imageBlocks };

      appendLog(sessionId, chatId, "llm", "analyzing image...");
      const response = await streamToTelegram(bot, ctx.chat!.id, system, messages, { sessionId, chatId, operation: "chat" });
      appendLog(sessionId, chatId, "reply", `image reply sent ${response.length} chars`);

      await addMessage({ sessionId, projectPath: route.projectPath, chatId, role: "assistant", content: response });
      return;
    } catch (err: any) {
      appendLog(sessionId, chatId, "llm", `image analysis failed: ${err?.message}`, "error");
    }
  }

  await ctx.reply(`Received ${description}. File saved.`);
}

export async function handlePhoto(ctx: Context): Promise<void> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) return;
  // Get highest resolution
  const photo = photos[photos.length - 1];
  await handleMedia(ctx, photo.file_id, "Photo", ctx.message?.caption);
}

export async function handleDocument(ctx: Context): Promise<void> {
  const doc = ctx.message?.document;
  if (!doc) return;
  await handleMedia(
    ctx,
    doc.file_id,
    `Document (${doc.file_name ?? "file"}, ${doc.mime_type ?? "unknown"})`,
    ctx.message?.caption,
    doc.file_name ?? undefined,
  );
}

export async function handleVoice(ctx: Context): Promise<void> {
  const bot = getBotRef();
  const voice = ctx.message?.voice;
  if (!voice) return;

  const chatId = String(ctx.chat!.id);
  const route = await routeMessage(chatId);

  appendLog(route.sessionId, chatId, "voice", `received ${voice.duration}s, route=${route.mode}`);

  // Send status message that we'll update
  const statusMsg = await ctx.reply(`🎤 Voice message (${voice.duration}s) — downloading...`);
  await ctx.replyWithChatAction("typing");

  // Download voice file
  let filePath: string;
  try {
    filePath = await downloadFile(bot, voice.file_id);
    appendLog(route.sessionId, chatId, "voice", `downloaded: ${filePath}`);
  } catch (err) {
    logger.error({ err }, "voice download failed");
    appendLog(route.sessionId, chatId, "voice", `download failed: ${err}`, "error");
    await bot.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "🎤 Failed to download voice message.");
    return;
  }

  // Transcribe — with live elapsed-time progress updates
  await bot.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "🎤 Transcribing speech...");
  const fileData = await Bun.file(filePath).arrayBuffer();

  const transcribeStart = Date.now();
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let progressCancelled = false;

  // Only start progress ticker for voice messages ≥10s (short ones resolve before first tick)
  if (voice.duration >= 10) {
    progressTimer = setInterval(() => {
      if (progressCancelled) return;
      const elapsed = Math.round((Date.now() - transcribeStart) / 1000);
      bot.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `🎤 Transcribing... (${elapsed}s)`).catch(() => {});
    }, 5000);
  }

  let text: string | null;
  try {
    text = await transcribe(fileData, "voice.ogg", voice.mime_type ?? "audio/ogg", {
      sessionId: route.sessionId,
      chatId,
      audioDurationSec: voice.duration,
    });
  } finally {
    progressCancelled = true;
    if (progressTimer) clearInterval(progressTimer);
  }

  if (text) {
    appendLog(route.sessionId, chatId, "voice", `transcribed: ${text.slice(0, 80)}`);
    await bot.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `🎤 Transcribed: ${text}`);

    // Process as text message with transcription
    const content = `🎤 ${text}`;

    if (route.mode === "cli") {
      await addMessage({
        sessionId: route.sessionId,
        projectPath: route.projectPath,
        chatId,
        role: "user",
        content,
        metadata: { voiceFile: filePath, messageId: ctx.message?.message_id },
      });
      await sql`
        INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
        VALUES (
          ${route.sessionId}, ${chatId},
          ${ctx.from?.username ?? ctx.from?.first_name ?? "user"},
          ${content}, ${String(ctx.message?.message_id ?? "")}
        )
      `;
      appendLog(route.sessionId, chatId, "queue", "voice message queued for CLI");
      touchIdleTimer(route.sessionId, chatId, route.projectPath);
    } else if (route.mode === "standalone") {
      await addMessage({
        sessionId: route.sessionId,
        projectPath: route.projectPath,
        chatId,
        role: "user",
        content,
        metadata: { voiceFile: filePath, messageId: ctx.message?.message_id },
      });
      const { system, messages } = await composePrompt(route.sessionId, chatId, content);
      appendLog(route.sessionId, chatId, "llm", "streaming voice response...");
      const response = await streamToTelegram(bot, ctx.chat!.id, system, messages, { sessionId: route.sessionId, chatId, operation: "chat" });
      appendLog(route.sessionId, chatId, "reply", `voice reply sent ${response.length} chars`);
      await addMessage({ sessionId: route.sessionId, projectPath: route.projectPath, chatId, role: "assistant", content: response });
      touchIdleTimer(route.sessionId, chatId, route.projectPath);
    } else {
      appendLog(route.sessionId, chatId, "voice", `no handler for mode=${route.mode}`, "warn");
    }
  } else {
    // Transcription failed
    appendLog(route.sessionId, chatId, "voice", "transcription failed", "error");
    await bot.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "🎤 Failed to transcribe. Sending as file...");
    await handleMedia(ctx, voice.file_id, `Voice message (${voice.duration}s, not transcribed)`);
  }
}

export async function handleVideo(ctx: Context): Promise<void> {
  const video = ctx.message?.video;
  if (!video) return;
  await handleMedia(
    ctx,
    video.file_id,
    `Video (${video.duration}s)`,
    ctx.message?.caption,
    video.file_name ?? undefined,
  );
}

export async function handleVideoNote(ctx: Context): Promise<void> {
  const vn = ctx.message?.video_note;
  if (!vn) return;
  await handleMedia(ctx, vn.file_id, `Video message (${vn.duration}s)`);
}

export async function handleSticker(ctx: Context): Promise<void> {
  const sticker = ctx.message?.sticker;
  if (!sticker) return;
  const emoji = sticker.emoji ?? "";
  const text = `Sticker ${emoji} (${sticker.set_name ?? "no set"})`;
  // Don't download sticker, just notify
  const chatId = String(ctx.chat!.id);
  const route = await routeMessage(chatId);

  if (route.mode === "cli") {
    await sql`
      INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
      VALUES (
        ${route.sessionId},
        ${chatId},
        ${ctx.from?.username ?? ctx.from?.first_name ?? "user"},
        ${text},
        ${String(ctx.message?.message_id ?? "")}
      )
    `;
  }
}
