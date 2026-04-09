import { sql } from "../memory/db.ts";
import { CONFIG } from "../config.ts";
import { deleteSessionCascade } from "../sessions/delete.ts";
import { sessionManager } from "../sessions/manager.ts";
import { cleanupStaleTimers } from "../memory/summarizer.ts";

export type CleanupJob = {
  name: string;
  run: (dryRun: boolean) => Promise<{ rowsAffected: number }>;
};

export const messageQueueCleanup: CleanupJob = {
  name: "message-queue",
  async run(dryRun) {
    if (dryRun) {
      const rows = await sql`SELECT COUNT(*) AS count FROM message_queue WHERE delivered = true AND created_at < now() - interval '24 hours'`;
      return { rowsAffected: Number(rows[0].count) };
    }
    const res = await sql`DELETE FROM message_queue WHERE delivered = true AND created_at < now() - interval '24 hours'`;
    return { rowsAffected: res.count };
  },
};

export const logRotation: CleanupJob = {
  name: "log-rotation",
  async run(dryRun) {
    if (dryRun) {
      const rows = await sql`SELECT COUNT(*) AS count FROM request_logs WHERE created_at < now() - interval '7 days'`;
      const stats = await sql`SELECT COUNT(*) AS count FROM api_request_stats WHERE created_at < now() - interval '30 days'`;
      return { rowsAffected: Number(rows[0].count) + Number(stats[0].count) };
    }
    const logs = await sql`DELETE FROM request_logs WHERE created_at < now() - interval '7 days'`;
    const stats = await sql`DELETE FROM api_request_stats WHERE created_at < now() - interval '30 days'`;
    return { rowsAffected: logs.count + stats.count };
  },
};

export const archivedMessagesTTL: CleanupJob = {
  name: "archived-messages",
  async run(dryRun) {
    if (dryRun) {
      const rows = await sql`
        SELECT COUNT(*) AS count FROM messages
        WHERE archived_at IS NOT NULL
          AND archived_at < now() - make_interval(days => ${CONFIG.ARCHIVE_TTL_DAYS})
      `;
      const perms = await sql`
        SELECT COUNT(*) AS count FROM permission_requests
        WHERE archived_at IS NOT NULL
          AND archived_at < now() - make_interval(days => ${CONFIG.ARCHIVE_TTL_DAYS})
      `;
      return { rowsAffected: Number(rows[0].count) + Number(perms[0].count) };
    }
    const msgs = await sql`
      DELETE FROM messages
      WHERE archived_at IS NOT NULL
        AND archived_at < now() - make_interval(days => ${CONFIG.ARCHIVE_TTL_DAYS})
      RETURNING id
    `;
    const perms = await sql`
      DELETE FROM permission_requests
      WHERE archived_at IS NOT NULL
        AND archived_at < now() - make_interval(days => ${CONFIG.ARCHIVE_TTL_DAYS})
      RETURNING id
    `;
    return { rowsAffected: msgs.length + perms.length };
  },
};

export const memoryTTL: CleanupJob = {
  name: "memory-ttl",
  async run(dryRun) {
    let total = 0;
    for (const [mtype, ttlDays] of Object.entries(CONFIG.MEMORY_TTL_DAYS)) {
      if (ttlDays <= 0) continue;
      if (dryRun) {
        const rows = await sql`
          SELECT COUNT(*) AS count FROM memories
          WHERE type = ${mtype}
            AND created_at < now() - make_interval(days => ${ttlDays})
        `;
        total += Number(rows[0].count);
      } else {
        const result = await sql`
          DELETE FROM memories
          WHERE type = ${mtype}
            AND created_at < now() - make_interval(days => ${ttlDays})
          RETURNING id
        `;
        total += result.length;
      }
    }
    return { rowsAffected: total };
  },
};

export const orphanCliSessionCleanup: CleanupJob = {
  name: "orphan-cli-sessions",
  async run(dryRun) {
    if (dryRun) {
      // Count child rows that would be deleted
      const rows = await sql`SELECT COUNT(*) AS count FROM sessions WHERE source != 'remote' AND status IN ('disconnected', 'terminated') AND id != 0`;
      return { rowsAffected: Number(rows[0].count) };
    }
    await sql`DELETE FROM chat_sessions WHERE active_session_id IN (SELECT id FROM sessions WHERE source != 'remote' AND status IN ('disconnected', 'terminated') AND id != 0)`;
    await sql`DELETE FROM memories WHERE session_id IN (SELECT id FROM sessions WHERE source != 'remote' AND status IN ('disconnected', 'terminated') AND id != 0)`;
    await sql`DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE source != 'remote' AND status IN ('disconnected', 'terminated') AND id != 0)`;
    await sql`DELETE FROM permission_requests WHERE session_id IN (SELECT id FROM sessions WHERE source != 'remote' AND status IN ('disconnected', 'terminated') AND id != 0)`;
    await sql`DELETE FROM message_queue WHERE session_id IN (SELECT id FROM sessions WHERE source != 'remote' AND status IN ('disconnected', 'terminated') AND id != 0)`;
    await sql`DELETE FROM request_logs WHERE session_id IN (SELECT id FROM sessions WHERE source != 'remote' AND status IN ('disconnected', 'terminated') AND id != 0)`;
    await sql`DELETE FROM api_request_stats WHERE session_id IN (SELECT id FROM sessions WHERE source != 'remote' AND status IN ('disconnected', 'terminated') AND id != 0)`;
    await sql`DELETE FROM transcription_stats WHERE session_id IN (SELECT id FROM sessions WHERE source != 'remote' AND status IN ('disconnected', 'terminated') AND id != 0)`;
    const res = await sql`DELETE FROM sessions WHERE source != 'remote' AND status IN ('disconnected', 'terminated') AND id != 0`;
    await sessionManager.deleteOrphanCliSessions();
    await cleanupStaleTimers();
    return { rowsAffected: res.count };
  },
};

export const staleSessionArchival: CleanupJob = {
  name: "stale-session-archival",
  async run(dryRun) {
    if (dryRun) {
      const rows = await sql`
        SELECT COUNT(*) AS count FROM sessions
        WHERE source = 'local'
          AND status = 'terminated'
          AND last_active < now() - make_interval(days => ${CONFIG.ARCHIVE_TTL_DAYS})
      `;
      return { rowsAffected: Number(rows[0].count) };
    }
    const staleSessions = await sql`
      SELECT id FROM sessions
      WHERE source = 'local'
        AND status = 'terminated'
        AND last_active < now() - make_interval(days => ${CONFIG.ARCHIVE_TTL_DAYS})
    `;
    for (const s of staleSessions) {
      await deleteSessionCascade(s.id);
    }
    return { rowsAffected: staleSessions.length };
  },
};

export const ALL_JOBS: CleanupJob[] = [
  messageQueueCleanup,
  logRotation,
  archivedMessagesTTL,
  memoryTTL,
  orphanCliSessionCleanup,
  staleSessionArchival,
];
