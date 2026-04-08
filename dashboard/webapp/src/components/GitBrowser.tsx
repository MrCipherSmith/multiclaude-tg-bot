import { useState, useEffect, useCallback } from "react";
import { api, type Session, type GitCommit, type GitStatusFile } from "../api";

type GitTab = "files" | "log" | "status";

interface Props { session: Session }

export function GitBrowser({ session }: Props) {
  const [gitTab, setGitTab] = useState<GitTab>("files");

  return (
    <div className="flex flex-col h-full">
      {/* Git sub-tabs */}
      <div className="flex border-b border-black/10 shrink-0"
        style={{ background: "var(--tg-secondary-bg)" }}>
        {(["files", "log", "status"] as GitTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setGitTab(t)}
            className={`flex-1 py-2 text-xs font-medium capitalize ${gitTab === t
              ? "text-[var(--tg-button)] border-b-2 border-[var(--tg-button)]"
              : "text-[var(--tg-hint)]"}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden">
        {gitTab === "files" && <FileTree session={session} />}
        {gitTab === "log" && <CommitLog session={session} />}
        {gitTab === "status" && <GitStatus session={session} />}
      </div>
    </div>
  );
}

function FileTree({ session }: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError("");
    api.git.tree(session.id)
      .then((r) => setFiles(r.files))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [session.id]);

  const openFile = useCallback(async (path: string) => {
    setSelected(path);
    setFileContent(null);
    setFileLoading(true);
    try {
      const r = await api.git.file(session.id, path);
      setFileContent(r.content);
    } catch (e: any) {
      setFileContent(`Error: ${e.message}`);
    } finally {
      setFileLoading(false);
    }
  }, [session.id]);

  const filtered = filter
    ? files.filter((f) => f.toLowerCase().includes(filter.toLowerCase()))
    : files;

  if (selected !== null) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-black/10 shrink-0"
          style={{ background: "var(--tg-secondary-bg)" }}>
          <button onClick={() => setSelected(null)} className="text-[var(--tg-link)] text-sm">← Back</button>
          <span className="text-xs text-[var(--tg-hint)] truncate flex-1">{selected}</span>
        </div>
        <div className="flex-1 overflow-auto p-3">
          {fileLoading
            ? <div className="text-[var(--tg-hint)] text-sm text-center pt-8">Loading...</div>
            : <pre className="text-xs whitespace-pre-wrap break-words">{fileContent}</pre>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-black/10 shrink-0">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search files..."
          className="w-full px-2 py-1.5 text-sm rounded-lg bg-black/5 outline-none placeholder:text-[var(--tg-hint)]"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && <div className="p-4 text-[var(--tg-hint)] text-sm text-center">Loading tree...</div>}
        {error && <div className="p-4 text-red-500 text-sm">{error}</div>}
        {filtered.map((f) => (
          <button
            key={f}
            onClick={() => openFile(f)}
            className="w-full text-left px-3 py-2 text-xs border-b border-black/5 active:bg-black/5 font-mono truncate"
          >
            {f}
          </button>
        ))}
        {!loading && filtered.length === 0 && !error && (
          <div className="p-4 text-[var(--tg-hint)] text-sm text-center">No files found</div>
        )}
      </div>
    </div>
  );
}

function CommitLog({ session }: Props) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<GitCommit | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.git.log(session.id)
      .then((r) => setCommits(r.commits))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [session.id]);

  const openCommit = async (commit: GitCommit) => {
    setSelected(commit);
    setDiff(null);
    setDiffLoading(true);
    try {
      const r = await api.git.commitDiff(session.id, commit.hash);
      setDiff(r.diff);
    } catch (e: any) {
      setDiff(`Error: ${e.message}`);
    } finally {
      setDiffLoading(false);
    }
  };

  if (selected) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-black/10 shrink-0"
          style={{ background: "var(--tg-secondary-bg)" }}>
          <button onClick={() => setSelected(null)} className="text-[var(--tg-link)] text-sm">← Back</button>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium truncate">{selected.short} — {selected.subject}</div>
            <div className="text-xs text-[var(--tg-hint)]">{selected.author} · {selected.date}</div>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-3">
          {diffLoading
            ? <div className="text-[var(--tg-hint)] text-sm text-center pt-8">Loading diff...</div>
            : <DiffView diff={diff ?? ""} />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {loading && <div className="p-4 text-[var(--tg-hint)] text-sm text-center">Loading log...</div>}
      {error && <div className="p-4 text-red-500 text-sm">{error}</div>}
      {commits.map((c) => (
        <button
          key={c.hash}
          onClick={() => openCommit(c)}
          className="w-full text-left px-3 py-2.5 border-b border-black/5 active:bg-black/5"
        >
          <div className="flex items-start gap-2">
            <code className="text-xs text-[var(--tg-hint)] shrink-0 mt-0.5">{c.short}</code>
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate">{c.subject}</div>
              <div className="text-xs text-[var(--tg-hint)]">{c.author} · {c.date}</div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

function GitStatus({ session }: Props) {
  const [files, setFiles] = useState<GitStatusFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.git.status(session.id)
      .then((r) => setFiles(r.files))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [session.id]);

  useEffect(load, [load]);

  const openDiff = async (file: string) => {
    setSelected(file);
    setDiff(null);
    setDiffLoading(true);
    try {
      const r = await api.git.diff(session.id, "HEAD", file);
      setDiff(r.diff || "(no diff)");
    } catch (e: any) {
      setDiff(`Error: ${e.message}`);
    } finally {
      setDiffLoading(false);
    }
  };

  if (selected) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-black/10 shrink-0"
          style={{ background: "var(--tg-secondary-bg)" }}>
          <button onClick={() => setSelected(null)} className="text-[var(--tg-link)] text-sm">← Back</button>
          <span className="text-xs text-[var(--tg-hint)] truncate flex-1">{selected}</span>
        </div>
        <div className="flex-1 overflow-auto p-3">
          {diffLoading
            ? <div className="text-[var(--tg-hint)] text-sm text-center pt-8">Loading diff...</div>
            : <DiffView diff={diff ?? ""} />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-black/10 shrink-0">
        <span className="text-xs text-[var(--tg-hint)]">{files.length} changed files</span>
        <button onClick={load} className="text-xs text-[var(--tg-link)]">↻ Refresh</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && <div className="p-4 text-[var(--tg-hint)] text-sm text-center">Loading status...</div>}
        {error && <div className="p-4 text-red-500 text-sm">{error}</div>}
        {!loading && files.length === 0 && !error && (
          <div className="p-4 text-[var(--tg-hint)] text-sm text-center">Clean working tree</div>
        )}
        {files.map((f) => (
          <button
            key={f.file}
            onClick={() => openDiff(f.file)}
            className="w-full text-left px-3 py-2 border-b border-black/5 active:bg-black/5 flex items-center gap-2"
          >
            <StatusBadge status={f.status} />
            <span className="text-xs font-mono truncate">{f.file}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    M: "bg-yellow-500",
    A: "bg-green-500",
    D: "bg-red-500",
    R: "bg-blue-500",
    "?": "bg-gray-400",
  };
  const color = colors[status[0]] ?? "bg-gray-400";
  return (
    <span className={`inline-flex items-center justify-center w-5 h-5 rounded text-white text-xs font-bold shrink-0 ${color}`}>
      {status[0]}
    </span>
  );
}

function DiffView({ diff }: { diff: string }) {
  if (!diff) return <div className="text-[var(--tg-hint)] text-sm text-center pt-4">No diff</div>;

  const lines = diff.split("\n");
  return (
    <pre className="text-xs leading-5 whitespace-pre-wrap break-all">
      {lines.map((line, i) => {
        let cls = "";
        if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-green-600";
        else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-red-500";
        else if (line.startsWith("@@")) cls = "text-blue-500";
        else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) cls = "text-[var(--tg-hint)]";
        return <span key={i} className={cls}>{line}{"\n"}</span>;
      })}
    </pre>
  );
}
