/**
 * StatusManager — Telegram status messages + typing indicators + progress monitor.
 *
 * Forum mode: when forumChatId() and forumTopicId() are both set, all status
 * messages are sent to that topic instead of the DM chat.
 * The project name prefix is suppressed in forum mode (FR-10) because the
 * topic itself already identifies the project.
 */

import type postgres from "postgres";
import { startTypingRaw, type TypingHandle } from "../utils/typing.ts";
import { startTmuxMonitor, type TmuxMonitorHandle } from "../utils/tmux-monitor.ts";
import { startOutputMonitor, getOutputFilePath, type OutputMonitorHandle } from "../utils/output-monitor.ts";
import { editTelegramMessage, deleteTelegramMessage, sendTelegramMessage } from "./telegram.ts";
import { channelLogger } from "../logger.ts";

export interface StatusContext {
  sql: postgres.Sql;
  sessionId: () => number | null;
  sessionName: () => string;
  projectName: string;
  token: () => string | undefined;
  /** Forum supergroup chat ID. When set together with forumTopicId, status goes to the topic. */
  forumChatId?: () => string | null;
  /** Forum topic (thread) ID for this project session. */
  forumTopicId?: () => number | null;
}

interface StatusState {
  chatId: string;
  threadId?: number;
  messageId: number;
  startedAt: number;
  stage: string;
  timer: ReturnType<typeof setInterval> | null;
  dbHeartbeatTimer: ReturnType<typeof setInterval> | null;
}

interface SessionStats {
  filesEdited: Set<string>;
  linesAdded: number;
  linesRemoved: number;
}

