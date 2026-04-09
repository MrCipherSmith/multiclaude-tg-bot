import { useState, useEffect, useCallback } from "react";
import { api, type Session, type SessionDetail } from "../api";

interface Props { session: Session }

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
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const det = await api.session(session.id);
      setDetail(det);
    } catch {}
    setLoading(false);
  }, [session.id]);

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

      {/* Token usage */}
      {tokens && tokens.api_calls > 0 && (
        <Section title="Token Usage">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <TokenStat label="API calls" value={String(tokens.api_calls)} />
            <TokenStat label="Total" value={fmtTokens(tokens.total_tokens)} />
            <TokenStat label="Input" value={fmtTokens(tokens.input_tokens)} />
            <TokenStat label="Output" value={fmtTokens(tokens.output_tokens)} />
          </div>
        </Section>
      )}

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

      {recentTools.length === 0 && (!tokens || tokens.api_calls === 0) && (
        <div className="px-4 py-6 text-center text-[var(--tg-hint)] text-xs">No activity yet</div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 border-b border-black/5">
      <div className="text-xs font-semibold text-[var(--tg-hint)] uppercase mb-2">{title}</div>
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

function TokenStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-[var(--tg-hint)]">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}

function ResponseBadge({ response }: { response: string | null }) {
  if (response === "allow") return <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />;
  if (response === "deny") return <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />;
  return <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 shrink-0" />;
}
