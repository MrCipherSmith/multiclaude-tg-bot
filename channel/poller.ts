/**
 * MessageQueuePoller — LISTEN/NOTIFY + polling loop.
 */

import type postgres from "postgres";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StatusManager } from "./status.ts";
import type { SkillEvaluator } from "./skill-evaluator.ts";
import { channelLogger } from "../logger.ts";

export interface PollerContext {
  sql: postgres.Sql;
  mcp: Server;
  sessionId: () => number | null;
  pollIntervalMs: number;
  databaseUrl: string;
}

export class MessageQueuePoller {
  private polling = true;
  private wakeResolve: (() => void) | null = null;

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
      const listenSql = postgres(this.ctx.databaseUrl, { max: 1 });
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

        const rows = await this.ctx.sql`
          UPDATE message_queue
          SET delivered = true
          WHERE id IN (
            SELECT id FROM message_queue
            WHERE session_id = ${sid} AND delivered = false
            ORDER BY created_at
            LIMIT 10
          )
          RETURNING id, chat_id, from_user, content, message_id, created_at, attachments
        `;

        for (const row of rows) {
          channelLogger.info({ msgId: row.id, sessionId: sid, preview: row.content.slice(0, 50) }, "message dequeued");

          const hint = this.skillEvaluator?.buildHint(row.content) ?? "";
          const enrichedContent = hint ? `${hint}${row.content}` : row.content;
          if (hint) channelLogger.debug({ hint: hint.trim() }, "skill hint injected");

          // Deliver to Claude first — don't block on status message HTTP round-trip
          await this.ctx.mcp.notification({
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
          });
          channelLogger.info({ user: row.from_user, preview: row.content.slice(0, 50) }, "message delivered to Claude");
          this.touchIdleTimer();

          // Status + typing + monitor fire concurrently after notification (non-blocking)
          this.status.startTypingForChat(row.chat_id);
          this.status.sendStatusMessage(row.chat_id, "Thinking...").catch((err) =>
            channelLogger.warn({ err }, "sendStatusMessage failed"),
          );
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
