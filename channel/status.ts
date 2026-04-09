/**
 * StatusManager — Telegram status messages + typing indicators + progress monitor.
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
}

interface StatusState {
  chatId: string;
  messageId: number;
  startedAt: number;
  stage: string;
  timer: ReturnType<typeof setInterval> | null;
}

interface SessionStats {
  filesEdited: Set<string>;
  linesAdded: number;
  linesRemoved: number;
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

function formatStatusText(stage: string, elapsed: string, tokens: string): string {
  const normalized = normalizeStage(stage);
  const header = `⏳ <i>${elapsed}${tokens}</i>`;
  if (normalized.includes("\n")) {
    return `${header}\n<pre>${escapeHtml(normalized)}</pre>`;
  }
  return `${header}  ${escapeHtml(normalized)}`;
}

export class StatusManager {
  private activeStatus = new Map<string, StatusState>();
  private lastTokenInfo = new Map<string, string>();
  private sessionStats = new Map<string, SessionStats>();
  private activeTyping = new Map<string, TypingHandle>();
  private activeMonitors = new Map<string, TmuxMonitorHandle | OutputMonitorHandle>();
  private readonly TYPING_TIMEOUT_MS = 30_000;

  constructor(private ctx: StatusContext) {}

  private async getSessionPrefix(chatId: string): Promise<string> {
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

    const prefix = await this.getSessionPrefix(chatId);
    const existing = this.activeStatus.get(chatId);

    if (existing) {
      existing.stage = `${prefix}${stage}`;
      await this.editStatusMessage(existing);
      return null;
    }

    try {
      const initialText = formatStatusText(`${prefix}${stage}`, "0s", "");
      const result = await sendTelegramMessage(token, chatId, initialText, { parse_mode: "HTML" });
      if (!result.ok) {
        channelLogger.warn({ error: result.errorBody }, "sendStatusMessage failed");
        return `Telegram API error`;
      }

      const state: StatusState = {
        chatId,
        messageId: result.messageId!,
        startedAt: Date.now(),
        stage: `${prefix}${stage}`,
        timer: null,
      };
      state.timer = setInterval(() => this.editStatusMessage(state), 5000);
      this.activeStatus.set(chatId, state);
      channelLogger.info({ chatId, messageId: state.messageId }, "status message created");
      return null;
    } catch (e) {
      channelLogger.error({ err: e }, "sendStatusMessage exception");
      return `Exception: ${e}`;
    }
  }

  async updateStatus(chatId: string, stage: string): Promise<void> {
    this.accumulateStats(chatId, stage);
    const state = this.activeStatus.get(chatId);
    if (!state) {
      await this.sendStatusMessage(chatId, stage);
      return;
    }
    state.stage = stage;
    await this.editStatusMessage(state);
  }

  private accumulateStats(chatId: string, stage: string): void {
    let stats = this.sessionStats.get(chatId);
    if (!stats) {
      stats = { filesEdited: new Set(), linesAdded: 0, linesRemoved: 0 };
      this.sessionStats.set(chatId, stats);
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
    const tokens = this.lastTokenInfo.get(state.chatId);
    const tokenStr = tokens ? ` · ↓ ${tokens}` : "";
    const text = formatStatusText(state.stage, elapsed, tokenStr);
    await editTelegramMessage(token, state.chatId, state.messageId, text, { parse_mode: "HTML" });
  }

  async deleteStatusMessage(chatId: string): Promise<void> {
    const state = this.activeStatus.get(chatId);
    if (!state) return;
    if (state.timer) clearInterval(state.timer);
    this.activeStatus.delete(chatId);
    this.stopTypingForChat(chatId);

    const token = this.ctx.token();
    if (!token) return;

    const elapsed = formatElapsed(Date.now() - state.startedAt);
    const tokens = this.lastTokenInfo.get(chatId);
    const stats = this.sessionStats.get(chatId);
    this.lastTokenInfo.delete(chatId);
    this.sessionStats.delete(chatId);

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
    const editRes = await editTelegramMessage(token, chatId, state.messageId, summaryText, { parse_mode: "HTML" });
    if (!editRes.ok) {
      deleteTelegramMessage(token, chatId, state.messageId);
    }
  }

  startTypingForChat(chatId: string): void {
    if (this.activeTyping.has(chatId)) return;
    const token = this.ctx.token();
    if (!token) return;
    const handle = startTypingRaw(token, chatId);
    this.activeTyping.set(chatId, handle);
    setTimeout(() => this.stopTypingForChat(chatId), this.TYPING_TIMEOUT_MS);
  }

  stopTypingForChat(chatId: string): void {
    const handle = this.activeTyping.get(chatId);
    if (handle) {
      handle.stop();
      this.activeTyping.delete(chatId);
    }
  }

  async startProgressMonitorForChat(chatId: string): Promise<void> {
    this.stopProgressMonitorForChat(chatId);
    const onStatus = (status: string) => {
      const tokenMatch = status.match(/↓\s*([\d.]+[kmKM]?\s*tokens)/i);
      if (tokenMatch) this.lastTokenInfo.set(chatId, tokenMatch[1].trim());
      this.updateStatus(chatId, status);
    };

    let monitor = await startTmuxMonitor(this.ctx.projectName, onStatus);
    if (monitor) {
      this.activeMonitors.set(chatId, monitor);
      channelLogger.info({ project: this.ctx.projectName }, "tmux monitor started");
      return;
    }
    channelLogger.debug({ project: this.ctx.projectName }, "tmux monitor not found, trying output file");

    const outputFile = getOutputFilePath(this.ctx.projectName);
    monitor = await startOutputMonitor(outputFile, onStatus);
    if (monitor) {
      this.activeMonitors.set(chatId, monitor);
      channelLogger.info({ outputFile }, "output monitor started");
    } else {
      channelLogger.debug({ project: this.ctx.projectName, outputFile }, "no monitor available — status will only show elapsed time");
    }
  }

  stopProgressMonitorForChat(chatId: string): void {
    const monitor = this.activeMonitors.get(chatId);
    if (monitor) {
      monitor.stop();
      this.activeMonitors.delete(chatId);
    }
  }
}
