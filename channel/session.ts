/**
 * Session lifecycle — resolveSession(), lease-based ownership, idle timer.
 *
 * Replaces pg_advisory_lock with a TTL lease stored in the sessions table.
 * The lease_owner identifies this process uniquely; lease_expires_at is renewed
 * every heartbeat. If the process crashes, the lease auto-expires and another
 * channel.ts process can take over after the TTL (3 minutes).
 */

import type postgres from "postgres";
import { channelLogger } from "../logger.ts";
import { transitionSession, type SessionStatus } from "../sessions/state-machine.ts";

export interface SessionContext {
  sql: postgres.Sql;
  projectName: string;
  projectPath: string;
  channelSource: "remote" | "local" | null;
  botApiUrl: string;
  idleTimeoutMs: number;
}

const LEASE_TTL = "3 minutes";
const LEASE_RETRY_DELAY_MS = 1000;
const LEASE_MAX_ATTEMPTS = 5;

export class SessionManager {
  sessionId: number | null = null;
  sessionName: string;
  private leaseOwner: string;
  private leaseAcquired = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctx: SessionContext) {
    this.sessionName = `${ctx.projectName} · ${ctx.channelSource ?? "standalone"}`;
    this.leaseOwner = `ch-${ctx.projectName}-${ctx.channelSource ?? "x"}-${Date.now()}`;
  }

  // --- Lease helpers ---

  private async acquireLease(sessionId: number): Promise<boolean> {
    const result = await this.ctx.sql`
      UPDATE sessions
      SET lease_owner = ${this.leaseOwner},
          lease_expires_at = now() + ${LEASE_TTL}::interval
      WHERE id = ${sessionId}
        AND (lease_expires_at IS NULL OR lease_expires_at < now() OR lease_owner = ${this.leaseOwner})
      RETURNING id
    `;
    return result.length > 0;
  }

  async renewLease(): Promise<void> {
    if (!this.leaseAcquired || this.sessionId === null) return;
    const result = await this.ctx.sql`
      UPDATE sessions
      SET lease_expires_at = now() + ${LEASE_TTL}::interval,
          last_active = now()
      WHERE id = ${this.sessionId} AND lease_owner = ${this.leaseOwner}
      RETURNING id
    `;
    if (result.length === 0) {
      channelLogger.error({ sessionId: this.sessionId, owner: this.leaseOwner }, "lease lost — another process took ownership");
    }
  }

  private async releaseLease(): Promise<void> {
    if (!this.leaseAcquired || this.sessionId === null) return;
    await this.ctx.sql`
      UPDATE sessions SET lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ${this.sessionId} AND lease_owner = ${this.leaseOwner}
    `.catch(() => {});
    this.leaseAcquired = false;
    channelLogger.info({ sessionId: this.sessionId }, "lease released");
  }

  // --- Session resolution ---

  async resolve(): Promise<number> {
    const { sql, projectName, projectPath, channelSource } = this.ctx;

    if (channelSource === null) {
      channelLogger.info("standalone mode — no DB registration");
      return -1;
    }

    if (channelSource === "local") {
      const clientId = `channel-${projectName}-local-${Date.now()}`;
      const [proj] = await sql`SELECT id FROM projects WHERE path = ${projectPath}`;
      const projectId = proj?.id ?? null;
      const [row] = await sql`
        INSERT INTO sessions (name, project, source, project_path, project_id, client_id, status)
        VALUES (${this.sessionName}, ${projectName}, 'local', ${projectPath}, ${projectId}, ${clientId}, 'active')
        RETURNING id
      `;
      this.sessionId = row.id;
      const acquired = await this.acquireLease(this.sessionId!);
      if (acquired) this.leaseAcquired = true;
      channelLogger.info({ sessionId: this.sessionId, name: this.sessionName }, "created local session");
      return this.sessionId!;
    }

    // Remote session — reuse existing or create new
    const existing = await sql`
      SELECT id FROM sessions
      WHERE project = ${projectName} AND source = 'remote' AND id != 0
      ORDER BY last_active DESC
      LIMIT 1
    `;

    if (existing.length > 0) {
      for (let attempt = 0; attempt < LEASE_MAX_ATTEMPTS; attempt++) {
        const acquired = await this.acquireLease(existing[0].id);
        if (acquired) {
          this.sessionId = existing[0].id;
          this.leaseAcquired = true;
          const [proj] = await sql`SELECT id FROM projects WHERE path = ${projectPath}`;
          await sql`UPDATE sessions SET status = 'active', last_active = now(), project_id = ${proj?.id ?? null} WHERE id = ${this.sessionId!}`;
          channelLogger.info({ sessionId: this.sessionId, name: this.sessionName }, "attached to remote session");
          return this.sessionId!;
        }
        if (attempt < LEASE_MAX_ATTEMPTS - 1) {
          channelLogger.warn({ name: this.sessionName, attempt: attempt + 1 }, "session lease held by another process, retrying");
          await new Promise((r) => setTimeout(r, LEASE_RETRY_DELAY_MS));
        }
      }
      // Lease held by another process (e.g. stale subprocess from previous bounce).
      // Fall through to create a new session instead of exiting — the old one will
      // expire naturally when its lease TTL runs out.
      channelLogger.warn({ existingId: existing[0].id }, "remote session lease held after max attempts — creating new session");
    }

    const clientId = `channel-${projectName}-remote-${Date.now()}`;
    const [proj] = await sql`SELECT id FROM projects WHERE path = ${projectPath}`;
    const projectId = proj?.id ?? null;
    const [row] = await sql`
      INSERT INTO sessions (name, project, source, project_path, project_id, client_id, status)
      VALUES (${this.sessionName}, ${projectName}, 'remote', ${projectPath}, ${projectId}, ${clientId}, 'active')
      RETURNING id
    `;
    this.sessionId = row.id;
    this.leaseAcquired = true;
    const acquired = await this.acquireLease(this.sessionId);
    if (!acquired) {
      channelLogger.warn({ sessionId: this.sessionId }, "failed to acquire lease on newly created session (race?)");
    }
    channelLogger.info({ sessionId: this.sessionId, name: this.sessionName }, "created remote session");

    // Transfer chat routing from old sessions
    await sql`
      UPDATE chat_sessions SET active_session_id = ${this.sessionId}
      WHERE active_session_id IN (
        SELECT id FROM sessions WHERE project_path = ${projectPath} AND id != ${this.sessionId}
      )
    `;
    await sql`
      DELETE FROM sessions
      WHERE project_path = ${projectPath}
        AND id != ${this.sessionId}
        AND status = 'disconnected'
        AND client_id LIKE 'claude-%'
    `;

    return this.sessionId!;
  }

  // --- Idle timer ---

  touchIdleTimer(onIdle: () => Promise<void>): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(async () => {
      this.idleTimer = null;
      await onIdle();
    }, this.ctx.idleTimeoutMs);
  }

  clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // --- Summarization ---

  async triggerSummarize(): Promise<void> {
    if (this.sessionId === null) return;
    const { botApiUrl, projectPath, channelSource } = this.ctx;
    try {
      if (channelSource === "local") {
        channelLogger.info({ sessionId: this.sessionId }, "triggering work summary for local session");
        await fetch(`${botApiUrl}/api/sessions/${this.sessionId}/summarize-work`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: this.sessionId }),
        });
      } else {
        channelLogger.info({ sessionId: this.sessionId }, "triggering summarization");
        await fetch(`${botApiUrl}/api/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: this.sessionId, project_path: projectPath }),
        });
      }
    } catch (err) {
      channelLogger.error({ err }, "summarize request failed");
    }
  }

  // --- Disconnect ---

  async markDisconnected(): Promise<void> {
    if (this.sessionId === null) return;
    await this.triggerSummarize();
    try {
      const newStatus: SessionStatus = this.ctx.channelSource === "remote" ? "inactive" : "terminated";
      await transitionSession(this.ctx.sql, this.sessionId, newStatus);
      await this.releaseLease();
    } catch (err) {
      channelLogger.error({ err }, "failed to mark disconnected");
    }
  }
}
