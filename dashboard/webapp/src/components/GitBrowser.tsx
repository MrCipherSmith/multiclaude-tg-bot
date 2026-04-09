import { useState, useEffect, useCallback, useMemo } from "react";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import { api, type Session, type GitCommit, type GitStatusFile } from "../api";
import { PRList } from "./PRList";
import { getFileIcon, getLang } from "../utils/fileIcons";

// Register languages
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);

type GitTab = "files" | "log" | "status" | "prs";
interface Props { session: Session }

// --- Tree structure ---
interface TreeNode {
  name: string;
  path: string;
  isFile: boolean;
  children: TreeNode[];
}

function buildTree(files: string[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const file of files) {
    const parts = file.split("/");
    let current = root;
    let cumPath = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      cumPath = cumPath ? `${cumPath}/${part}` : part;
      const isFile = i === parts.length - 1;
      let node = current.find((n) => n.name === part);
      if (!node) {
        node = { name: part, path: cumPath, isFile, children: [] };
        current.push(node);
      }
      current = node.children;
    }
  }

  return sortTree(root);
}

function sortTree(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name);
    })
    .map((n) => ({ ...n, children: sortTree(n.children) }));
}

function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  if (!query) return nodes;
  const q = query.toLowerCase();
  const result: TreeNode[] = [];
  for (const node of nodes) {
    if (node.isFile) {
      if (node.path.toLowerCase().includes(q)) result.push(node);
    } else {
      const filtered = filterTree(node.children, query);
      if (filtered.length > 0) result.push({ ...node, children: filtered });
    }
  }
  return result;
}

// --- Icons ---
function FileIconBadge({ path }: { path: string }) {
  const { icon, color } = getFileIcon(path);
  const isEmoji = icon.length <= 2 && /\p{Emoji}/u.test(icon);
  if (isEmoji) {
    return <span className="text-sm shrink-0 w-5 text-center">{icon}</span>;
  }
  return (
    <span
      className="text-[9px] font-bold shrink-0 w-6 text-center rounded-sm py-px leading-none"
      style={{ color, border: `1px solid ${color}33`, background: `${color}18` }}
    >
      {icon}
    </span>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 16 16" fill="none">
      {open ? (
        <path d="M1 4h14v9H1V4z M1 4l2-2h4l1 2" fill="#e8c32c" stroke="#b89020" strokeWidth="0.5" />
      ) : (
        <path d="M1 5h14v8H1V5z M1 5l2-2h4l1 2" fill="#dcaa1c" stroke="#b89020" strokeWidth="0.5" />
      )}
    </svg>
  );
}

