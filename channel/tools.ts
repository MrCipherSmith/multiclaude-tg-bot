/**
 * MCP tool registry and dispatch.
 */

import { resolve } from "path";
import type postgres from "postgres";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { markdownToTelegramHtml } from "../bot/format.ts";
import type { StatusManager } from "./status.ts";
import { sendTelegramMessage, setTelegramReaction, editTelegramMessage, sendTelegramPoll, deleteTelegramMessage } from "./telegram.ts";
import { maybeAttachVoiceRaw, shouldSendVoice } from "../utils/tts.ts";
import { channelLogger } from "../logger.ts";
import { scanProjectKnowledge } from "../memory/project-scanner.ts";
import { CONFIG } from "../config.ts";
import {
  runTtsBenchmark,
  appendBenchmarkLog,
  formatBenchmarkReport,
  detectRussian,
  sendTelegramVoice,
} from "../utils/benchmark.ts";

/** Benchmark: run both TTS pipelines, send two voice messages + stats report. */
function runTtsBenchmarkAndReport(
  token: string,
  chatId: string,
  replyText: string,
  threadId: number | null,
  forceVoice: boolean,
): void {
  channelLogger.info({ forceVoice, textLen: replyText.length, threadId }, "tts-bench: runTtsBenchmarkAndReport called");
  const svResult = shouldSendVoice(replyText);
  channelLogger.info({ forceVoice, shouldSendVoice: svResult }, "tts-bench: guard check");
  if (!forceVoice && !svResult) return;

  const isRussian = detectRussian(replyText);

  channelLogger.info({ isRussian }, "tts-bench: starting runTtsBenchmark");
  runTtsBenchmark(replyText, isRussian)
    .then(async (results) => {
      channelLogger.info({ count: results.length, providers: results.map(r => r.provider + ':' + r.success) }, "tts-bench: results");
      // Send both voice messages with a gap to reduce 429 rate-limit hits
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (r.buf && r.fmt) {
          if (i > 0) await new Promise(res => setTimeout(res, 4000));
          channelLogger.info({ provider: r.provider, bytes: r.buf.length }, "tts-bench: sending voice");
          await sendTelegramVoice(token, chatId, r.buf, r.fmt, threadId, `🎙 ${r.provider}`);
        }
      }

      // Send comparison stats
      const report = formatBenchmarkReport([], results, undefined);
      await sendTelegramMessage(token, chatId, report, { parse_mode: "HTML", ...(threadId !== null && { message_thread_id: threadId }) });

      // Log to file
      appendBenchmarkLog({
        ts: new Date().toISOString(),
        chatId,
        asr: [],
        tts: results.map(({ buf: _buf, ...r }) => r),
      });
    })
    .catch((err) => channelLogger.error({ err }, "benchmark: TTS benchmark failed"));
}

export interface ToolContext {
  sql: postgres.Sql;
  mcp: Server;
  sessionId: () => number | null;
  sessionName: () => string;
  projectPath: string;
  token: () => string | undefined;
  ollamaUrl: string;
  embeddingModel: string;
  /** Forum supergroup chat ID — when set, replies include message_thread_id */
  forumChatId?: () => string | null;
  /** Forum topic ID for this project */
  forumTopicId?: () => number | null;
  /** Returns true if the current message was a voice message → force TTS reply */
  forceVoice?: () => boolean;
}

