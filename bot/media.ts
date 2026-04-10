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
import { getBotRef, setPendingInput } from "./handlers.ts";
import { getForumChatId } from "./forum-cache.ts";
import { enqueueForTopic, topicQueueKey } from "./topic-queue.ts";

const IMAGE_INLINE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — include base64 inline

/** Deliver a downloaded file to Claude (cli queue or standalone LLM). */
async function deliverMedia(
  ctx: Context,
  route: Awaited<ReturnType<typeof routeMessage>>,
  filePath: string,
  hostPath: string,
  description: string,
  caption: string,
  fileId: string,
  filename?: string,
  mimeType?: string,
  messageId?: number,
): Promise<void> {
  const bot = getBotRef();
  const chatId = String(ctx.chat!.id);
  const fromUser = ctx.from?.username ?? ctx.from?.first_name ?? "user";
  const text = `${description}: ${caption}\n[file: ${hostPath}]`;

  if (route.mode === "cli") {
    const isImage = (mimeType ?? "").startsWith("image/") || description.startsWith("Photo");
    let attachment: Record<string, unknown>;

    if (isImage) {
      const fileData = await Bun.file(filePath).arrayBuffer();
      if (fileData.byteLength <= IMAGE_INLINE_MAX_BYTES) {
        const base64 = Buffer.from(fileData).toString("base64");
        attachment = { type: "image", base64, mime: mimeType ?? "image/jpeg", path: hostPath, caption };
      } else {
        attachment = { type: "image", path: hostPath, mime: mimeType ?? "image/jpeg", caption };
      }
    } else {
      attachment = { type: "file", path: hostPath, name: filename ?? null, mime: mimeType ?? null, caption };
    }

    await addMessage({
      sessionId: route.sessionId,
      projectPath: route.projectPath,
      chatId,
      role: "user",
      content: text,
      metadata: { fileId, filePath, messageId },
    });
    await sql`
      INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id, attachments)
      VALUES (
        ${route.sessionId}, ${chatId}, ${fromUser}, ${text},
        ${String(messageId ?? "")}, ${JSON.stringify([attachment])}
      )
    `;
    return;
  }

  // Standalone
  const sessionId = route.sessionId;
  const { provider } = getProviderInfo();

  await addMessage({
    sessionId,
    projectPath: route.projectPath,
    chatId,
    role: "user",
    content: text,
    metadata: { fileId, filePath, messageId },
  });

  const isPhoto = description.startsWith("Photo");
  if (provider === "anthropic" && isPhoto) {
    try {
      const fileData = await Bun.file(filePath).arrayBuffer();
      const base64 = Buffer.from(fileData).toString("base64");
      const imageMime = "image/jpeg";
      const { system, messages } = await composePrompt(sessionId, chatId, caption);
      const lastMsg = messages[messages.length - 1];
      const imageBlocks: ContentBlock[] = [
        { type: "image", source: { type: "base64", media_type: imageMime, data: base64 } },
        { type: "text", text: caption },
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

async function handleMedia(
  ctx: Context,
  fileId: string,
  description: string,
  caption?: string,
  filename?: string,
  mimeType?: string,
): Promise<void> {
  const bot = getBotRef();
  const chatId = String(ctx.chat!.id);
  const forumTopicId = ctx.message?.message_thread_id;
  const forumChatId = await getForumChatId();
  const isForumMessage = forumChatId !== null && chatId === forumChatId;

  if (isForumMessage && (!forumTopicId || forumTopicId === 1)) {
    await ctx.reply("💡 General — только команды.\nОткрой топик проекта чтобы работать с сессией.");
    return;
  }

  const route = await routeMessage(chatId, isForumMessage ? forumTopicId : undefined);

  await ctx.replyWithChatAction("typing");

  let filePath: string;
  try {
    filePath = await downloadFile(bot, fileId, filename);
  } catch (err) {
    logger.error({ err }, "file download failed");
    await ctx.reply("Failed to download file.");
    return;
  }

  const hostPath = toHostPath(filePath);
  logger.info({ route: route.mode, hostPath }, "media downloaded");

  if (!caption) {
    // No caption — save file and ask what to do with it
    const fileLabel = filename ? `\`${filename}\`` : description;
    await ctx.reply(`📎 ${fileLabel} сохранён. Что с ним сделать?`);
    const origMessageId = ctx.message?.message_id;
    setPendingInput(chatId, async (replyCtx) => {
      const userCaption = replyCtx.message?.text ?? "";
      await deliverMedia(
        replyCtx, route, filePath, hostPath, description,
        userCaption, fileId, filename, mimeType,
        replyCtx.message?.message_id ?? origMessageId,
      );
    }, 5 * 60_000); // 5 min TTL — user may take time to decide
    return;
  }

  await deliverMedia(ctx, route, filePath, hostPath, description, caption, fileId, filename, mimeType, ctx.message?.message_id);
}

export async function handlePhoto(ctx: Context): Promise<void> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) return;
  // Get highest resolution
  const photo = photos[photos.length - 1];
  await handleMedia(ctx, photo.file_id, "Photo", ctx.message?.caption, undefined, "image/jpeg");
}

export async function handleDocument(ctx: Context): Promise<void> {
  const doc = ctx.message?.document;
  if (!doc) return;
  logger.info({ fileId: doc.file_id, fileName: doc.file_name, mime: doc.mime_type, size: doc.file_size }, "document received");
  await handleMedia(
    ctx,
    doc.file_id,
    `Document (${doc.file_name ?? "file"}, ${doc.mime_type ?? "unknown"})`,
    ctx.message?.caption,
    doc.file_name ?? undefined,
    doc.mime_type ?? undefined,
  );
}

export async function handleVoice(ctx: Context): Promise<void> {
  const bot = getBotRef();
  const voice = ctx.message?.voice;
  if (!voice) return;

  const chatId = String(ctx.chat!.id);
  const forumTopicId = ctx.message?.message_thread_id;
  const forumChatId = await getForumChatId();
  const isForumMessage = forumChatId !== null && chatId === forumChatId;

  if (isForumMessage && (!forumTopicId || forumTopicId === 1)) {
    await ctx.reply("💡 General — только команды.\nОткрой топик проекта чтобы работать с сессией.");
    return;
  }

  const route = await routeMessage(chatId, isForumMessage ? forumTopicId : undefined);
  appendLog(route.sessionId, chatId, "voice", `received ${voice.duration}s, route=${route.mode}`);

  // Send status immediately (user feedback before queue slot opens)
  const statusMsg = await ctx.reply(`🎤 Voice message (${voice.duration}s) — downloading...`);

  const queueKey = topicQueueKey(chatId, isForumMessage ? forumTopicId : null);
  enqueueForTopic(queueKey, async () => {
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
      appendLog(route.sessionId, chatId, "voice", "transcription failed", "error");
      await bot.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "🎤 Failed to transcribe. Sending as file...");
      await handleMedia(ctx, voice.file_id, `Voice message (${voice.duration}s, not transcribed)`);
    }
  });
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
