import { useState, useEffect, useCallback } from "react";
import { api, type Session, type SessionDetail } from "../api";

interface Props { session: Session }

export function SessionMonitor({ session }: Props) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [perms, setPerms] = useState<{ id: number; tool_name: string; description: string; created_at: string }[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [det, pList] = await Promise.all([
        api.session(session.id),
        api.permissions.list(session.id),
      ]);
      setDetail(det);
      setPerms(pList);
    } catch {}
    setLoading(false);
  }, [session.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  function relativeTime(iso: string) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return `${Math.floor(diff)}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full text-[var(--tg-hint)] text-sm">Loading...</div>;
  }

  const isActive = detail?.status === "active";
  const lastActiveAgo = detail ? (Date.now() - new Date(detail.last_active).getTime()) / 1000 : 9999;
  const isWorking = isActive && lastActiveAgo < 10;

  return (
    <div className="flex flex-col gap-0 overflow-y-auto h-full">
      {/* Status banner */}
      <div className={`flex items-center gap-3 px-4 py-3 ${isWorking ? "bg-green-500/10" : isActive ? "bg-blue-500/5" : "bg-black/5"}`}>
        <div className={`w-3 h-3 rounded-full shrink-0 ${isWorking ? "bg-green-500 animate-pulse" : isActive ? "bg-blue-400" : "bg-gray-400"}`} />
        <div>
          <div className="text-sm font-semibold">
            {isWorking ? "Working..." : isActive ? "Idle" : "Inactive"}
          </div>
          {detail && (
            <div className="text-xs text-[var(--tg-hint)]">
              Last active: {relativeTime(detail.last_active)}
            </div>
          )}
        </div>
      </div>

      {/* Session info */}
      <div className="px-4 py-3 border-b border-black/5">
        <div className="text-xs font-semibold text-[var(--tg-hint)] uppercase mb-2">Session</div>
        <InfoRow label="ID" value={`#${session.id}`} />
        <InfoRow label="Project" value={detail?.project ?? "—"} />
        <InfoRow label="Source" value={detail?.source ?? "—"} />
        <InfoRow label="Status" value={detail?.status ?? "—"} />
        <InfoRow label="Path" value={detail?.project_path ?? "—"} mono />
        {detail?.connected_at && (
          <InfoRow label="Connected" value={relativeTime(detail.connected_at)} />
        )}
      </div>

      {/* Pending permissions */}
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold text-[var(--tg-hint)] uppercase">Pending Permissions</div>
          {perms.length > 0 && (
            <span className="bg-red-500 text-white text-xs rounded-full px-1.5">{perms.length}</span>
          )}
        </div>
        {perms.length === 0 ? (
          <div className="text-xs text-[var(--tg-hint)]">None pending</div>
        ) : (
          <div className="flex flex-col gap-1">
            {perms.slice(0, 5).map((p) => (
              <div key={p.id} className="flex items-center gap-2 text-xs">
                <code className="px-1.5 py-0.5 bg-black/10 rounded">{p.tool_name}</code>
                <span className="text-[var(--tg-hint)]">{relativeTime(p.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="text-xs text-[var(--tg-hint)] shrink-0 w-20">{label}</span>
      <span className={`text-xs break-all ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
