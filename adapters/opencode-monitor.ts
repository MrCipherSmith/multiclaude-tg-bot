/**
 * OpencodeMonitor — persistent SSE listener per opencode session.
 *
 * Keeps a long-lived SSE connection to opencode serve and forwards
 * ALL assistant responses to Telegram — whether they originate from
 * the TUI or from a Telegram message.
 *
 * Usage:
 *   opencodeMonitor.setBot(bot);
 *   await opencodeMonitor.startAll();        // on bot startup
 *   await opencodeMonitor.start(sessionId);  // when new session activates
 *   opencodeMonitor.stop(sessionId);         // when session disconnects
 *
 * Telegram-originated messages:
 *   handleText calls opencodeMonitor.setPending(sessionId, chatId, messageId)
 *   before sending to opencode. Monitor edits that message with the response.
 *
 * TUI-originated messages:
 *   No pending message — monitor sends a new message to the last active chat.
 */

import type { Bot } from "grammy";
import { sql } from "../memory/db.ts";
import { normalizeCLIConfig } from "./opencode.ts";

const EDIT_INTERVAL_MS = 1500;
const RECONNECT_DELAY_MS = 5_000;
const DEFAULT_PORT = 4096;

interface PendingMessage {
  chatId: string;
  messageId: number;
}

interface ResponseState {
  assistantMessageIds: Set<string>;
  partTexts: Map<string, string>;
  accumulated: string;
  sentMsgId: number | undefined;
  targetChatId: string | undefined;
  lastEdit: number;
}

class OpencodeMonitor {
  private bot: Bot | null = null;
  private controllers = new Map<number, AbortController>();
  private pending = new Map<number, PendingMessage>(); // sessionId → pending Telegram message
  // Response state survives SSE reconnects (mid-response disconnect)
  private responseState = new Map<number, ResponseState>();

  setBot(bot: Bot) {
    this.bot = bot;
  }

  /** Called by handleText before sending to opencode — so monitor edits this message */
  setPending(sessionId: number, chatId: string, messageId: number) {
    this.pending.set(sessionId, { chatId, messageId });
  }

  /** Called by handleText if send fails — clears the pending entry and returns it for cleanup */
  clearPending(sessionId: number): PendingMessage | undefined {
    const pend = this.pending.get(sessionId);
    this.pending.delete(sessionId);
    return pend;
  }

  /** Start monitoring all active opencode sessions */
  async startAll() {
    const rows = await sql`
      SELECT id FROM sessions WHERE cli_type = 'opencode' AND status = 'active' AND id != 0
    `;
    for (const row of rows) {
      this.start(row.id);
    }
  }

  /** Start persistent SSE monitor for a session */
  start(sessionId: number) {
    if (this.controllers.has(sessionId)) return;
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    this._runLoop(sessionId, controller.signal);
    console.log(`[opencode-monitor] started for session #${sessionId}`);
  }

  /** Stop monitoring a session */
  stop(sessionId: number) {
    this.controllers.get(sessionId)?.abort();
    this.controllers.delete(sessionId);
    this.pending.delete(sessionId);
    this.responseState.delete(sessionId);
    console.log(`[opencode-monitor] stopped for session #${sessionId}`);
  }

  private async _runLoop(sessionId: number, signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await this._connectAndListen(sessionId, signal);
      } catch (err: any) {
        if (signal.aborted) break;
        console.warn(`[opencode-monitor] session #${sessionId} disconnected:`, err?.message);
      }
      if (signal.aborted) break;
      await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS));
    }
  }

  private async _connectAndListen(sessionId: number, signal: AbortSignal) {
    const rows = await sql`SELECT cli_config FROM sessions WHERE id = ${sessionId}`;
    if (!rows[0]) return;

    const config = normalizeCLIConfig(rows[0].cli_config);
    const port = Number(config.port ?? DEFAULT_PORT);
    const opencodeSessionId = config.opencodeSessionId as string | undefined;
    const host = process.env.OPENCODE_HOST ?? "localhost";
    const url = `http://${host}:${port}/event`;

    const res = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok) throw new Error(`SSE ${res.status}`);

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No body");

    const decoder = new TextDecoder();
    let buffer = "";

    // Use class-level state so partial responses survive reconnects
    if (!this.responseState.has(sessionId)) {
      this.responseState.set(sessionId, {
        assistantMessageIds: new Set(),
        partTexts: new Map(),
        accumulated: "",
        sentMsgId: undefined,
        targetChatId: undefined,
        lastEdit: 0,
      });
    }
    const state = this.responseState.get(sessionId)!;

    const resetResponse = () => {
      state.assistantMessageIds = new Set();
      state.partTexts = new Map();
      state.accumulated = "";
      state.sentMsgId = undefined;
      state.targetChatId = undefined;
      state.lastEdit = 0;
    };

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || signal.aborted) continue;

        let event: Record<string, any>;
        try { event = JSON.parse(data); } catch { continue; }

        const props = event.properties ?? {};
        const evSessionId = props.sessionID;

        // Filter to our opencode session
        if (opencodeSessionId && evSessionId && evSessionId !== opencodeSessionId) continue;

        if (event.type === "message.updated") {
          if (props.info?.role === "assistant" && props.info?.id) {
            state.assistantMessageIds.add(props.info.id);
          }
        } else if (event.type === "message.part.updated") {
          const part = props.part ?? {};
          if (part.type === "text" && state.assistantMessageIds.has(part.messageID)) {
            const fullText: string = part.text ?? "";
            const prev = state.partTexts.get(part.id) ?? "";
            const delta = fullText.slice(prev.length);
            if (delta && this.bot) {
              state.partTexts.set(part.id, fullText);
              state.accumulated += delta;

              // Resolve target chat on first chunk
              if (!state.targetChatId) {
                const pend = this.pending.get(sessionId);
                if (pend) {
                  state.targetChatId = pend.chatId;
                  state.sentMsgId = pend.messageId;
                  this.pending.delete(sessionId);
                } else {
                  state.targetChatId = await this._getLastChatId(sessionId);
                }
              }

              if (state.targetChatId) {
                const now = Date.now();
                if (!state.sentMsgId) {
                  try {
                    const msg = await this.bot.api.sendMessage(Number(state.targetChatId), state.accumulated);
                    state.sentMsgId = msg.message_id;
                    state.lastEdit = Date.now();
                  } catch { /* ignore */ }
                } else if (now - state.lastEdit >= EDIT_INTERVAL_MS) {
                  state.lastEdit = now;
                  try {
                    await this.bot.api.editMessageText(Number(state.targetChatId), state.sentMsgId, state.accumulated);
                  } catch { /* throttle */ }
                }
              }
            }
          }
        } else if (event.type === "session.status" && props.status?.type === "idle") {
          // Final edit with complete text
          if (state.targetChatId && state.sentMsgId && state.accumulated && this.bot) {
            try {
              await this.bot.api.editMessageText(Number(state.targetChatId), state.sentMsgId, state.accumulated);
            } catch { /* not modified */ }
          }
          resetResponse();
        }
      }
    }
  }

  private async _getLastChatId(sessionId: number): Promise<string | undefined> {
    const rows = await sql`
      SELECT chat_id FROM messages
      WHERE session_id = ${sessionId} AND role = 'user'
      ORDER BY created_at DESC LIMIT 1
    `;
    return rows[0]?.chat_id ?? undefined;
  }
}

export const opencodeMonitor = new OpencodeMonitor();
