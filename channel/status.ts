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
import { escapeHtml } from "../utils/html.ts";

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
  paneSnapshot: string | null;
  paneSnapshotAt: number | null;
  timer: ReturnType<typeof setInterval> | null;
  paneTimer: ReturnType<typeof setInterval> | null;
  dbHeartbeatTimer: ReturnType<typeof setInterval> | null;
  spinnerFrame: number;
  lastUpdateAt: number;
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


function normalizeStage(stage: string): string {
  return stage.replace(/^⏳\s*/, "");
}

const STATUS_VISIBLE_LINES = 10;
const STATUS_MAX_LINES = 40;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_STALE_MS = 60_000;

function getSpinnerIcon(spinnerFrame: number, lastUpdateAt: number): string {
  if (Date.now() - lastUpdateAt > SPINNER_STALE_MS) return "⚠️";
  return SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
}

function formatStatusText(stage: string, elapsed: string, tokens: string, paneSnapshot?: string | null, spinnerIcon?: string): string {
  const normalized = normalizeStage(stage);
  const icon = spinnerIcon ?? SPINNER_FRAMES[0];
  const header = `${icon} <i>${elapsed}${tokens}</i>`;

  let stageBody: string;
  if (normalized.includes("\n")) {
    const lines = normalized.split("\n").slice(0, STATUS_MAX_LINES);
    const visible = lines.slice(0, STATUS_VISIBLE_LINES);
    const hidden = lines.slice(STATUS_VISIBLE_LINES);
    stageBody = `<blockquote>${escapeHtml(visible.join("\n"))}</blockquote>`;
    if (hidden.length > 0) {
      stageBody += `<blockquote><tg-spoiler>${escapeHtml(hidden.join("\n"))}</tg-spoiler></blockquote>`;
    }
  } else {
    stageBody = `  ${escapeHtml(normalized)}`;
  }

  // Append live pane snapshot as a spoiler section if available
  if (paneSnapshot && paneSnapshot.trim()) {
    const paneLines = paneSnapshot.trim().split("\n").slice(-6);
    const paneText = escapeHtml(paneLines.join("\n"));
    return `${header}\n${stageBody}\n<blockquote><tg-spoiler>🖥 ${paneText}</tg-spoiler></blockquote>`;
  }

  return normalized.includes("\n") ? `${header}\n${stageBody}` : `${header}${stageBody}`;
}

