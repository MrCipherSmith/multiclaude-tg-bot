import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

interface ProcessHealthRow {
  name: string;
  status: string;
  detail: Record<string, unknown> | null;
  updated_at: string;
}

interface ProcessHealthData {
  health: ProcessHealthRow[];
  activeSessionCount: number;
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function fmtAge(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 10) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function StatusDot({ status, stale }: { status: string; stale?: boolean }) {
  const color = stale ? "bg-yellow-400" : status === "running" ? "bg-green-500" : "bg-red-500";
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${color}`} />;
}

export function ProcessHealth() {
  const [data, setData] = useState<ProcessHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await (api as any).processHealth();
      setData(result);
      setError(null);
    } catch (e: any) {
      setError(e.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const action = useCallback(async (fn: () => Promise<unknown>, key: string) => {
    setBusy(key);
    try { await fn(); await load(); } catch { /* ignore */ }
    finally { setBusy(null); }
  }, [load]);

  if (loading) {
    return <div className="p-4 text-[var(--tg-hint)] text-sm text-center">Loading...</div>;
  }

  if (error || !data) {
    return <div className="p-4 text-red-400 text-sm">{error ?? "No data"}</div>;
  }

  const daemonRow = data.health.find((r) => r.name === "admin-daemon");
  const dockerRows = data.health.filter((r) => r.name.startsWith("docker:"));
  const daemonStale = daemonRow
    ? Date.now() - new Date(daemonRow.updated_at).getTime() > 90_000
    : false;
  const botContainer = dockerRows.find((r) => r.name.includes("bot-") || r.name.includes("-bot"));

  // Group docker containers by prefix (e.g. "helyx", "carlson", "deploy")
  const dockerGroups: Record<string, ProcessHealthRow[]> = {};
  for (const row of dockerRows) {
    const cname = row.name.slice("docker:".length);
    const prefix = cname.includes("-") ? cname.split("-")[0] : cname;
    if (!dockerGroups[prefix]) dockerGroups[prefix] = [];
    dockerGroups[prefix].push(row);
  }

  return (
    <div className="flex flex-col gap-3 p-3 overflow-y-auto">
      {/* Refresh */}
      <div className="flex justify-end">
        <button onClick={load} className="text-xs text-[var(--tg-link)]">↻ Refresh</button>
      </div>

      {/* admin-daemon */}
      <div className="rounded-xl border border-black/10" style={{ background: "var(--tg-secondary-bg)" }}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-black/5">
          <span className="text-xs font-semibold text-[var(--tg-hint)] uppercase tracking-wide">admin-daemon</span>
          <button
            onClick={() => action(() => (api as any).restartDaemon(), "daemon")}
            disabled={busy === "daemon"}
            className="text-[10px] px-2 py-1 rounded-lg font-medium text-[var(--tg-button)] bg-[var(--tg-button)]/10 disabled:opacity-40"
          >
            {busy === "daemon" ? "…" : "🔄 Restart"}
          </button>
        </div>
        <div className="px-4 py-3">
          {daemonRow ? (
            <DaemonRow row={daemonRow} stale={daemonStale} />
          ) : (
            <div className="flex items-center gap-2">
              <StatusDot status="stopped" />
              <span className="text-sm text-red-400">Not running</span>
            </div>
          )}
        </div>
      </div>

      {/* Docker */}
      <div className="rounded-xl border border-black/10" style={{ background: "var(--tg-secondary-bg)" }}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-black/5">
          <span className="text-xs font-semibold text-[var(--tg-hint)] uppercase tracking-wide">Docker</span>
          {botContainer && (
            <button
              onClick={() => action(
                () => (api as any).restartDockerContainer(botContainer.name.slice("docker:".length)),
                "docker"
              )}
              disabled={busy === "docker"}
              className="text-[10px] px-2 py-1 rounded-lg font-medium text-[var(--tg-button)] bg-[var(--tg-button)]/10 disabled:opacity-40"
            >
              {busy === "docker" ? "…" : "🔄 Restart bot"}
            </button>
          )}
        </div>
        <div className="px-1">
          {dockerRows.length === 0 ? (
            <p className="px-4 py-3 text-sm text-[var(--tg-hint)]">No containers found</p>
          ) : (
            Object.entries(dockerGroups).map(([prefix, rows], gi) => (
              <div key={prefix}>
                {gi > 0 && <div className="mx-4 border-t border-black/5" />}
                <div className="px-4 pt-2 pb-1">
                  <span className="text-[10px] font-semibold text-[var(--tg-hint)] uppercase tracking-widest">{prefix}</span>
                </div>
                <div className="pb-2">
                  {rows.map((row) => (
                    <div key={row.name} className="px-4 py-1">
                      <DockerRow row={row} />
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* tmux sessions */}
      <div className="rounded-xl border border-black/10" style={{ background: "var(--tg-secondary-bg)" }}>
        <div className="px-4 py-2.5 border-b border-black/5">
          <span className="text-xs font-semibold text-[var(--tg-hint)] uppercase tracking-wide">tmux Sessions</span>
        </div>
        <div className="px-4 py-3 flex items-center gap-2">
          <span className="text-2xl font-bold text-[var(--tg-text)]">{data.activeSessionCount}</span>
          <span className="text-sm text-[var(--tg-hint)]">active session{data.activeSessionCount !== 1 ? "s" : ""}</span>
        </div>
      </div>
    </div>
  );
}

function DaemonRow({ row, stale }: { row: ProcessHealthRow; stale: boolean }) {
  const detail = row.detail as { pid?: number; uptime_ms?: number } | null;
  const uptime = detail?.uptime_ms != null ? fmtUptime(detail.uptime_ms) : "?";
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <StatusDot status={row.status} stale={stale} />
      <span className={stale ? "text-yellow-500" : "text-[var(--tg-text)]"}>
        {row.status === "running" ? "Running" : "Stopped"}
      </span>
      {detail?.pid && <span className="text-[var(--tg-hint)] text-xs">PID {detail.pid}</span>}
      <span className="text-[var(--tg-hint)] text-xs">⏱ {uptime}</span>
      {stale && (
        <span className="text-yellow-500 text-xs">⚠ {fmtAge(row.updated_at)}</span>
      )}
    </div>
  );
}

function DockerRow({ row }: { row: ProcessHealthRow }) {
  const cname = row.name.slice("docker:".length);
  const detail = row.detail as { status?: string } | null;
  return (
    <div className="flex items-center gap-2 text-sm">
      <StatusDot status={row.status} />
      <span className={row.status === "running" ? "text-[var(--tg-text)]" : "text-red-400"}>{cname}</span>
      {detail?.status && (
        <span className="text-[var(--tg-hint)] text-xs truncate">{detail.status}</span>
      )}
    </div>
  );
}