// --- Syntax highlighted file viewer ---
function CodeViewer({ content, path }: { content: string; path: string }) {
  const highlighted = useMemo(() => {
    const lang = getLang(path);
    try {
      if (lang !== "plaintext" && hljs.getLanguage(lang)) {
        return hljs.highlight(content, { language: lang }).value;
      }
    } catch {}
    return hljs.highlightAuto(content).value;
  }, [content, path]);

  return (
    <div className="overflow-auto h-full">
      <style>{`
        .hljs-keyword { color: #c792ea; }
        .hljs-string { color: #c3e88d; }
        .hljs-comment { color: #546e7a; font-style: italic; }
        .hljs-number { color: #f78c6c; }
        .hljs-built_in { color: #82aaff; }
        .hljs-title { color: #82aaff; }
        .hljs-attr { color: #ffcb6b; }
        .hljs-type { color: #ffcb6b; }
        .hljs-params { color: #eeffff; }
        .hljs-variable { color: #eeffff; }
        .hljs-tag { color: #f07178; }
        .hljs-name { color: #f07178; }
        .hljs-meta { color: #546e7a; }
        .hljs-literal { color: #f78c6c; }
        .hljs-symbol { color: #89ddff; }
        .hljs-punctuation { color: #89ddff; }
        .hljs-property { color: #ffcb6b; }
        .hljs-section { color: #82aaff; font-weight: bold; }
        .hljs-addition { color: #c3e88d; background: #00800015; }
        .hljs-deletion { color: #f07178; background: #ff000015; }
      `}</style>
      <table className="min-w-full text-xs font-mono">
        <tbody>
          {content.split("\n").map((_, i) => {
            const lines = highlighted.split("\n");
            return (
              <tr key={i} className="leading-5 hover:bg-white/5">
                <td className="select-none text-right pr-3 pl-2 text-[10px] opacity-30 w-8 border-r border-white/5">
                  {i + 1}
                </td>
                <td
                  className="px-3 whitespace-pre-wrap break-all"
                  dangerouslySetInnerHTML={{ __html: lines[i] ?? "" }}
                />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Tree node component ---
function TreeNodeItem({
  node,
  onFile,
  defaultOpen,
}: {
  node: TreeNode;
  onFile: (path: string) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => { setOpen(defaultOpen); }, [defaultOpen]);

  if (node.isFile) {
    return (
      <button
        onClick={() => onFile(node.path)}
        className="w-full text-left flex items-center gap-1.5 px-2 py-1 active:bg-white/10 hover:bg-white/5 rounded-sm"
        title={node.path}
      >
        <FileIconBadge path={node.path} />
        <span className="text-xs truncate">{node.name}</span>
      </button>
    );
  }

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left flex items-center gap-1.5 px-2 py-1 active:bg-white/10 hover:bg-white/5 rounded-sm"
      >
        <span className="text-[10px] opacity-40 w-3 shrink-0">{open ? "▾" : "▸"}</span>
        <FolderIcon open={open} />
        <span className="text-xs font-medium truncate">{node.name}</span>
      </button>
      {open && (
        <div className="pl-3 border-l border-white/5 ml-3">
          {node.children.map((child) => (
            <TreeNodeItem key={child.path} node={child} onFile={onFile} defaultOpen={defaultOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

// --- FileTree tab ---
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
    setSelected(null);
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

  const tree = useMemo(() => buildTree(files), [files]);
  const displayed = useMemo(() => filterTree(tree, filter), [tree, filter]);
  const isFiltering = filter.length > 0;

  if (selected !== null) {
    return (
      <div className="flex flex-col h-full bg-[#1e1e2e]">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 shrink-0 bg-[#2a2a3e]">
          <button onClick={() => setSelected(null)} className="text-blue-400 text-sm shrink-0">← Back</button>
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <FileIconBadge path={selected} />
            <span className="text-xs text-white/60 truncate">{selected}</span>
          </div>
        </div>
        <div className="flex-1 overflow-hidden text-white/90">
          {fileLoading
            ? <div className="text-white/40 text-sm text-center pt-8">Loading...</div>
            : fileContent !== null && <CodeViewer content={fileContent} path={selected} />}
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
          placeholder="🔍  Search files..."
          className="w-full px-2.5 py-1.5 text-sm rounded-lg outline-none placeholder:opacity-40"
          style={{ background: "var(--tg-secondary-bg)" }}
        />
      </div>
      <div className="flex-1 overflow-y-auto px-1 py-1">
        {loading && <div className="p-4 text-center text-sm opacity-40">Loading tree...</div>}
        {error && <div className="p-4 text-red-500 text-sm">{error}</div>}
        {!loading && displayed.length === 0 && !error && (
          <div className="p-4 text-center text-sm opacity-40">
            {isFiltering ? "No files match" : "No files"}
          </div>
        )}
        {displayed.map((node) => (
          <TreeNodeItem key={node.path} node={node} onFile={openFile} defaultOpen={isFiltering} />
        ))}
      </div>
    </div>
  );
}

// --- CommitLog tab ---
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
          <button onClick={() => setSelected(null)} className="text-[var(--tg-link)] text-sm shrink-0">← Back</button>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium truncate">{selected.subject}</div>
            <div className="text-xs opacity-50">{selected.author} · {selected.date} · <code>{selected.short}</code></div>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-3">
          {diffLoading
            ? <div className="opacity-40 text-sm text-center pt-8">Loading diff...</div>
            : <DiffView diff={diff ?? ""} />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {loading && <div className="p-4 opacity-40 text-sm text-center">Loading log...</div>}
      {error && <div className="p-4 text-red-500 text-sm">{error}</div>}
      {commits.map((c) => (
        <button key={c.hash} onClick={() => openCommit(c)}
          className="w-full text-left px-3 py-2.5 border-b border-black/5 active:bg-black/5 hover:bg-black/3">
          <div className="flex items-start gap-2">
            <div className="shrink-0 mt-0.5 w-6 h-6 rounded-full bg-[var(--tg-button)]/20 flex items-center justify-center">
              <svg className="w-3 h-3" viewBox="0 0 12 12" fill="var(--tg-button)">
                <circle cx="6" cy="6" r="2.5"/>
                <line x1="0" y1="6" x2="3.5" y2="6" stroke="var(--tg-button)" strokeWidth="1"/>
                <line x1="8.5" y1="6" x2="12" y2="6" stroke="var(--tg-button)" strokeWidth="1"/>
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate">{c.subject}</div>
              <div className="flex items-center gap-2 mt-0.5">
                <code className="text-[10px] opacity-50 bg-black/10 px-1 rounded">{c.short}</code>
                <span className="text-[10px] opacity-40">{c.author}</span>
                <span className="text-[10px] opacity-30 ml-auto">{c.date}</span>
              </div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

// --- GitStatus tab ---
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
          <button onClick={() => setSelected(null)} className="text-[var(--tg-link)] text-sm shrink-0">← Back</button>
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <FileIconBadge path={selected} />
            <span className="text-xs opacity-60 truncate">{selected}</span>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-3">
          {diffLoading
            ? <div className="opacity-40 text-sm text-center pt-8">Loading diff...</div>
            : <DiffView diff={diff ?? ""} />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-black/10 shrink-0">
        <span className="text-xs opacity-50">{loading ? "Loading..." : `${files.length} changed`}</span>
        <button onClick={load} className="text-xs text-[var(--tg-link)]">↻ Refresh</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {error && <div className="p-4 text-red-500 text-sm">{error}</div>}
        {!loading && files.length === 0 && !error && (
          <div className="p-4 opacity-40 text-sm text-center">Clean working tree ✓</div>
        )}
        {files.map((f) => (
          <button key={f.file} onClick={() => openDiff(f.file)}
            className="w-full text-left px-3 py-2 border-b border-black/5 active:bg-black/5 hover:bg-black/3 flex items-center gap-2">
            <StatusBadge status={f.status} />
            <FileIconBadge path={f.file} />
            <span className="text-xs font-mono truncate flex-1">{f.file}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Shared components ---
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    M: ["M", "#f59e0b"], A: ["A", "#22c55e"], D: ["D", "#ef4444"],
    R: ["R", "#3b82f6"], "?": ["?", "#9ca3af"], U: ["U", "#a855f7"],
  };
  const [label, color] = map[status[0]] ?? ["?", "#9ca3af"];
  return (
    <span className="text-[10px] font-bold shrink-0 w-5 h-5 flex items-center justify-center rounded"
      style={{ color, background: `${color}25`, border: `1px solid ${color}50` }}>
      {label}
    </span>
  );
}

function DiffView({ diff }: { diff: string }) {
  if (!diff) return <div className="opacity-40 text-sm text-center pt-4">No diff</div>;
  const lines = diff.split("\n");
  return (
    <div className="text-xs font-mono leading-5">
      {lines.map((line, i) => {
        const isAdd = line.startsWith("+") && !line.startsWith("+++");
        const isDel = line.startsWith("-") && !line.startsWith("---");
        const isHunk = line.startsWith("@@");
        const isMeta = line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++");
        return (
          <div key={i}
            className={`px-2 whitespace-pre-wrap break-all ${isAdd ? "bg-green-500/10 text-green-400" : isDel ? "bg-red-500/10 text-red-400" : isHunk ? "text-blue-400 bg-blue-500/5" : isMeta ? "opacity-40" : ""}`}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

// --- Main component ---
export function GitBrowser({ session }: Props) {
  const [gitTab, setGitTab] = useState<GitTab>("files");
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    api.git.branches(session.id)
      .then((r) => {
        const current = r.branches.find((b) => b.current);
        setBranch(current?.name ?? null);
      })
      .catch(() => {});
  }, [session.id]);

  const tabs: { id: GitTab; label: string; icon: string }[] = [
    { id: "files", label: "Files", icon: "📁" },
    { id: "log", label: "Log", icon: "🕐" },
    { id: "status", label: "Changes", icon: "✎" },
    { id: "prs", label: "PRs", icon: "🔀" },
  ];

  return (
    <div className="flex flex-col h-full">
      {branch && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-black/10 shrink-0"
          style={{ background: "var(--tg-secondary-bg)" }}>
          <svg className="w-3 h-3 opacity-50 shrink-0" viewBox="0 0 16 16" fill="currentColor">
            <path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM4.25 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z"/>
          </svg>
          <span className="text-xs font-mono opacity-70 truncate">{branch}</span>
        </div>
      )}
      <div className="flex border-b border-black/10 shrink-0" style={{ background: "var(--tg-secondary-bg)" }}>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setGitTab(t.id)}
            className={`flex-1 py-2 text-xs font-medium flex items-center justify-center gap-1 ${
              gitTab === t.id ? "text-[var(--tg-button)] border-b-2 border-[var(--tg-button)]" : "opacity-50"
            }`}>
            <span>{t.icon}</span> {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden">
        {gitTab === "files" && <FileTree session={session} />}
        {gitTab === "log" && <CommitLog session={session} />}
        {gitTab === "status" && <GitStatus session={session} />}
        {gitTab === "prs" && <PRList session={session} />}
      </div>
    </div>
  );
}
