import { useState, useEffect, useCallback } from "react";
import { api, type Session } from "../api";

type TimelineItem = {
  kind: "message" | "tool";
  id: number;
  actor: string;
  content: string;
  response: string | null;
  created_at: string;
};

type FilterType = "all" | "messages" | "tools";

interface Props { session: Session }

function relativeTime(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function ResponseBadge({ response }: { response: string | null }) {
  if (response === "allow") return <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />;
  if (response === "deny") return <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />;
  return <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 shrink-0" />;
}

const PAGE = 100;

export function SessionTimeline({ session }: Props) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<FilterType>("all");

  const load = useCallback(async (off = 0, prepend = false) => {
    try {
      const res = await api.sessionTimeline(session.id, PAGE, off);
      setItems((prev) => prepend ? [...res.items, ...prev] : res.items);
      setTotal(res.total);
      setOffset(off);
    } catch {}
    setLoading(false);
    setLoadingMore(false);
  }, [session.id]);

  useEffect(() => {
    setLoading(true);
    setItems([]);
    setOffset(0);
    load(0);
  }, [load]);

  // Auto-refresh every 5s (only refresh from current position)
  useEffect(() => {
    const t = setInterval(() => load(0), 5000);
    return () => clearInterval(t);
  }, [load]);

  async function loadOlder() {
    const newOffset = offset + PAGE;
    if (newOffset >= total) return;
    setLoadingMore(true);
    await load(newOffset, true);
  }

  const filtered = items.filter((item) => {
    if (filter === "messages") return item.kind === "message";
    if (filter === "tools") return item.kind === "tool";
    return true;
  });

  if (loading) {
    return <div className="flex items-center justify-center h-full text-[var(--tg-hint)] text-sm">Loading...</div>;
  }

  const hasMore = offset + PAGE < total;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Filter bar */}
      <div className="flex gap-1.5 px-3 py-2 border-b border-black/5 shrink-0" style={{ background: "var(--tg-secondary-bg)" }}>
        {(["all", "messages", "tools"] as FilterType[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              filter === f
                ? "bg-[var(--tg-button)] text-[var(--tg-button-text)]"
                : "text-[var(--tg-hint)] bg-black/5"
            }`}
          >
            {f === "all" ? "All" : f === "messages" ? "Messages" : "Tools"}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-[var(--tg-hint)] self-center">{total} total</span>
      </div>

      {/* Timeline list */}
      <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-2">
        {/* Load older */}
        {hasMore && (
          <button
            onClick={loadOlder}
            disabled={loadingMore}
            className="self-center text-xs text-[var(--tg-link)] py-1 disabled:opacity-40"
          >
            {loadingMore ? "Loading..." : `↑ Load older (${total - offset - PAGE} more)`}
          </button>
        )}

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center flex-1 gap-2 text-[var(--tg-hint)] text-sm">
            <div className="text-2xl">🕐</div>
            <div>No timeline data yet</div>
          </div>
        ) : (
          filtered.map((item) =>
            item.kind === "message" ? (
              <MessageItem key={`msg-${item.id}`} item={item} />
            ) : (
              <ToolItem key={`tool-${item.id}`} item={item} />
            )
          )
        )}
      </div>
    </div>
  );
}

function MessageItem({ item }: { item: TimelineItem }) {
  const isUser = item.actor === "user";
  const isAssistant = item.actor === "assistant";
  const isSystem = item.actor === "system";
  const [expanded, setExpanded] = useState(false);

  if (isSystem) {
    return (
      <div className="flex flex-col items-center gap-0.5">
        <span className="text-[9px] text-[var(--tg-hint)]">{formatTime(item.created_at)}</span>
        <div className="text-[10px] text-[var(--tg-hint)] text-center px-3 py-1 bg-black/5 rounded-full max-w-[85%] truncate">
          {item.content.slice(0, 120)}
        </div>
      </div>
    );
  }

  const content = item.content ?? "";
  const truncated = content.length > 400 && !expanded;
  const displayText = truncated ? content.slice(0, 400) + "…" : content;

  return (
    <div className={`flex flex-col gap-0.5 ${isUser ? "items-end" : "items-start"}`}>
      <div className="flex items-center gap-1.5">
        <span className={`text-[10px] font-medium ${isUser ? "text-blue-400" : "text-green-500"}`}>
          {item.actor}
        </span>
        <span className="text-[10px] text-[var(--tg-hint)]">{relativeTime(item.created_at)}</span>
      </div>
      <div
        className={`max-w-[85%] px-3 py-2 rounded-2xl text-xs leading-relaxed cursor-pointer
          ${isUser
            ? "bg-[var(--tg-button)] text-[var(--tg-button-text)] rounded-tr-sm"
            : "bg-black/8 dark:bg-white/8 text-[var(--tg-text)] rounded-tl-sm"
          }`}
        onClick={() => setExpanded(!expanded)}
      >
        <pre className="whitespace-pre-wrap font-sans break-words">{displayText}</pre>
        {truncated && (
          <span className="text-[10px] opacity-60 mt-1 block">tap to expand</span>
        )}
      </div>
    </div>
  );
}

function ToolItem({ item }: { item: TimelineItem }) {
  const desc = item.content ?? "";
  const truncatedDesc = desc.length > 80 ? desc.slice(0, 80) + "…" : desc;

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-xl bg-black/3 dark:bg-white/3 text-xs">
      <ResponseBadge response={item.response} />
      <code className="font-mono text-[10px] text-[var(--tg-text)] shrink-0 px-1.5 py-0.5 bg-black/5 rounded">
        🔧 {item.actor}
      </code>
      <span className="flex-1 text-[var(--tg-hint)] truncate text-[10px]">{truncatedDesc}</span>
      <span className="text-[var(--tg-hint)] shrink-0 text-[10px]">{relativeTime(item.created_at)}</span>
    </div>
  );
}