async function embed(text: string, ollamaUrl: string, embeddingModel: string): Promise<number[]> {
  const res = await fetch(`${ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: embeddingModel, input: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`);
  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings[0];
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

export function registerTools(
  ctx: ToolContext,
  status: StatusManager,
  touchIdleTimer: () => void,
): void {
  ctx.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "reply",
        description: "Send a message to a Telegram chat",
        inputSchema: {
          type: "object",
          properties: {
            chat_id: { type: "string", description: "Telegram chat ID" },
            text: { type: "string", description: "Message text" },
          },
          required: ["chat_id", "text"],
        },
      },
      {
        name: "remember",
        description: "Save project knowledge or a decision to long-term memory. Use type='fact' for architectural discoveries, non-obvious constraints, important file roles, setup quirks, and conventions that future sessions should know. Write content as a self-contained sentence.",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "What to remember" },
            type: { type: "string", enum: ["fact", "summary", "decision", "note"], default: "note" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["content"],
        },
      },
      {
        name: "recall",
        description: "Semantic search through long-term memory",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            limit: { type: "number", default: 5 },
          },
          required: ["query"],
        },
      },
      {
        name: "forget",
        description: "Delete a memory by ID",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "Memory ID" },
          },
          required: ["id"],
        },
      },
      {
        name: "update_status",
        description: "Update the status message shown to the user in Telegram while processing. Call this before major operations to keep the user informed. Optionally include a diff to show file changes.",
        inputSchema: {
          type: "object",
          properties: {
            chat_id: { type: "string", description: "Telegram chat ID" },
            status: { type: "string", description: "Short status text, e.g. 'Analyzing code', 'Running tests'" },
            diff: { type: "string", description: "Optional diff/code block to display as a separate message. Supports markdown formatting." },
          },
          required: ["chat_id", "status"],
        },
      },
      {
        name: "list_memories",
        description: "List memories with optional filters",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["fact", "summary", "decision", "note"] },
            limit: { type: "number", default: 20 },
          },
        },
      },
      {
        name: "search_project_context",
        description: "Semantic search over long-term project context and work summaries. Use when you need knowledge from prior sessions about this project.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural language search query" },
            project_path: { type: "string", description: "Project path to search in. Defaults to current session project_path." },
            limit: { type: "number", description: "Number of results to return (default: 5, max: 20)" },
          },
          required: ["query"],
        },
      },
      {
        name: "scan_project_knowledge",
        description: "Scan a project directory and save structural knowledge (tech stack, architecture, entry points, setup) to long-term memory. Run this to force a rescan after major changes.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Project directory to scan. Defaults to current session project_path." },
            force_rescan: { type: "boolean", description: "Archive existing project knowledge and rescan from scratch (default: false)" },
          },
        },
      },
      {
        name: "react",
        description: "Set an emoji reaction on a Telegram message",
        inputSchema: {
          type: "object",
          properties: {
            chat_id: { type: "string", description: "Telegram chat ID" },
            message_id: { type: "number", description: "Message ID to react to" },
            emoji: { type: "string", description: "Single emoji character (e.g. '👍', '❤️', '🔥')" },
          },
          required: ["chat_id", "message_id", "emoji"],
        },
      },
      {
        name: "edit_message",
        description: "Edit a previously sent bot message",
        inputSchema: {
          type: "object",
          properties: {
            chat_id: { type: "string", description: "Telegram chat ID" },
            message_id: { type: "number", description: "Message ID to edit" },
            text: { type: "string", description: "New message text" },
          },
          required: ["chat_id", "message_id", "text"],
        },
      },
      {
        name: "send_poll",
        description: "Send a questionnaire to the user as Telegram polls. Use this when you need clarification with multiple-choice answers. The user answers each poll and clicks Submit — their answers are automatically sent back to you.",
        inputSchema: {
          type: "object",
          properties: {
            chat_id: { type: "string", description: "Telegram chat ID" },
            title: { type: "string", description: "Brief description of what the questions are for (shown before polls)" },
            questions: {
              type: "array",
              description: "List of questions with options (2–10 options each, max 300 chars per question, max 100 chars per option)",
              items: {
                type: "object",
                properties: {
                  question: { type: "string" },
                  options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 10 },
                },
                required: ["question", "options"],
              },
              minItems: 1,
            },
          },
          required: ["chat_id", "questions"],
        },
      },
    ],
  }));

  ctx.mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const sessionId = ctx.sessionId();

    if (sessionId !== null) {
      ctx.sql`UPDATE sessions SET last_active = now() WHERE id = ${sessionId}`.catch(() => {});
    }

    switch (name) {
      case "reply": {
        const chatId = String(args!.chat_id);
        channelLogger.info({ phase: "tools", step: "reply-called", chatId, t: Date.now() }, "perf");
        status.stopTypingForChat(chatId);
        status.stopProgressMonitorForChat(chatId);

        const token = ctx.token();
        if (!token) {
          channelLogger.warn("reply: no TELEGRAM_BOT_TOKEN");
          return text("TELEGRAM_BOT_TOKEN not set");
        }

        // In forum mode: inject message_thread_id so reply lands in the project topic.
        // Always query DB fresh — startup snapshot may be stale (topic recreated, or project
        // added after subprocess started).
        const forumChatId = ctx.forumChatId?.();
        let forumTopicId: number | null = null;
        if (forumChatId && chatId === forumChatId) {
          const rows = await ctx.sql`SELECT forum_topic_id FROM projects WHERE path = ${ctx.projectPath}`;
          forumTopicId = rows[0]?.forum_topic_id ?? null;
        }
        const isForumReply = !!(forumChatId && forumTopicId && chatId === forumChatId);
        const forumExtra = isForumReply ? { message_thread_id: forumTopicId } : {};

        let activeSessionId: number | null = null;
        if (!isForumReply) {
          const activeCheck = await ctx.sql`
            SELECT active_session_id FROM chat_sessions WHERE chat_id = ${chatId}
          `;
          activeSessionId = activeCheck[0]?.active_session_id ?? null;
        }
        const isActiveDm = isForumReply || activeSessionId === null || activeSessionId === sessionId;

        // Buffer reply to DB before sending — lets the bot retry if Telegram is temporarily down
        let pendingReplyId: number | null = null;
        try {
          const [pendingRow] = await ctx.sql`
            INSERT INTO pending_replies (session_id, chat_id, thread_id, text)
            VALUES (${sessionId}, ${chatId}, ${forumTopicId ?? null}, ${String(args!.text)})
            RETURNING id
          `;
          pendingReplyId = pendingRow?.id ?? null;
        } catch {
          // Non-fatal: continue even if DB write fails
        }

        // Pre-mark as delivered before sending to Telegram — prevents recovery from
        // resending on restart if the process dies after a successful Telegram send
        // but before the post-send UPDATE completes (TOCTOU duplicate bug).
        if (pendingReplyId) {
          ctx.sql`UPDATE pending_replies SET delivered_at = NOW() WHERE id = ${pendingReplyId}`.catch(() => {});
        }

        let replyText = String(args!.text);
        if (!isActiveDm && sessionId) {
          const bgName = ctx.sessionName() || `#${sessionId}`;
          replyText = `📌 **${bgName}**\n\n${replyText}\n\n_/switch ${sessionId} — switch_`;
          channelLogger.info({ sessionId, name: bgName }, "reply from background session");
        }

        channelLogger.info({ chatId, preview: replyText.slice(0, 50) }, "sending reply");
        const htmlText = markdownToTelegramHtml(replyText);

        const replyMarkup = (!isActiveDm && sessionId)
          ? { inline_keyboard: [[{ text: "↩️ Switch and reply", callback_data: `switch:${sessionId}` }]] }
          : undefined;

        let res = await sendTelegramMessage(token, chatId, htmlText, {
          parse_mode: "HTML",
          ...forumExtra,
          ...(replyMarkup && { reply_markup: replyMarkup }),
        });

        if (!res.ok) {
          if (res.errorBody?.includes("can't parse entities")) {
            res = await sendTelegramMessage(token, chatId, replyText, { ...forumExtra, ...(replyMarkup && { reply_markup: replyMarkup }) });
            if (!res.ok) {
              channelLogger.warn({ error: res.errorBody }, "reply: Telegram API error (fallback)");
              status.deleteStatusMessage(chatId).catch(() => {});
              return text(`Telegram API error`);
            }
          } else {
            channelLogger.warn({ error: res.errorBody }, "reply: Telegram API error");
            status.deleteStatusMessage(chatId).catch(() => {});
            return text(`Telegram API error`);
          }
        }

        channelLogger.info({ phase: "tools", step: "reply-sent", chatId, t: Date.now() }, "perf");
        // Delete status non-blocking — don't await, avoids holding up reply return when
        // Telegram rate-limits editMessageText (can block for 60+ seconds otherwise).
        status.deleteStatusMessage(chatId).catch((err) => channelLogger.warn({ err }, "deleteStatusMessage failed"));
        // Fire-and-forget TTS voice attachment (forced if user sent voice, otherwise ≥300 chars)
        if (CONFIG.KESHA_BENCHMARK) {
          runTtsBenchmarkAndReport(token, chatId, replyText, forumTopicId ?? null, ctx.forceVoice?.() ?? false);
        } else {
          maybeAttachVoiceRaw(token, chatId, replyText, forumTopicId ?? null, ctx.forceVoice?.() ?? false);
        }
        if (sessionId) {
          await ctx.sql`
            INSERT INTO messages (session_id, project_path, chat_id, role, content)
            VALUES (${sessionId}, ${ctx.projectPath}, ${String(args!.chat_id)}, 'assistant', ${String(args!.text)})
          `;
        }
        touchIdleTimer();
        return text(`Sent to chat ${args!.chat_id}`);
      }

      case "react": {
        const token = ctx.token();
        if (!token) return text("TELEGRAM_BOT_TOKEN not set");
        const reactResult = await setTelegramReaction(
          token,
          String(args!.chat_id),
          Number(args!.message_id),
          String(args!.emoji),
        );
        if (!reactResult.ok) {
          channelLogger.warn({ error: reactResult.errorBody }, "react: Telegram API error");
          return text(`Telegram API error: ${reactResult.errorBody}`);
        }
        return text(`Reaction ${args!.emoji} set on message ${args!.message_id}`);
      }

      case "edit_message": {
        const token = ctx.token();
        if (!token) return text("TELEGRAM_BOT_TOKEN not set");
        const htmlText = markdownToTelegramHtml(String(args!.text));
        // Try HTML first, fall back to plain text if entity parse fails
        const htmlResult = await editTelegramMessage(token, String(args!.chat_id), Number(args!.message_id), htmlText, { parse_mode: "HTML" });
        if (!htmlResult.ok && htmlResult.errorBody?.includes("can't parse entities")) {
          await editTelegramMessage(token, String(args!.chat_id), Number(args!.message_id), String(args!.text));
        } else if (!htmlResult.ok) {
          channelLogger.warn({ error: htmlResult.errorBody }, "edit_message: Telegram API error");
          return text(`Telegram API error: ${htmlResult.errorBody}`);
        }
        return text(`Message ${args!.message_id} updated`);
      }

      case "send_poll": {
        const token = ctx.token();
        if (!token) return text("TELEGRAM_BOT_TOKEN not set");
        if (!sessionId) return text("No active session");

        const chatId = String(args!.chat_id);
        const title = args!.title ? String(args!.title) : null;
        const questions = args!.questions as Array<{ question: string; options: string[] }>;

        if (!questions?.length) return text("No questions provided");

        // Bug 7: Dedup — return existing pending session if Claude retries within 5 minutes
        const existing = await ctx.sql`
          SELECT id FROM poll_sessions
          WHERE session_id = ${sessionId} AND chat_id = ${chatId}
            AND status = 'pending' AND created_at > NOW() - INTERVAL '5 minutes'
          LIMIT 1
        `;
        if (existing.length) return text(`Poll session already active (id=${existing[0].id}). Waiting for user answers.`);

        // Forum mode: resolve thread ID so polls land in the project topic
        const forumChatId = ctx.forumChatId?.();
        let forumTopicId: number | null = null;
        if (forumChatId && chatId === forumChatId) {
          const rows = await ctx.sql`SELECT forum_topic_id FROM projects WHERE path = ${ctx.projectPath}`;
          forumTopicId = rows[0]?.forum_topic_id ?? null;
        }
        const threadExtra = forumTopicId ? { message_thread_id: forumTopicId } : {};

        // Bug 8: Send intro message and store its ID so we can delete it on failure
        let introMessageId: number | null = null;
        if (title) {
          const introRes = await sendTelegramMessage(token, chatId, `📋 <b>${title}</b>`, { parse_mode: "HTML", ...threadExtra });
          introMessageId = introRes.messageId;
        }

        // Send each question as a poll
        const telegramPollIds: string[] = [];
        for (const q of questions) {
          if (!q.options || q.options.length < 2) {
            if (introMessageId) deleteTelegramMessage(token, chatId, introMessageId);
            return text(`Question "${q.question}" must have at least 2 options`);
          }
          const pollRes = await sendTelegramPoll(token, chatId, q.question, q.options, threadExtra);
          if (!pollRes.ok) {
            channelLogger.warn({ error: pollRes.errorBody }, "send_poll: failed to send poll");
            if (introMessageId) deleteTelegramMessage(token, chatId, introMessageId);
            return text(`Failed to send poll: ${pollRes.errorBody}`);
          }
          if (pollRes.pollId) telegramPollIds.push(pollRes.pollId);
        }

        // Bug 1: Validate all polls were created successfully (no null pollIds)
        if (telegramPollIds.length !== questions.length) {
          if (introMessageId) deleteTelegramMessage(token, chatId, introMessageId);
          return text(`Failed to send polls: ${questions.length - telegramPollIds.length} poll(s) returned no ID`);
        }

        // Store poll session in DB
        const [pollSession] = await ctx.sql`
          INSERT INTO poll_sessions (session_id, chat_id, title, questions, telegram_poll_ids)
          VALUES (${sessionId}, ${chatId}, ${title}, ${ctx.sql.json(questions)}, ${ctx.sql.json(telegramPollIds)})
          RETURNING id
        `;

        // Send Submit button (also in the correct thread)
        const submitRes = await sendTelegramMessage(token, chatId, "Ответьте на вопросы выше и нажмите <b>Готово</b>", {
          parse_mode: "HTML",
          reply_markup: JSON.stringify({
            inline_keyboard: [[{ text: "Готово ✅", callback_data: `poll_submit:${pollSession.id}` }]],
          }),
          ...threadExtra,
        });

        // Store submit message ID for later removal
        if (submitRes.messageId) {
          await ctx.sql`UPDATE poll_sessions SET submit_message_id = ${submitRes.messageId} WHERE id = ${pollSession.id}`;
        }

        channelLogger.info({ pollSessionId: pollSession.id, chatId, questionCount: questions.length, forumTopicId }, "poll session created");
        return text(`Poll session created (id=${pollSession.id}). Waiting for user answers.`);
      }

      case "remember": {
        const content = String(args!.content);
        const embedding = await embed(content, ctx.ollamaUrl, ctx.embeddingModel);
        const embeddingStr = `[${embedding.join(",")}]`;
        const [row] = await ctx.sql`
          INSERT INTO memories (source, session_id, project_path, type, content, tags, embedding)
          VALUES ('cli', ${sessionId}, ${ctx.projectPath}, ${String(args!.type ?? "note")}, ${content}, ${(args!.tags as string[]) ?? []}, ${embeddingStr}::vector)
          RETURNING id
        `;
        return text(`Saved memory #${row.id}`);
      }

      case "recall": {
        const queryEmb = await embed(String(args!.query), ctx.ollamaUrl, ctx.embeddingModel);
        const embStr = `[${queryEmb.join(",")}]`;
        const limit = Number(args!.limit ?? 5);
        const rows = await ctx.sql`
          SELECT id, type, content, embedding <=> ${embStr}::vector AS distance
          FROM memories
          WHERE project_path = ${ctx.projectPath} OR project_path IS NULL
          ORDER BY embedding <=> ${embStr}::vector
          LIMIT ${limit}
        `;
        if (rows.length === 0) return text("No relevant memories found.");
        const formatted = rows
          .map((r: any) => `#${r.id} [${r.type}] (${Number(r.distance).toFixed(3)}) ${r.content}`)
          .join("\n\n");
        return text(formatted);
      }

      case "forget": {
        const result = await ctx.sql`DELETE FROM memories WHERE id = ${Number(args!.id)} AND project_path = ${ctx.projectPath} RETURNING id`;
        return text(result.length > 0 ? `Deleted #${args!.id}` : `#${args!.id} not found`);
      }

      case "update_status": {
        const chatId = String(args!.chat_id);
        await status.updateStatus(chatId, String(args!.status));

        if (args!.diff) {
          const fChatId = ctx.forumChatId?.();
          let fTopicId: number | null = null;
          if (fChatId && chatId === fChatId) {
            const rows = await ctx.sql`SELECT forum_topic_id FROM projects WHERE path = ${ctx.projectPath}`;
            fTopicId = rows[0]?.forum_topic_id ?? null;
          }
          const diffExtra = (fChatId && fTopicId && chatId === fChatId)
            ? { message_thread_id: fTopicId }
            : {};
          const htmlDiff = markdownToTelegramHtml(String(args!.diff));
          await status.updateDiff(chatId, htmlDiff, diffExtra);
        }
        return text(`Status updated: ${args!.status}`);
      }

      case "list_memories": {
        const rows = await ctx.sql`
          SELECT id, type, content FROM memories
          WHERE (project_path = ${ctx.projectPath} OR project_path IS NULL)
            ${args!.type ? ctx.sql`AND type = ${String(args!.type)}` : ctx.sql``}
          ORDER BY created_at DESC
          LIMIT ${Number(args!.limit ?? 20)}
        `;
        if (rows.length === 0) return text("No memories found.");
        return text(rows.map((r: any) => `#${r.id} [${r.type}] ${r.content.slice(0, 100)}`).join("\n"));
      }

      case "search_project_context": {
        const query = String(args!.query ?? "");
        if (!query) return text("query is required");
        const searchPath = String(args!.project_path ?? ctx.projectPath ?? "");
        if (!searchPath) return text("no project_path available — pass it explicitly");
        const limit = Math.min(Number(args!.limit ?? 5), 20);
        const queryEmb = await embed(query, ctx.ollamaUrl, ctx.embeddingModel);
        const embStr = `[${queryEmb.join(",")}]`;
        const rows = await ctx.sql`
          SELECT content, type, created_at,
                 1 - (embedding <=> ${embStr}::vector) AS score
          FROM memories
          WHERE project_path = ${searchPath}
            AND type IN ('project_context', 'summary')
            AND embedding IS NOT NULL
          ORDER BY embedding <=> ${embStr}::vector
          LIMIT ${limit}
        `;
        channelLogger.info({ queryPrefix: query.slice(0, 50), project: searchPath, resultCount: rows.length }, "search_project_context");
        if (rows.length === 0) return text("No project context found.");
        return text(JSON.stringify({
          results: rows.map((r: any) => ({
            content: r.content as string,
            type: r.type as string,
            score: Number(r.score).toFixed(3),
            date: (r.created_at as Date).toISOString(),
          })),
        }, null, 2));
      }

      case "scan_project_knowledge": {
        const scanPath = String(args!.project_path ?? ctx.projectPath ?? "");
        if (!scanPath) return text("No project_path available — pass it explicitly");

        const resolvedScanPath = resolve(scanPath);
        const allowedRoot = process.env.HOST_PROJECTS_DIR
          ?? process.env.HOME
          ?? "/home";
        const currentProject = ctx.projectPath ?? "";

        if (
          !resolvedScanPath.startsWith(allowedRoot) &&
          (currentProject === "" || !resolvedScanPath.startsWith(resolve(currentProject)))
        ) {
          return text(`scan_project_knowledge: path must be within ${allowedRoot}`);
        }

        const forceRescan = Boolean(args!.force_rescan ?? false);
        const count = await scanProjectKnowledge(resolvedScanPath, forceRescan);
        return text(`Scanned ${resolvedScanPath}: ${count} knowledge facts saved`);
      }

      default:
        return text(`Unknown tool: ${name}`);
    }
  });
}
