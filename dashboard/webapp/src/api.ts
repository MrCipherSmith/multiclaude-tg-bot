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
  },

  permissions: {
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
