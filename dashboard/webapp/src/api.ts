export interface Session {
  id: number;
  name: string | null;
  project: string | null;
  project_path: string | null;
  source: "remote" | "local" | "standalone";
  status: "active" | "inactive" | "terminated";
  last_active: string;
}

export interface SessionTokens {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  api_calls: number;
}

export interface RecentTool {
  tool_name: string;
  response: string | null;
  created_at: string;
}

export interface SessionDetail extends Session {
  connected_at: string;
  message_count: number;
  tokens: SessionTokens;
  recent_tools: RecentTool[];
}

export interface GitCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitStatusFile {
  status: string;
  file: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string;
  author_avatar: string;
  head: string;
  base: string;
  created_at: string;
  updated_at: string;
  body: string;
  html_url: string;
  head_sha: string;
  comments: number;
  review_comments: number;
  additions: number;
  deletions: number;
  changed_files: number;
}

export interface GitHubReview {
  id: number;
  author: string;
  author_avatar: string;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED
  body: string;
  submitted_at: string;
}

export interface GitHubComment {
  id: number;
  author: string;
  author_avatar: string;
  body: string;
  path: string;
  line: number;
  created_at: string;
  diff_hunk: string;
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | neutral | cancelled | skipped | timed_out
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
}

export interface PermissionRequest {
  id: number;
  tool_name: string;
  description: string;
  request_id: string;
  created_at: string;
}

const BASE = "";
let _token = "";

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (_token) headers["Authorization"] = `Bearer ${_token}`;
  const r = await fetch(BASE + path, {
    credentials: "include",
    headers: { ...headers, ...(opts?.headers as Record<string, string> ?? {}) },
    ...opts,
  });
  if (!r.ok) throw new Error(await r.text());
  if (r.status === 204) return undefined as T;
  return r.json();
}

export const api = {
  authWebApp: async (initData: string) => {
    const data = await req<{ ok: boolean; user: { id: number; first_name: string }; token: string }>("/api/auth/webapp", {
      method: "POST",
      body: JSON.stringify({ initData }),
    });
    if (data.token) _token = data.token;
    return data;
  },

  sessions: () => req<Session[]>("/api/sessions"),
  activeSession: () => req<Session | null>("/api/sessions/active"),
  session: (id: number) => req<SessionDetail>(`/api/sessions/${id}`),
  sessionMessages: (id: number, limit = 50, offset = 0) =>
    req<{ messages: { id: number; role: string; content: string; created_at: string }[]; total: number }>(
      `/api/sessions/${id}/messages?limit=${limit}&offset=${offset}`
    ),
  sessionTimeline: (id: number, limit = 100, offset = 0) =>
    req<{
      items: { kind: "message" | "tool"; id: number; actor: string; content: string; response: string | null; created_at: string }[];
      total: number;
      limit: number;
      offset: number;
    }>(`/api/sessions/${id}/timeline?limit=${limit}&offset=${offset}`),

  globalStats: () =>
    req<{
      api: Record<string, {
        summary: { total: number; success: number; errors: number; input_tokens: number; output_tokens: number; total_tokens: number; avg_latency_ms: number; estimated_cost: number };
        byProvider: { provider: string; model: string; requests: number; input_tokens: number; output_tokens: number; tokens: number; avg_ms: number; cost: number }[];
      }>;
    }>("/api/stats"),
  claudeCodeUsage: (days = 30) =>
    req<{
      byModel: { model: string; requests: number; input_tokens: number; cache_creation_tokens: number; cache_read_tokens: number; output_tokens: number; cost_usd: number }[];
      total_requests: number; total_input: number; total_cache_creation: number; total_cache_read: number; total_output: number; total_cost_usd: number; scanned_files: number;
    }>(`/api/stats/claude-code?days=${days}`),
  switchSession: (id: number) => req<{ ok: boolean }>(`/api/sessions/${id}/switch`, { method: "POST", body: "{}" }),
  deleteSession: (id: number) => req<void>(`/api/sessions/${id}`, { method: "DELETE" }),

  git: {
    tree: (sessionId: number) =>
      req<{ files: string[] }>(`/api/git/${sessionId}/tree`),
    file: (sessionId: number, path: string, ref = "HEAD") =>
      req<{ content: string }>(`/api/git/${sessionId}/file?path=${encodeURIComponent(path)}&ref=${ref}`),
    diff: (sessionId: number, ref = "HEAD~1", path?: string) =>
      req<{ diff: string }>(`/api/git/${sessionId}/diff?ref=${encodeURIComponent(ref)}${path ? `&path=${encodeURIComponent(path)}` : ""}`),
    log: (sessionId: number, limit = 50) =>
      req<{ commits: GitCommit[] }>(`/api/git/${sessionId}/log?limit=${limit}`),
    status: (sessionId: number) =>
      req<{ files: GitStatusFile[] }>(`/api/git/${sessionId}/status`),
    branches: (sessionId: number) =>
      req<{ branches: { name: string; current: boolean }[] }>(`/api/git/${sessionId}/branches`),
    commitDiff: (sessionId: number, hash: string) =>
      req<{ diff: string }>(`/api/git/${sessionId}/commit/${hash}`),
    prs: (sessionId: number, params?: { author?: string; draft?: boolean }) => {
      const q = new URLSearchParams();
      if (params?.author) q.set("author", params.author);
      if (params?.draft !== undefined) q.set("draft", String(params.draft));
      return req<{ prs: GitHubPR[]; repo: { owner: string; repo: string } }>(`/api/git/${sessionId}/prs?${q}`);
    },
    prDetail: (sessionId: number, prNumber: number) =>
      req<{
        pr: GitHubPR;
        reviews: GitHubReview[];
        comments: GitHubComment[];
        checks: GitHubCheckRun[];
      }>(`/api/git/${sessionId}/prs/${prNumber}`),
  },

  permissions: {
    stats: (sessionId?: number, days = 30) =>
      req<{
        summary: { total: number; allowed: number; denied: number; always_allowed: number; pending: number };
        top_tools: { tool_name: string; total: number; allowed: number; denied: number; always_allowed: number }[];
        days: number;
        session_id: number | null;
      }>(`/api/permissions/stats?days=${days}${sessionId ? `&session_id=${sessionId}` : ""}`),
    list: (sessionId: number) => req<PermissionRequest[]>(`/api/permissions/${sessionId}`),
    respond: (id: number, response: "allow" | "deny") =>
      req<{ ok: boolean }>(`/api/permissions/${id}/respond`, {
        method: "POST",
        body: JSON.stringify({ response }),
      }),
    always: (id: number) =>
      req<{ ok: boolean }>(`/api/permissions/${id}/always`, { method: "POST", body: "{}" }),
  },
};