/** Parse "2.5k tokens", "15234 tokens", "1.2M tokens" → integer token count */
function parseTokenCount(s: string): number | null {
  const m = s.match(/^([\d,.]+)([kmKM]?)\s*tokens?$/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  const suffix = m[2].toLowerCase();
  if (suffix === "k") return Math.round(n * 1_000);
  if (suffix === "m") return Math.round(n * 1_000_000);
  return Math.round(n);
}

function formatElapsed(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalizeStage(stage: string): string {
  return stage.replace(/^⏳\s*/, "");
}

const STATUS_VISIBLE_LINES = 10;
const STATUS_MAX_LINES = 40;

function formatStatusText(stage: string, elapsed: string, tokens: string): string {
  const normalized = normalizeStage(stage);
  const header = `⏳ <i>${elapsed}${tokens}</i>`;
  if (normalized.includes("\n")) {
    const lines = normalized.split("\n").slice(0, STATUS_MAX_LINES);
    const visible = lines.slice(0, STATUS_VISIBLE_LINES);
    const hidden = lines.slice(STATUS_VISIBLE_LINES);

    let body = `<pre>${escapeHtml(visible.join("\n"))}</pre>`;
    if (hidden.length > 0) {
      body += `<tg-spoiler><pre>${escapeHtml(hidden.join("\n"))}</pre></tg-spoiler>`;
    }
    return `${header}\n${body}`;
  }
  return `${header}  ${escapeHtml(normalized)}`;
}

export class StatusManager {
  private activeStatus = new Map<string, StatusState>();
  private lastTokenInfo = new Map<string, string>();
  private sessionStats = new Map<string, SessionStats>();
  private activeTyping = new Map<string, TypingHandle>();
  private activeMonitors = new Map<string, TmuxMonitorHandle | OutputMonitorHandle>();
  private responseGuards = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly TYPING_TIMEOUT_MS = 30_000;
  private readonly RESPONSE_GUARD_MS = 5 * 60_000; // 5 min

  constructor(private ctx: StatusContext) {}

  /**
   * Arm a response guard for a chat. If Claude doesn't call `reply` within
   * RESPONSE_GUARD_MS, sends a fallback "no response" message to the user.
   * Automatically disarmed when deleteStatusMessage is called.
   */
  armResponseGuard(chatId: string): void {
    const key = this.stateKey(chatId);
    const existing = this.responseGuards.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.responseGuards.delete(key);
      const state = this.activeStatus.get(key);
      if (!state) return; // already responded

      channelLogger.warn({ chatId }, "response guard: no reply from Claude, sending fallback");
      await this.deleteStatusMessage(chatId);

      const token = this.ctx.token();
      if (!token) return;
      const forum = this.getForumTarget();
      const effectiveChatId = forum?.chatId ?? chatId;
      const extra = forum?.extra ?? {};
      await sendTelegramMessage(
        token,
        effectiveChatId,
        "⚠️ Claude не ответил — сессия могла упасть или зависнуть.\n/session — статус сессии",
        extra,
      );
    }, this.RESPONSE_GUARD_MS);

    this.responseGuards.set(key, timer);
  }

  private disarmResponseGuard(chatId: string): void {
    const key = this.stateKey(chatId);
    const timer = this.responseGuards.get(key);
    if (timer) {
      clearTimeout(timer);
      this.responseGuards.delete(key);
    }
  }

  /**
   * Resolve the effective Telegram destination for status messages.
   *
   * In forum mode (forumChatId + forumTopicId both set): returns the forum chat
   * and adds message_thread_id to the extras.
   * In DM mode: returns the passed chatId with no extras.
   */
  private getForumTarget(): { chatId: string; threadId: number; extra: Record<string, unknown> } | null {
    const chatId = this.ctx.forumChatId?.();
    const topicId = this.ctx.forumTopicId?.();
    if (chatId && topicId) {
      return { chatId, threadId: topicId, extra: { message_thread_id: topicId } };
    }
    return null;
  }

  /** Map key for the activeStatus / stats maps. */
  private stateKey(chatId: string): string {
    const forum = this.getForumTarget();
    return forum ? `${forum.chatId}:${forum.threadId}` : chatId;
  }

  private async getSessionPrefix(chatId: string): Promise<string> {
    // In forum mode the topic already identifies the project — no prefix needed (FR-10)
    if (this.getForumTarget()) return "";

    const sessionId = this.ctx.sessionId();
    if (!sessionId) return "";
    const activeCheck = await this.ctx.sql`
      SELECT active_session_id FROM chat_sessions WHERE chat_id = ${chatId}
    `;
    const isActive = activeCheck.length === 0 || activeCheck[0].active_session_id === sessionId;
    return isActive ? "" : `📌 ${this.ctx.sessionName()} · `;
  }

  async sendStatusMessage(chatId: string, stage: string): Promise<string | null> {
    const token = this.ctx.token();
    if (!token) {
      channelLogger.warn("sendStatusMessage: no TELEGRAM_BOT_TOKEN");
      return "no TELEGRAM_BOT_TOKEN";
    }

    const forum = this.getForumTarget();
    const effectiveChatId = forum?.chatId ?? chatId;
    const key = this.stateKey(chatId);

    const prefix = await this.getSessionPrefix(chatId);
    const existing = this.activeStatus.get(key);

    if (existing) {
      existing.stage = `${prefix}${stage}`;
      await this.editStatusMessage(existing);
      return null;
    }

    try {
      const initialText = formatStatusText(`${prefix}${stage}`, "0s", "");
      const extra: Record<string, unknown> = { parse_mode: "HTML", ...(forum?.extra ?? {}) };
      const result = await sendTelegramMessage(token, effectiveChatId, initialText, extra);
      if (!result.ok) {
        channelLogger.warn({ error: result.errorBody }, "sendStatusMessage failed");
        return `Telegram API error`;
      }

      const state: StatusState = {
        chatId: effectiveChatId,
        threadId: forum?.threadId,
        messageId: result.messageId!,
        startedAt: Date.now(),
        stage: `${prefix}${stage}`,
        timer: null,
        dbHeartbeatTimer: null,
      };
      state.timer = setInterval(() => this.editStatusMessage(state), 5000);
      state.dbHeartbeatTimer = setInterval(() => this.heartbeatStatusMessage(key), 30_000);
      this.activeStatus.set(key, state);
      this.persistStatusMessage(key, state).catch(() => {});
      channelLogger.info({ chatId: effectiveChatId, messageId: state.messageId }, "status message created");
      return null;
    } catch (e) {
      channelLogger.error({ err: e }, "sendStatusMessage exception");
      return `Exception: ${e}`;
    }
  }

  async updateStatus(chatId: string, stage: string): Promise<void> {
    const key = this.stateKey(chatId);
    this.accumulateStats(key, stage);
    const state = this.activeStatus.get(key);
    if (!state) {
      await this.sendStatusMessage(chatId, stage);
      return;
    }
    state.stage = stage;
    await this.editStatusMessage(state);
  }

  private accumulateStats(key: string, stage: string): void {
    let stats = this.sessionStats.get(key);
    if (!stats) {
      stats = { filesEdited: new Set(), linesAdded: 0, linesRemoved: 0 };
      this.sessionStats.set(key, stats);
    }
    // Track file edits from status updates (e.g. "Editing: status.ts" or "● Edit: file.ts")
    const editMatch = stage.match(/(?:Editing|● (?:Edit|Write)):\s*([^\s\n]+)/);
    if (editMatch) stats.filesEdited.add(editMatch[1]);
    // Accumulate line changes from tmux output: "  └ Added N lines, removed N lines"
    const linesMatch = stage.match(/Added (\d+) lines?,\s*removed (\d+) lines?/);
    if (linesMatch) {
      stats.linesAdded += parseInt(linesMatch[1]);
      stats.linesRemoved += parseInt(linesMatch[2]);
    }
    // Also handle "Added N lines" without removed (new file)
    const addedOnly = stage.match(/Added (\d+) lines?(?!.*removed)/);
    if (addedOnly && !linesMatch) stats.linesAdded += parseInt(addedOnly[1]);
  }

  private async editStatusMessage(state: StatusState): Promise<void> {
    const token = this.ctx.token();
    if (!token) return;
    const elapsed = formatElapsed(Date.now() - state.startedAt);
    const key = state.threadId ? `${state.chatId}:${state.threadId}` : state.chatId;
    const tokens = this.lastTokenInfo.get(key);
    const tokenStr = tokens ? ` · ↓ ${tokens}` : "";
    const text = formatStatusText(state.stage, elapsed, tokenStr);
    await editTelegramMessage(token, state.chatId, state.messageId, text, { parse_mode: "HTML" });
  }

  async deleteStatusMessage(chatId: string): Promise<void> {
    this.disarmResponseGuard(chatId); // reply received — cancel fallback
    const key = this.stateKey(chatId);
    const state = this.activeStatus.get(key);
    if (!state) return;
    if (state.timer) clearInterval(state.timer);
    if (state.dbHeartbeatTimer) clearInterval(state.dbHeartbeatTimer);
    this.activeStatus.delete(key);
    this.ctx.sql`DELETE FROM active_status_messages WHERE key = ${key}`.catch(() => {});
    this.stopTypingForChat(chatId);

    const token = this.ctx.token();
    if (!token) return;

    const elapsed = formatElapsed(Date.now() - state.startedAt);
    const tokens = this.lastTokenInfo.get(key);
    const stats = this.sessionStats.get(key);
    this.lastTokenInfo.delete(key);
    this.sessionStats.delete(key);

    const parts: string[] = [`⏱ ${elapsed}`];
    if (stats?.filesEdited.size) {
      const fileStr = stats.filesEdited.size === 1
        ? [...stats.filesEdited][0]
        : `${stats.filesEdited.size} files`;
      const diffStr = (stats.linesAdded || stats.linesRemoved)
        ? ` <code>+${stats.linesAdded}/-${stats.linesRemoved}</code>`
        : "";
      parts.push(`📝 ${fileStr}${diffStr}`);
    }
    if (tokens) parts.push(`↓ ${tokens}`);

    const summaryText = `✅ ${parts.join(" · ")}`;
    const editRes = await editTelegramMessage(token, state.chatId, state.messageId, summaryText, { parse_mode: "HTML" });
    if (!editRes.ok) {
      deleteTelegramMessage(token, state.chatId, state.messageId);
    }

    // Record Claude Code token usage to api_request_stats (best-effort, non-blocking)
    if (tokens) {
      this.recordCliUsage(chatId, tokens, Date.now() - state.startedAt).catch(() => {});
    }
  }

  /** INSERT or UPDATE the DB record for an active status message. */
  private async persistStatusMessage(key: string, state: StatusState): Promise<void> {
    const sessionId = this.ctx.sessionId();
    try {
      await this.ctx.sql`
        INSERT INTO active_status_messages
          (key, chat_id, thread_id, message_id, started_at, updated_at, project_name, session_id)
        VALUES
          (${key}, ${state.chatId}, ${state.threadId ?? null}, ${state.messageId},
           NOW(), NOW(), ${this.ctx.projectName}, ${sessionId})
        ON CONFLICT (key) DO UPDATE SET
          message_id = EXCLUDED.message_id,
          updated_at = NOW()
      `;
    } catch (err) {
      channelLogger.warn({ err }, "persistStatusMessage: DB error");
    }
  }

  /** Touch updated_at so the recovery watchdog knows this channel is alive. */
  private async heartbeatStatusMessage(key: string): Promise<void> {
    try {
      await this.ctx.sql`
        UPDATE active_status_messages SET updated_at = NOW() WHERE key = ${key}
      `;
    } catch (err) {
      channelLogger.warn({ err }, "heartbeatStatusMessage: DB error");
    }
  }

  startTypingForChat(chatId: string): void {
    const key = this.stateKey(chatId);
    if (this.activeTyping.has(key)) return;
    const token = this.ctx.token();
    if (!token) return;
    const forum = this.getForumTarget();
    const effectiveChatId = forum?.chatId ?? chatId;
    const handle = startTypingRaw(token, effectiveChatId);
    this.activeTyping.set(key, handle);
    setTimeout(() => this.stopTypingForChat(chatId), this.TYPING_TIMEOUT_MS);
  }

  stopTypingForChat(chatId: string): void {
    const key = this.stateKey(chatId);
    const handle = this.activeTyping.get(key);
    if (handle) {
      handle.stop();
      this.activeTyping.delete(key);
    }
  }

  async startProgressMonitorForChat(chatId: string): Promise<void> {
    this.stopProgressMonitorForChat(chatId);
    const key = this.stateKey(chatId);
    const onStatus = (status: string) => {
      const tokenMatch = status.match(/↓\s*([\d.]+[kmKM]?\s*tokens)/i);
      if (tokenMatch) this.lastTokenInfo.set(key, tokenMatch[1].trim());
      this.updateStatus(chatId, status);
    };

    let monitor = await startTmuxMonitor(this.ctx.projectName, onStatus);
    if (monitor) {
      this.activeMonitors.set(key, monitor);
      channelLogger.info({ project: this.ctx.projectName }, "tmux monitor started");
      return;
    }
    channelLogger.debug({ project: this.ctx.projectName }, "tmux monitor not found, trying output file");

    const outputFile = getOutputFilePath(this.ctx.projectName);
    monitor = await startOutputMonitor(outputFile, onStatus);
    if (monitor) {
      this.activeMonitors.set(key, monitor);
      channelLogger.info({ outputFile }, "output monitor started");
    } else {
      channelLogger.debug({ project: this.ctx.projectName, outputFile }, "no monitor available — status will only show elapsed time");
    }
  }

  stopProgressMonitorForChat(chatId: string): void {
    const key = this.stateKey(chatId);
    const monitor = this.activeMonitors.get(key);
    if (monitor) {
      monitor.stop();
      this.activeMonitors.delete(key);
    }
  }

  /** Record CLI session token usage to api_request_stats after each completed response. */
  private async recordCliUsage(chatId: string, tokenStr: string, durationMs: number): Promise<void> {
    const totalTokens = parseTokenCount(tokenStr);
    if (!totalTokens || totalTokens <= 0) return;

    const sessionId = this.ctx.sessionId();
    if (!sessionId || sessionId < 0) return;

    try {
      // Look up the model from session's cli_config; fall back to sonnet default
      const rows = await this.ctx.sql`SELECT cli_config FROM sessions WHERE id = ${sessionId}`;
      const cliConfig = rows[0]?.cli_config ?? {};
      const model: string = cliConfig.model ?? "claude-sonnet-4-20250514";

      await this.ctx.sql`
        INSERT INTO api_request_stats
          (session_id, chat_id, provider, model, operation, duration_ms, status, total_tokens)
        VALUES
          (${sessionId}, ${chatId}, 'anthropic', ${model}, 'cli', ${durationMs}, 'success', ${totalTokens})
      `;
      channelLogger.debug({ sessionId, model, totalTokens, durationMs }, "cli usage recorded");
    } catch (err) {
      channelLogger.warn({ err }, "failed to record cli usage stats");
    }
  }
}
