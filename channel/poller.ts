/**
 * MessageQueuePoller — LISTEN/NOTIFY + polling loop.
 */

import type postgres from "postgres";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StatusManager } from "./status.ts";
import type { SkillEvaluator } from "./skill-evaluator.ts";
import { channelLogger } from "../logger.ts";
import { setTelegramReaction } from "./telegram.ts";

export interface PollerContext {
  sql: postgres.Sql;
  mcp: Server;
  sessionId: () => number | null;
  pollIntervalMs: number;
  databaseUrl: string;
  /** Called after each dequeue to tell tools whether to force a voice reply */
  setForceVoice?: (v: boolean) => void;
  /** Telegram bot token — used to set ⚡ reaction when message is taken into work */
  token?: () => string | undefined;
}

export class MessageQueuePoller {
  private polling = true;
  private wakeResolve: (() => void) | null = null;
  private listenSql: import("postgres").default | null = null;

  constructor(
    private ctx: PollerContext,
    private status: StatusManager,
    private touchIdleTimer: () => void,
    private skillEvaluator?: SkillEvaluator,
  ) {}

  private async setupListenNotify(): Promise<void> {
    const sessionId = this.ctx.sessionId();
    if (sessionId === null) return;
    try {
      const { default: postgres } = await import("postgres");
      this.listenSql = postgres(this.ctx.databaseUrl, { max: 1 });
      const listenSql = this.listenSql;
      await listenSql.listen(`message_queue_${sessionId}`, () => {
        if (this.wakeResolve) { this.wakeResolve(); this.wakeResolve = null; }
      });
      channelLogger.info({ sessionId }, "LISTEN/NOTIFY active");
    } catch (err) {
      channelLogger.warn({ err }, "LISTEN/NOTIFY setup failed, falling back to polling");
    }
  }

  private waitForWakeOrTimeout(): Promise<void> {
    return new Promise((resolve) => {
      this.wakeResolve = resolve;
      setTimeout(() => { this.wakeResolve = null; resolve(); }, this.ctx.pollIntervalMs);
    });
  }

  stop(): void {
    this.polling = false;
    if (this.wakeResolve) { this.wakeResolve(); this.wakeResolve = null; }
    this.listenSql?.end().catch(() => {});
    this.listenSql = null;
  }

  async start(): Promise<void> {
    const sessionId = this.ctx.sessionId();
    if (sessionId !== null) await this.setupListenNotify();

    while (this.polling) {
      try {
        const sid = this.ctx.sessionId();
        if (sid === null) {
          await new Promise((r) => setTimeout(r, this.ctx.pollIntervalMs));
          continue;
        }

        // FOR UPDATE SKIP LOCKED: concurrent pollers (e.g. from rapid Stop/Start
        // cycles that leave multiple channel.ts instances alive for the same session)
        // skip already-locked rows instead of racing on the same IDs.
        // Without this, two pollers evaluating the subquery at the same MVCC snapshot
        // could both get the same ID, then both UPDATE it (outer WHERE re-checks id only,
        // not delivered=false), causing duplicate deliveries.
        const rows = await this.ctx.sql`
          UPDATE message_queue
          SET delivered = true
          WHERE id IN (
            SELECT id FROM message_queue
            WHERE session_id = ${sid} AND delivered = false
            ORDER BY created_at
            LIMIT 10
            FOR UPDATE SKIP LOCKED
          )
          RETURNING id, chat_id, from_user, content, message_id, created_at, attachments
        `;

        for (const row of rows) {
          const tDequeue = Date.now();
          const queueAge = tDequeue - new Date(row.created_at).getTime();
          channelLogger.info({ phase: "poller", step: "dequeued", msgId: row.id, sessionId: sid, chatId: row.chat_id, queueAgeMs: queueAge, t: tDequeue }, "perf");

          const hint = this.skillEvaluator?.buildHint(row.content) ?? "";
          const isVoiceMsg = !!(row.attachments as Record<string, unknown> | null)?.isVoice;
          this.ctx.setForceVoice?.(isVoiceMsg);
          // Always prepend TTS awareness note so Claude knows voice is automatic
          const ttsNote = isVoiceMsg
            ? "[Channel system: The user sent a voice message. ALWAYS send a voice reply regardless of length — it is sent automatically after reply, you do NOT need to do anything extra.]\n"
            : "[Channel system: Replies ≥300 chars are automatically sent as a voice message after you call reply — you do NOT need to do anything extra, and you CAN send voice (automatically). Never claim you cannot.]\n";
          const enrichedContent = `${ttsNote}${hint}${row.content}`;
          if (hint) channelLogger.debug({ hint: hint.trim() }, "skill hint injected");

          // 1. Deliver to Claude immediately — don't wait for Telegram HTTP
          this.ctx.mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: enrichedContent,
              meta: {
                chat_id: row.chat_id,
                user: row.from_user,
                message_id: row.message_id || undefined,
                ts: new Date(row.created_at).toISOString(),
                attachments: row.attachments ?? undefined,
              },
            },
          }).catch((err) => channelLogger.warn({ err }, "mcp.notification failed"));
          channelLogger.info({ phase: "poller", step: "notification-sent", msgId: row.id, chatId: row.chat_id, elapsedMs: Date.now() - tDequeue, totalFromQueueMs: Date.now() - new Date(row.created_at).getTime() }, "perf");

          // ⚡ — message taken into work by Claude Code (upgrades 👀 to ⚡)
          const token = this.ctx.token?.();
          const telegramMsgId = row.message_id ? Number(row.message_id) : null;
          if (token && telegramMsgId && !isNaN(telegramMsgId)) {
            setTelegramReaction(token, row.chat_id, telegramMsgId, "⚡").catch(() => {});
          }
          this.touchIdleTimer();

          // 2. Create status message (awaited) — monitor MUST start after this so
          //    updateStatus() finds an active state and doesn't silently drop updates
          this.status.startTypingForChat(row.chat_id);
          await this.status.sendStatusMessage(row.chat_id, "Thinking...");

          // 3. Start progress monitor — status is now registered, updates will land
          this.status.startProgressMonitorForChat(row.chat_id).catch(() => {});
          this.status.armResponseGuard(row.chat_id);
        }
      } catch (err) {
        channelLogger.error({ err }, "poll error");
      }

      await this.waitForWakeOrTimeout();
    }
  }
}
