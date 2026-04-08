export interface Session {
  id: number;
  name: string | null;
  project: string | null;
  project_path: string | null;
  source: "remote" | "local" | "standalone";
  status: "active" | "inactive" | "terminated";
  last_active: string;
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

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    ...opts,
  });
  if (!r.ok) throw new Error(await r.text());
  if (r.status === 204) return undefined as T;
  return r.json();
}

export const api = {
  authWebApp: (initData: string) =>
    req<{ ok: boolean; user: { id: number; first_name: string } }>("/api/auth/webapp", {
      method: "POST",
      body: JSON.stringify({ initData }),
    }),

  sessions: () => req<Session[]>("/api/sessions"),

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
