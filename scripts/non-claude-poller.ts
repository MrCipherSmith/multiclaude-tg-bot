/**
 * scripts/non-claude-poller.ts
 *
 * Delivers messages from message_queue to non-Claude CLI sessions by typing
 * into their tmux windows. Counterpart to channel/poller.ts (which uses MCP
 * notifications for Claude Code).
 *
 * Runs inside admin-daemon (host process) — uses TmuxDriver via shell.
 *
 * Why we need this: Phase 6 added Codex/OpenCode/DeepSeek adapters whose
 * `send()` writes to message_queue. For Claude Code, channel.ts (MCP stdio
 * inside the tmux window) reads the queue. For non-Claude CLIs there is no
 * MCP — they're plain stdin/stdout. This poller bridges the gap.
 */
import type postgres from "postgres";
import type { RuntimeDriver } from "../runtime/types.ts";

const POLL_INTERVAL_MS = 1500;
const BATCH_LIMIT = 20;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

const SUPPORTED_RUNTIMES = ["codex-cli", "opencode", "deepseek-cli"] as const;

interface QueueRow {
  id: number;
  session_id: number;
  content: string;
  created_at: Date;
  cli_type: string;            // session.cli_type — runtime_type literal
  tmux_window: string | null;
  metadata: Record<string, unknown> | null;
}

export function startNonClaudePoller(
  sql: postgres.Sql,
  driver: RuntimeDriver,
  defaultTmuxSession = "bots",
): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    let rows: QueueRow[];
    try {
      rows = (await sql`
        SELECT
          mq.id, mq.session_id, mq.content, mq.created_at,
          s.cli_type, s.metadata,
          p.tmux_session_name AS tmux_window
        FROM message_queue mq
        JOIN sessions s ON s.id = mq.session_id
        LEFT JOIN projects p ON p.id = s.project_id
        WHERE mq.delivered = false
          AND s.cli_type IN ('codex-cli', 'opencode', 'deepseek-cli')
        ORDER BY mq.id ASC
        LIMIT ${BATCH_LIMIT}
      `) as unknown as QueueRow[];
    } catch (err) {
      console.warn(`[non-claude-poller] query failed: ${String(err)}`);
      return;
    }
    if (rows.length === 0) return;

    // Group by session, process per-session serially to preserve order
    const bySession = new Map<number, QueueRow[]>();
    for (const r of rows) {
      const arr = bySession.get(r.session_id) ?? [];
      arr.push(r);
      bySession.set(r.session_id, arr);
    }

    for (const [sessionId, msgs] of bySession) {
      const first = msgs[0];
      const metadataWindow = (first.metadata as Record<string, unknown> | null)?.tmux_window;
      const tmuxWindow = first.tmux_window
        ?? (typeof metadataWindow === "string" ? metadataWindow : undefined);
      if (!tmuxWindow) {
        console.warn(`[non-claude-poller] session ${sessionId}: no tmux_window resolvable, skipping`);
        // Mark as delivered to avoid infinite loop (couldn't deliver anyway)
        for (const m of msgs) {
          await sql`UPDATE message_queue SET delivered = true WHERE id = ${m.id}`.catch(() => {});
        }
        continue;
      }

      const handle = {
        driver: "tmux" as const,
        tmuxSession: defaultTmuxSession,
        tmuxWindow,
      };

      for (const msg of msgs) {
        // Stale check: messages older than threshold get dropped
        const ageMs = Date.now() - new Date(msg.created_at).getTime();
        if (ageMs > STALE_THRESHOLD_MS) {
          console.warn(
            `[non-claude-poller] dropping stale msg id=${msg.id} session=${sessionId} age=${Math.round(ageMs / 1000)}s`,
          );
          await sql`UPDATE message_queue SET delivered = true WHERE id = ${msg.id}`.catch(() => {});
          continue;
        }

        try {
          await driver.sendInput(handle, { kind: "text", text: msg.content });
          await sql`UPDATE message_queue SET delivered = true WHERE id = ${msg.id}`;
          console.log(
            `[non-claude-poller] delivered msg id=${msg.id} session=${sessionId} runtime=${first.cli_type} window=${tmuxWindow}`,
          );
        } catch (err) {
          console.warn(
            `[non-claude-poller] delivery failed msg id=${msg.id} session=${sessionId}: ${String(err)} — will retry`,
          );
          // Don't mark delivered — next tick retries. Stale check above will eventually drop.
          break; // stop processing this session for now (preserve order)
        }
      }
    }
  };

  console.log(
    `[non-claude-poller] started (poll interval: ${POLL_INTERVAL_MS} ms, runtimes: ${SUPPORTED_RUNTIMES.join(", ")})`,
  );
  const handleId = setInterval(() => {
    tick().catch((err) => console.error(`[non-claude-poller] tick error: ${String(err)}`));
  }, POLL_INTERVAL_MS);
  // unref so the interval doesn't keep process alive
  (handleId as unknown as { unref?: () => void }).unref?.();

  return () => {
    stopped = true;
    clearInterval(handleId);
    console.log("[non-claude-poller] stopped");
  };
}
