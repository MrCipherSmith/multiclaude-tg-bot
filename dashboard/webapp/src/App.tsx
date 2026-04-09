import { useState, useEffect, useCallback } from "react";
import { api, type Session } from "./api";
import { GitBrowser } from "./components/GitBrowser";
import { PermissionList } from "./components/PermissionList";
import { SessionMonitor } from "./components/SessionMonitor";
import { MessageHistory } from "./components/MessageHistory";

declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        ready(): void;
        expand(): void;
        colorScheme: "light" | "dark";
        initData: string;
        initDataUnsafe: { user?: { id: number; first_name: string } };
        MainButton: { show(): void; hide(): void; setText(t: string): void };
        close(): void;
      };
    };
  }
}

type Tab = "git" | "permissions" | "monitor" | "messages";

export function App() {
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<Tab>("git");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Init Telegram WebApp
  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
    }
  }, []);

  // Auth via initData
  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    const initData = tg?.initData;
    if (!initData) {
      // Dev mode: skip auth if no Telegram context
      if (import.meta.env.DEV) { setAuthed(true); loadSessions(); }
      else setAuthError("Open in Telegram");
      return;
    }
    api.authWebApp(initData)
      .then(() => { setAuthed(true); loadSessions(); })
      .catch((e) => setAuthError(e.message ?? "Auth failed"));
  }, []);

  async function loadSessions() {
    try {
      const [list, userActive] = await Promise.all([
        api.sessions(),
        api.activeSession().catch(() => null),
      ]);
      const nonStandalone = list.filter((s) => s.id !== 0);
      setSessions(nonStandalone);

      // Prefer user's actual active session from chat_sessions table
      if (userActive && userActive.id !== 0) {
        const match = nonStandalone.find((s) => s.id === userActive.id) ?? userActive;
        setSelectedSession(match);
      } else {
        // Fallback: first active session, then open sidebar
        const firstActive = nonStandalone.find((s) => s.status === "active");
        if (firstActive) {
          setSelectedSession(firstActive);
        } else if (nonStandalone.length > 0) {
          setSidebarOpen(true);
        }
      }
    } catch (e: any) {
      setAuthError(`Sessions error: ${e.message}`);
    }
  }

  if (authError) {
    return (
      <div className="flex items-center justify-center h-screen p-6 text-center">
        <div>
          <div className="text-4xl mb-3">🔒</div>
          <p className="text-[var(--tg-text)] font-medium">{authError}</p>
        </div>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-[var(--tg-hint)] text-sm">Connecting...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen" style={{ background: "var(--tg-bg)" }}>
      {/* Header */}
      <header className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0"
        style={{ background: "var(--tg-secondary-bg)" }}>
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="p-1.5 rounded-lg text-[var(--tg-hint)] hover:bg-black/5 active:bg-black/10"
        >
          ☰
        </button>
        <div className="flex-1 min-w-0">
          {selectedSession ? (
            <>
              <div className="font-semibold text-sm truncate">{selectedSession.project ?? selectedSession.name ?? `#${selectedSession.id}`}</div>
              <div className="text-xs text-[var(--tg-hint)] truncate">{selectedSession.source} · {selectedSession.status}</div>
            </>
          ) : (
            <div className="text-sm text-[var(--tg-hint)]">No session selected</div>
          )}
        </div>
        <StatusDot status={selectedSession?.status} />
      </header>

      {/* Sidebar */}
      {sidebarOpen && (
        <div className="absolute inset-0 z-50 flex">
          <div className="w-72 max-w-[85vw] h-full flex flex-col overflow-hidden"
            style={{ background: "var(--tg-secondary-bg)" }}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-black/10">
              <span className="font-semibold text-sm">Sessions</span>
              <button onClick={() => setSidebarOpen(false)} className="text-[var(--tg-hint)] p-1">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {sessions.length === 0 && (
                <div className="p-4 text-[var(--tg-hint)] text-sm text-center">No sessions</div>
              )}
              {sessions.map((s) => (
                <SessionCard
                  key={s.id}
                  session={s}
                  selected={selectedSession?.id === s.id}
                  onSelect={() => { setSelectedSession(s); setSidebarOpen(false); }}
                  onSwitch={async () => {
                    await api.switchSession(s.id);
                    setSelectedSession(s);
                    setSidebarOpen(false);
                    await loadSessions();
                  }}
                  onDelete={async () => {
                    await api.deleteSession(s.id);
                    if (selectedSession?.id === s.id) setSelectedSession(null);
                    await loadSessions();
                  }}
                />
              ))}
            </div>
            <div className="px-4 py-3 border-t border-black/10">
              <button onClick={loadSessions} className="text-xs text-[var(--tg-link)]">↻ Refresh</button>
            </div>
          </div>
          <div className="flex-1" onClick={() => setSidebarOpen(false)} />
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {!selectedSession ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
            <div className="text-3xl">🤖</div>
            <p className="text-[var(--tg-hint)] text-sm">No active sessions.<br />Start a Claude session to begin.</p>
            <button onClick={() => setSidebarOpen(true)}
              className="mt-2 px-4 py-2 rounded-xl text-sm font-medium"
              style={{ background: "var(--tg-button)", color: "var(--tg-button-text)" }}>
              Browse Sessions
            </button>
          </div>
        ) : (
          <>
            {tab === "git" && <GitBrowser session={selectedSession} />}
            {tab === "permissions" && <PermissionList session={selectedSession} />}
            {tab === "monitor" && <SessionMonitor session={selectedSession} />}
            {tab === "messages" && <MessageHistory session={selectedSession} />}
          </>
        )}
      </div>

      {/* Bottom nav */}
      {selectedSession && (
        <nav className="flex border-t border-black/10 shrink-0"
          style={{ background: "var(--tg-secondary-bg)" }}>
          {([
            ["git", "📁", "Files"],
            ["permissions", "🔑", "Perms"],
            ["messages", "💬", "Messages"],
            ["monitor", "📊", "Monitor"],
          ] as [Tab, string, string][]).map(([t, icon, label]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 flex flex-col items-center py-2 gap-0.5 text-xs ${tab === t ? "text-[var(--tg-button)] font-medium" : "text-[var(--tg-hint)]"}`}
            >
              <span className="text-lg leading-none">{icon}</span>
              {label}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

function StatusDot({ status }: { status?: string }) {
  const color = status === "active" ? "bg-green-500" : status === "terminated" ? "bg-red-400" : "bg-gray-400";
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${color}`} />;
}

interface SessionCardProps {
  session: Session;
  selected: boolean;
  onSelect: () => void;
  onSwitch: () => Promise<void>;
  onDelete: () => Promise<void>;
}

function SessionCard({ session, selected, onSelect, onSwitch, onDelete }: SessionCardProps) {
  const [busy, setBusy] = useState(false);
  const isActive = session.status === "active";
  const canDelete = session.source === "local" && !isActive;
  const sourceBadgeColor = session.source === "remote" ? "text-purple-400 bg-purple-400/10" : session.source === "local" ? "text-blue-400 bg-blue-400/10" : "text-gray-400 bg-gray-400/10";

  const handle = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  }, []);

  return (
    <div className={`border-b border-black/5 ${selected ? "bg-[var(--tg-button)]/10" : ""}`}>
      <button onClick={onSelect} className="w-full text-left px-4 py-2.5 active:bg-black/5">
        <div className="flex items-center gap-2">
          <StatusDot status={session.status} />
          <span className="font-medium text-sm truncate flex-1">
            {session.project ?? session.name ?? `#${session.id}`}
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${sourceBadgeColor}`}>
            {session.source}
          </span>
        </div>
        <div className="text-xs text-[var(--tg-hint)] mt-0.5 pl-4 truncate">
          #{session.id} · {session.status}
        </div>
      </button>
      <div className="flex gap-1 px-4 pb-2">
        {!isActive && (
          <button
            onClick={() => handle(onSwitch)}
            disabled={busy}
            className="text-[10px] px-2 py-1 rounded-lg font-medium text-[var(--tg-button)] bg-[var(--tg-button)]/10 active:bg-[var(--tg-button)]/20 disabled:opacity-40"
          >
            Switch
          </button>
        )}
        {canDelete && (
          <button
            onClick={() => handle(onDelete)}
            disabled={busy}
            className="text-[10px] px-2 py-1 rounded-lg font-medium text-red-400 bg-red-400/10 active:bg-red-400/20 disabled:opacity-40"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
