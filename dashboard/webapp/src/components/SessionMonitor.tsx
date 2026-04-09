import { useState, useEffect, useCallback } from "react";
import { api, type Session, type SessionDetail } from "../api";

interface Props { session: Session }

type PermStats = Awaited<ReturnType<typeof api.permissions.stats>>;
type GlobalStats = Awaited<ReturnType<typeof api.globalStats>>;

function relativeTime(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function SessionMonitor({ session }: Props) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const [permStats, setPermStats] = useState<PermStats | null>(null);
  const [statsDays, setStatsDays] = useState(30);
  const [statsWindow, setStatsWindow] = useState<"24h" | "startup" | "total">("24h");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [det, gs, ps] = await Promise.all([
        api.session(session.id),
        api.globalStats(),
        api.permissions.stats(session.id, statsDays),
      ]);
      setDetail(det);
      setGlobalStats(gs);
      setPermStats(ps);
    } catch {}
    setLoading(false);
  }, [session.id, statsDays]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (loading) {
    return <div className="flex items-center justify-center h-full text-[var(--tg-hint)] text-sm">Loading...</div>;
  }

  const isActive = detail?.status === "active";
  const lastActiveAgo = detail ? (Date.now() - new Date(detail.last_active).getTime()) / 1000 : 9999;
  const isWorking = isActive && lastActiveAgo < 10;

  const tokens = detail?.tokens;
  const recentTools = detail?.recent_tools ?? [];

  return (
    <div className="flex flex-col gap-0 overflow-y-auto h-full">
      {/* Status banner */}
      <div className={`flex items-center gap-3 px-4 py-3 ${isWorking ? "bg-green-500/10" : isActive ? "bg-blue-500/5" : "bg-black/5"}`}>
        <div className={`w-3 h-3 rounded-full shrink-0 ${isWorking ? "bg-green-500 animate-pulse" : isActive ? "bg-blue-400" : "bg-gray-400"}`} />
        <div className="flex-1">
          <div className="text-sm font-semibold">
            {isWorking ? "Working..." : isActive ? "Idle" : "Inactive"}
          </div>
          {detail && (
            <div className="text-xs text-[var(--tg-hint)]">
              Last active: {relativeTime(detail.last_active)}
            </div>
          )}
        </div>
        <button onClick={load} className="text-[var(--tg-hint)] text-xs p-1">↻</button>
      </div>

      {/* Session info */}
      <Section title="Session">
        <InfoRow label="ID" value={`#${session.id}`} />
        <InfoRow label="Project" value={detail?.project ?? "—"} />
        <InfoRow label="Source" value={detail?.source ?? "—"} />
        <InfoRow label="Status" value={detail?.status ?? "—"} />
        <InfoRow label="Path" value={detail?.project_path ?? "—"} mono />
        {detail?.connected_at && (
          <InfoRow label="Connected" value={relativeTime(detail.connected_at)} />
        )}
        {typeof detail?.message_count === "number" && (
          <InfoRow label="Messages" value={String(detail.message_count)} />
        )}
      </Section>

      {/* API Stats (global) */}
      {globalStats && (() => {
        const w = globalStats.api[statsWindow];
        if (!w || w.summary.total === 0) return null;
        const s = w.summary;
        return (
          <Section title={
            <div className="flex items-center justify-between w-full">
              <span>API Stats (global)</span>
              <select
                className="text-[10px] text-[var(--tg-hint)] bg-transparent border border-black/10 rounded px-1"
                value={statsWindow}
                onChange={(e) => setStatsWindow(e.target.value as any)}
              >
                <option value="24h">24h</option>
                <option value="startup">Since restart</option>
                <option value="total">All time</option>
              </select>
            </div>
          }>
            <div className="grid grid-cols-3 gap-x-2 gap-y-2 mb-3">
              <TokenStat label="Requests" value={String(s.total)} />
              <TokenStat label="Errors" value={String(s.errors)} accent={s.errors > 0 ? "text-red-500" : undefined} />
              <TokenStat label="Avg latency" value={`${s.avg_latency_ms}ms`} />
              <TokenStat label="Total tokens" value={fmtTokens(s.total_tokens)} />
              <TokenStat label="Input" value={fmtTokens(s.input_tokens)} />
              <TokenStat label="Output" value={fmtTokens(s.output_tokens)} />
            </div>
            {s.estimated_cost > 0 && (
              <div className="text-[10px] text-[var(--tg-hint)] mb-2">
                Est. cost: <span className="font-semibold text-[var(--tg-text)]">${s.estimated_cost.toFixed(4)}</span>
              </div>
            )}
            {w.byProvider.length > 0 && (
              <div>
                <div className="text-[10px] text-[var(--tg-hint)] mb-1">By model</div>
                <div className="flex flex-col gap-1">
                  {w.byProvider.map((m) => (
                    <div key={`${m.provider}/${m.model}`} className="flex items-center gap-2 text-[10px]">
                      <span className="truncate flex-1 font-mono">{m.model}</span>
                      <span className="text-[var(--tg-hint)]">{m.requests}req</span>
                      <span className="text-[var(--tg-hint)]">{fmtTokens(m.tokens)}tok</span>
                      {m.cost > 0 && <span className="text-[var(--tg-hint)]">${m.cost.toFixed(3)}</span>}
                      <span className="text-[var(--tg-hint)]">{m.avg_ms}ms</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Section>
        );
      })()}

      {/* Recent tool calls */}
      {recentTools.length > 0 && (
        <Section title={`Tool Calls (${recentTools.length})`}>
          <div className="flex flex-col gap-1">
            {recentTools.map((t, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <ResponseBadge response={t.response} />
                <code className="flex-1 truncate text-[10px] px-1.5 py-0.5 bg-black/5 rounded">
                  {t.tool_name}
                </code>
                <span className="text-[var(--tg-hint)] shrink-0">{relativeTime(t.created_at)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Permission Analytics */}
      {permStats && permStats.summary.total > 0 && (
        <Section title={
          <div className="flex items-center justify-between w-full">
            <span>Permission History</span>
            <select
              className="text-[10px] text-[var(--tg-hint)] bg-transparent border border-black/10 rounded px-1"
              value={statsDays}
              onChange={(e) => setStatsDays(Number(e.target.value))}
            >
              <option value={7}>7d</option>
              <option value={30}>30d</option>
              <option value={90}>90d</option>
            </select>
          </div>
        }>
          {/* Summary row */}
          <div className="flex gap-3 mb-3">
            <PermSumStat label="Total" value={permStats.summary.total} color="text-[var(--tg-text)]" />
            <PermSumStat label="Allowed" value={permStats.summary.allowed} color="text-green-600" />
            <PermSumStat label="Always" value={permStats.summary.always_allowed} color="text-blue-500" />
            <PermSumStat label="Denied" value={permStats.summary.denied} color="text-red-500" />
            {permStats.summary.pending > 0 && (
              <PermSumStat label="Pending" value={permStats.summary.pending} color="text-yellow-500" />
            )}
          </div>
          {/* Top tools */}
          <div className="flex flex-col gap-1">
            {permStats.top_tools.slice(0, 8).map((t) => {
              const pct = Math.round(((t.allowed + t.always_allowed) / t.total) * 100);
              return (
                <div key={t.tool_name} className="flex items-center gap-2">
                  <code className="text-[10px] truncate flex-1 max-w-[120px]">{t.tool_name}</code>
                  <div className="flex-1 h-1.5 bg-black/5 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-green-500/60 rounded-full"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-[var(--tg-hint)] w-6 text-right">{t.total}</span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {recentTools.length === 0 && (!tokens || tokens.api_calls === 0) && (
        <div className="px-4 py-6 text-center text-[var(--tg-hint)] text-xs">No activity yet</div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 border-b border-black/5">
      <div className="text-xs font-semibold text-[var(--tg-hint)] uppercase mb-2 flex items-center">{title}</div>
      {children}
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="text-xs text-[var(--tg-hint)] shrink-0 w-20">{label}</span>
      <span className={`text-xs break-all ${mono ? "font-mono text-[10px]" : ""}`}>{value}</span>
    </div>
  );
}

function TokenStat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div className="text-[10px] text-[var(--tg-hint)]">{label}</div>
      <div className={`text-sm font-semibold ${accent ?? ""}`}>{value}</div>
    </div>
  );
}

function ResponseBadge({ response }: { response: string | null }) {
  if (response === "allow") return <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />;
  if (response === "deny") return <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />;
  return <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 shrink-0" />;
}

function PermSumStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex-1 text-center">
      <div className={`text-sm font-bold ${color}`}>{value}</div>
      <div className="text-[9px] text-[var(--tg-hint)]">{label}</div>
    </div>
  );
}
