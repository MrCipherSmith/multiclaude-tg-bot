const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Auth
  authMe: () => request<AuthUser>('/auth/me'),
  authTelegram: (data: TelegramLoginData) =>
    request<AuthUser>('/auth/telegram', { method: 'POST', body: JSON.stringify(data) }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  // Overview
  overview: () => request<Overview>('/overview'),

  // Sessions
  sessions: () => request<Session[]>('/sessions'),
  session: (id: number) => request<SessionDetail>(`/sessions/${id}`),
  sessionMessages: (id: number, limit = 50, offset = 0) =>
    request<PaginatedMessages>(`/sessions/${id}/messages?limit=${limit}&offset=${offset}`),
  deleteSession: (id: number) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),
  renameSession: (id: number, name: string) =>
    request<Session>(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),

  // Stats
  stats: () => request<Stats>('/stats'),
  dailyStats: (days = 30) => request<DailyStats[]>(`/stats/daily?days=${days}`),
  recentErrors: (limit = 20) => request<ApiError[]>(`/stats/errors?limit=${limit}`),

  // Logs
  logs: (params?: LogsParams) => {
    const q = new URLSearchParams();
    if (params?.session_id) q.set('session_id', String(params.session_id));
    if (params?.level) q.set('level', params.level);
    if (params?.search) q.set('search', params.search);
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.offset) q.set('offset', String(params.offset));
    return request<PaginatedLogs>(`/logs?${q}`);
  },

  // Memories
  memories: (params?: MemoriesParams) => {
    const q = new URLSearchParams();
    if (params?.type) q.set('type', params.type);
    if (params?.project_path) q.set('project_path', params.project_path);
    if (params?.search) q.set('search', params.search);
    if (params?.tag) q.set('tag', params.tag);
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.offset) q.set('offset', String(params.offset));
    return request<PaginatedMemories>(`/memories?${q}`);
  },
  deleteMemory: (id: number) => request<void>(`/memories/${id}`, { method: 'DELETE' }),
  memoryTags: () => request<MemoryTag[]>('/memories/tags'),
  deleteMemoriesByTag: (tag: string) => request<{ deleted: number }>(`/memories/tag/${encodeURIComponent(tag)}`, { method: 'DELETE' }),

  // Projects
  projects: () => request<Project[]>('/projects'),
  createProject: (data: { name: string; path: string }) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  startProject: (id: number) => request<{ ok: boolean }>(`/projects/${id}/start`, { method: 'POST' }),
  stopProject: (id: number) => request<{ ok: boolean }>(`/projects/${id}/stop`, { method: 'POST' }),
  deleteProject: (id: number) => request<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
};

// Types

export interface AuthUser {
  id: number;
  first_name: string;
  username?: string;
  photo_url?: string;
}

export interface TelegramLoginData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export interface Overview {
  uptime: number;
  db: string;
  transport: string;
  sessions: { active: number; total: number };
  tokens24h: { input: number; output: number; total: number; requests: number };
  recentSessions: Session[];
}

export interface Session {
  id: number;
  name: string | null;
  project_path: string | null;
  status: string;
  connected_at: string;
  last_active: string;
}

export interface SessionDetail extends Session {
  client_id: string;
  metadata: Record<string, unknown>;
  message_count: number;
}

export interface Message {
  id: number;
  role: string;
  content: string;
  created_at: string;
}

export interface PaginatedMessages {
  messages: Message[];
  total: number;
}

export interface Stats {
  api: Record<string, {
    summary: {
      total: number;
      success: number;
      errors: number;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      avg_latency_ms: number;
      estimated_cost: number;
    };
    byProvider: Array<{ provider: string; model: string; requests: number; input_tokens: number; output_tokens: number; tokens: number; avg_ms: number; cost: number }>;
    bySession: Array<{ session_id: number; session_name: string; project_path: string | null; requests: number; input_tokens: number; output_tokens: number; tokens: number; avg_ms: number }>;
    byProject: Array<{ project: string; requests: number; input_tokens: number; output_tokens: number; tokens: number; avg_ms: number; sessions: number }>;
    byOperation: Array<{ operation: string; requests: number; input_tokens: number; output_tokens: number; tokens: number; errors: number; avg_ms: number }>;
  }>;
  transcription: Record<string, {
    summary: { total: number; success: number; errors: number; avg_latency_ms: number };
    byProvider: Array<{ provider: string; requests: number; success: number; avg_ms: number }>;
  }>;
  messages: Record<string, {
    bySession: Array<{ session_id: number; session_name: string; total: number; user_msgs: number; assistant_msgs: number }>;
  }>;
}

export interface DailyStats {
  date: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  errors: number;
}

export interface LogEntry {
  id: number;
  session_id: number | null;
  session_name: string | null;
  level: string;
  stage: string;
  message: string;
  created_at: string;
}

export interface LogsParams {
  session_id?: number;
  level?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface PaginatedLogs {
  logs: LogEntry[];
  total: number;
}

export interface Memory {
  id: number;
  source: string;
  type: string;
  content: string;
  tags: string[];
  project_path: string | null;
  created_at: string;
}

export interface MemoriesParams {
  type?: string;
  project_path?: string;
  search?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface PaginatedMemories {
  memories: Memory[];
  total: number;
  hotContext: Memory[];
  indexing: boolean;
}

export interface MemoryTag {
  tag: string;
  count: number;
}

export interface Project {
  id: number;
  name: string;
  path: string;
  tmux_session_name: string;
  created_at: string;
  session_id: number | null;
  session_status: string | null;
}

export interface ApiError {
  model: string;
  operation: string;
  error_message: string;
  duration_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  session_name: string | null;
  project_path: string | null;
  created_at: string;
}
