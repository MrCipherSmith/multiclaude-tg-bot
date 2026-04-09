import { useState, useEffect, useCallback, useRef } from "react";
import { api, type Session } from "../api";

interface Message {
  id: number;
  role: string;
  content: string;
  created_at: string;
}

interface Props { session: Session }

function relativeTime(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const PAGE = 30;

export function MessageHistory({ session }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (off = 0, append = false) => {
    try {
      const res = await api.sessionMessages(session.id, PAGE, off);
      // API returns newest first — reverse for chronological display
      const ordered = [...res.messages].reverse();
      setMessages((prev) => append ? [...ordered, ...prev] : ordered);
      setTotal(res.total);
      setOffset(off);
    } catch {}
    setLoading(false);
    setLoadingMore(false);
  }, [session.id]);

  useEffect(() => {
    setLoading(true);
    setMessages([]);
    setOffset(0);
    load(0);
  }, [load]);

  // Auto-scroll to bottom on first load
  useEffect(() => {
    if (!loading) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [loading]);

  // Poll for new messages every 5s
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

  if (loading) {
    return <div className="flex items-center justify-center h-full text-[var(--tg-hint)] text-sm">Loading...</div>;
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--tg-hint)] text-sm">
        <div className="text-2xl">💬</div>
        <div>No messages yet</div>
      </div>
    );
  }

  const hasMore = offset + PAGE < total;

  return (
    <div className="flex flex-col h-full overflow-y-auto px-3 py-2 gap-2">
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

      {/* Total count */}
      <div className="text-center text-[10px] text-[var(--tg-hint)]">{total} messages total</div>

      {/* Messages */}
      {messages.map((msg) => (
        <MessageBubble key={msg.id} msg={msg} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  const isAssistant = msg.role === "assistant";
  const [expanded, setExpanded] = useState(false);

  const content = msg.content ?? "";
  const truncated = content.length > 400 && !expanded;
  const displayText = truncated ? content.slice(0, 400) + "…" : content;

  return (
    <div className={`flex flex-col gap-0.5 ${isUser ? "items-end" : "items-start"}`}>
      <div className="flex items-center gap-1.5">
        <span className={`text-[10px] font-medium ${isUser ? "text-blue-400" : isAssistant ? "text-green-500" : "text-gray-400"}`}>
          {msg.role}
        </span>
        <span className="text-[10px] text-[var(--tg-hint)]">{relativeTime(msg.created_at)}</span>
      </div>
      <div
        className={`max-w-[85%] px-3 py-2 rounded-2xl text-xs leading-relaxed cursor-pointer
          ${isUser
            ? "bg-[var(--tg-button)] text-[var(--tg-button-text)] rounded-tr-sm"
            : isAssistant
            ? "bg-black/8 dark:bg-white/8 text-[var(--tg-text)] rounded-tl-sm"
            : "bg-yellow-500/10 text-[var(--tg-text)] rounded-tl-sm"
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
