import { useState, useEffect, useCallback } from "react";
import { api, type Session, type PermissionRequest } from "../api";

interface Props { session: Session }

export function PermissionList({ session }: Props) {
  const [perms, setPerms] = useState<PermissionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Set<number>>(new Set());

  const load = useCallback(() => {
    setLoading(true);
    api.permissions.list(session.id)
      .then(setPerms)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [session.id]);

  useEffect(load, [load]);

  // Auto-refresh every 3 seconds
  useEffect(() => {
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  async function respond(id: number, response: "allow" | "deny") {
    setPending((p) => new Set(p).add(id));
    try {
      await api.permissions.respond(id, response);
      setPerms((prev) => prev.filter((p) => p.id !== id));
    } catch (e: any) {
      alert(e.message);
    } finally {
      setPending((p) => { const n = new Set(p); n.delete(id); return n; });
    }
  }

  async function always(id: number) {
    setPending((p) => new Set(p).add(id));
    try {
      await api.permissions.always(id);
      setPerms((prev) => prev.filter((p) => p.id !== id));
    } catch (e: any) {
      alert(e.message);
    } finally {
      setPending((p) => { const n = new Set(p); n.delete(id); return n; });
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-black/10 shrink-0"
        style={{ background: "var(--tg-secondary-bg)" }}>
        <span className="text-sm font-medium">Pending Permissions</span>
        <div className="flex items-center gap-2">
          {perms.length > 0 && (
            <span className="bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
              {perms.length}
            </span>
          )}
          <button onClick={load} className="text-xs text-[var(--tg-link)]">↻</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && perms.length === 0 && (
          <div className="p-4 text-[var(--tg-hint)] text-sm text-center">Loading...</div>
        )}
        {error && <div className="p-4 text-red-500 text-sm">{error}</div>}
        {!loading && perms.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center p-6">
            <div className="text-3xl">✅</div>
            <p className="text-[var(--tg-hint)] text-sm">No pending permissions</p>
          </div>
        )}

        {perms.map((perm) => (
          <div key={perm.id} className="border-b border-black/5 p-3">
            <div className="flex items-start gap-2 mb-2">
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-black/10 shrink-0">{perm.tool_name}</span>
              <span className="text-xs text-[var(--tg-hint)]">{new Date(perm.created_at).toLocaleTimeString()}</span>
            </div>
            {perm.description && (
              <pre className="text-xs bg-black/5 rounded-lg p-2 mb-3 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                {perm.description}
              </pre>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => respond(perm.id, "allow")}
                disabled={pending.has(perm.id)}
                className="flex-1 py-2 rounded-xl text-sm font-medium bg-green-500/90 text-white active:bg-green-600 disabled:opacity-50"
              >
                ✅ Allow
              </button>
              <button
                onClick={() => respond(perm.id, "deny")}
                disabled={pending.has(perm.id)}
                className="flex-1 py-2 rounded-xl text-sm font-medium bg-red-500/90 text-white active:bg-red-600 disabled:opacity-50"
              >
                ❌ Deny
              </button>
              <button
                onClick={() => always(perm.id)}
                disabled={pending.has(perm.id)}
                className="py-2 px-3 rounded-xl text-sm font-medium bg-blue-500/90 text-white active:bg-blue-600 disabled:opacity-50"
                title="Always Allow this tool"
              >
                ♾️
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