export class StatusManager {
  private activeStatus = new Map<string, StatusState>();
  private lastTokenInfo = new Map<string, string>();
  private sessionStats = new Map<string, SessionStats>();
  private activeTyping = new Map<string, TypingHandle>();
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
        "⏳ Claude ещё не ответил (5+ мин) — возможно думает над задачей или сессия зависла.\n/session — статус сессии",
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
   * Reset the response guard if it is currently armed.
   * Called on each status update — if Claude is producing tmux activity or
   * explicitly calling update_status, it is alive and the guard should not fire.
   * Guard only fires when there has been no observable activity for RESPONSE_GUARD_MS.
   */
  private resetResponseGuard(chatId: string): void {
    const key = this.stateKey(chatId);
    if (!this.responseGuards.has(key)) return; // not armed — nothing to reset
    this.armResponseGuard(chatId); // rearm with a fresh timeout
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
    // If forum is configured but topic ID is unknown, skip status — avoid leaking to General
    if (this.ctx.forumChatId?.() && !forum) {
      return null;
    }
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
      const t0 = Date.now();
      const initialText = formatStatusText(`${prefix}${stage}`, "0s", "", null, SPINNER_FRAMES[0]);
      const extra: Record<string, unknown> = { parse_mode: "HTML", ...(forum?.extra ?? {}) };
      const result = await sendTelegramMessage(token, effectiveChatId, initialText, extra);
      const tgRtt = Date.now() - t0;
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
        paneSnapshot: null,
        paneSnapshotAt: null,
        timer: null,
        paneTimer: null,
        dbHeartbeatTimer: null,
        spinnerFrame: 0,
        lastUpdateAt: Date.now(),
      };
      state.timer = setInterval(() => this.editStatusMessage(state), 1000);
      state.paneTimer = setInterval(() => this.refreshPaneSnapshot(state).catch(() => {}), 10_000);
      state.dbHeartbeatTimer = setInterval(() => this.heartbeatStatusMessage(key), 30_000);
      this.activeStatus.set(key, state);
      this.persistStatusMessage(key, state).catch(() => {});
      channelLogger.info({ phase: "status", step: "created", chatId: effectiveChatId, messageId: state.messageId, tgRttMs: tgRtt }, "perf");
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
      // No active status — poller always creates one before sending the notification,
      // so this can only happen in a race (in-flight callback after deleteStatusMessage).
      // Do NOT create a new orphan message here.
      return;
    }
    // Activity observed — Claude is alive, reset the response guard so it does not
    // fire prematurely during legitimate long-running tasks.
    this.resetResponseGuard(chatId);
    state.lastUpdateAt = Date.now();
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
    state.spinnerFrame = (state.spinnerFrame + 1) % SPINNER_FRAMES.length;
    const spinnerIcon = getSpinnerIcon(state.spinnerFrame, state.lastUpdateAt);
    const elapsed = formatElapsed(Date.now() - state.startedAt);
    const key = state.threadId ? `${state.chatId}:${state.threadId}` : state.chatId;
    const tokens = this.lastTokenInfo.get(key);
    const tokenStr = tokens ? ` · ↓ ${tokens}` : "";
    const text = formatStatusText(state.stage, elapsed, tokenStr, state.paneSnapshot, spinnerIcon);
    const res = await editTelegramMessage(token, state.chatId, state.messageId, text, { parse_mode: "HTML" });
    if (!res.ok && !res.errorBody?.includes("message is not modified")) {
      channelLogger.warn({ error: res.errorBody, messageId: state.messageId }, "editStatusMessage failed");
    }
  }

  private async refreshPaneSnapshot(state: StatusState): Promise<void> {
    const sessionId = this.ctx.sessionId();
    if (!sessionId) return;
    const rows = await this.ctx.sql`
      SELECT pane_snapshot, pane_snapshot_at FROM sessions WHERE id = ${sessionId}
    `.catch(() => []);
    if (!rows[0]) return;
    const { pane_snapshot, pane_snapshot_at } = rows[0] as { pane_snapshot: string | null; pane_snapshot_at: Date | null };
    // Only show snapshot if it's fresh (< 30s old)
    const fresh = pane_snapshot_at && (Date.now() - new Date(pane_snapshot_at).getTime()) < 30_000;
    state.paneSnapshot = fresh ? pane_snapshot : null;
    state.paneSnapshotAt = pane_snapshot_at ? new Date(pane_snapshot_at).getTime() : null;
  }

  async deleteStatusMessage(chatId: string): Promise<void> {
    this.disarmResponseGuard(chatId); // reply received — cancel fallback
    const key = this.stateKey(chatId);
    const state = this.activeStatus.get(key);
    const tDelete = Date.now();
    if (!state) {
      channelLogger.debug({ phase: "status", step: "delete-no-state", chatId }, "perf");
      return;
    }
    const statusLifeMs = tDelete - state.startedAt;
    channelLogger.info({ phase: "status", step: "deleting", chatId, statusLifeMs, messageId: state.messageId }, "perf");
    if (state.timer) clearInterval(state.timer);
    if (state.paneTimer) clearInterval(state.paneTimer);
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
    const existing = this.typingTimers.get(key);
    if (existing) clearTimeout(existing);
    this.typingTimers.set(key, setTimeout(() => this.stopTypingForChat(chatId), this.TYPING_TIMEOUT_MS));
  }

  stopTypingForChat(chatId: string): void {
    const key = this.stateKey(chatId);
    const t = this.typingTimers.get(key);
    if (t) { clearTimeout(t); this.typingTimers.delete(key); }
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
