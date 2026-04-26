import { IncomingMessage, ServerResponse } from "http";
import { readFile, access, writeFile } from "fs/promises";
import { join, extname, resolve } from "path";
import { homedir } from "os";
import { sql } from "../memory/db.ts";
import { sessionManager } from "../sessions/manager.ts";
import { CONFIG } from "../config.ts";
import { signJwt, verifyJwt, verifyTelegramLogin, verifyWebAppInitData, type AuthPayload } from "../dashboard/auth.ts";
import { getApiStats, getTranscriptionStats, getMessageStats, getRecentErrors } from "../utils/stats.ts";
import { getClaudeCodeUsage } from "../utils/claude-usage.ts";
import { isIndexing } from "../memory/long-term.ts";
import { addSSEClient, removeSSEClient, getSSEClientCount } from "./notification-broadcaster.ts";
import { sessionService } from "../services/session-service.ts";
import { projectService } from "../services/project-service.ts";
import { agentManager } from "../agents/agent-manager.ts";
import { orchestrator } from "../agents/orchestrator.ts";
import type { TaskStatus } from "../agents/orchestrator.ts";
import { logger } from "../logger.ts";

const DIST_DIR = join(import.meta.dirname, "../dashboard/dist");
const WEBAPP_DIST_DIR = join(import.meta.dirname, "../dashboard/webapp/dist");

// Map host project_path to container-accessible path
const HOST_PROJECTS_DIR = process.env.HOST_PROJECTS_DIR ?? (homedir() + "/bots");
function hostToContainerPath(hostPath: string): string {
  if (hostPath.startsWith(HOST_PROJECTS_DIR)) {
    return "/host-projects" + hostPath.slice(HOST_PROJECTS_DIR.length);
  }
  // Fallback for legacy HOST_HOME mount during transition
  const HOST_HOME = process.env.HOST_HOME ?? homedir();
  if (process.env.HOST_HOME && hostPath.startsWith(HOST_HOME)) {
    return "/host-home" + hostPath.slice(HOST_HOME.length);
  }
  return hostPath; // fallback: same path (manual/non-Docker runs)
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// --- Helpers ---

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, message: string, status = 400): void {
  sendJson(res, { error: message }, status);
}

const MAX_BODY_SIZE = 1_000_000; // 1 MB

async function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_SIZE) { req.destroy(); reject(new Error("Body too large")); }
    });
    req.on("end", () => {
      if (!data.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function parseCookie(req: IncomingMessage, name: string): string | undefined {
  const cookies = req.headers.cookie;
  if (!cookies) return undefined;
  const match = cookies.split(";").find((c) => c.trim().startsWith(`${name}=`));
  return match?.split("=").slice(1).join("=").trim();
}

function setCookie(res: ServerResponse, name: string, value: string, maxAge: number): void {
  const secure = (process.env.SECURE_COOKIES !== "false" && (process.env.SECURE_COOKIES === "true" || CONFIG.TELEGRAM_WEBHOOK_URL.startsWith("https") || process.env.NODE_ENV === "production")) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

function clearCookie(res: ServerResponse, name: string): void {
  res.setHeader("Set-Cookie", `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

async function getUser(req: IncomingMessage): Promise<AuthPayload | null> {
  // Check Authorization: Bearer header first (webapp uses this)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return verifyJwt(authHeader.slice(7));
  }
  const token = parseCookie(req, "token");
  if (!token) return null;
  return verifyJwt(token);
}

// --- Route handlers ---

async function handleAuthTelegram(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseBody(req);
  const dataStrings: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    dataStrings[k] = String(v);
  }

  if (!verifyTelegramLogin(dataStrings)) {
    sendError(res, "Invalid Telegram login data", 403);
    return;
  }

  const userId = Number(body.id);
  if (CONFIG.ALLOWED_USERS.length > 0 && !CONFIG.ALLOWED_USERS.includes(userId)) {
    sendError(res, "User not authorized", 403);
    return;
  }

  const payload: AuthPayload = {
    id: userId,
    first_name: body.first_name,
    username: body.username,
    photo_url: body.photo_url,
  };

  const token = await signJwt(payload);
  setCookie(res, "token", token, 7 * 24 * 3600);
  sendJson(res, payload);
}

async function handleAuthMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const user = await getUser(req);
  if (!user) { sendError(res, "Unauthorized", 401); return; }
  sendJson(res, user);
}

async function handleAuthLogout(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  clearCookie(res, "token");
  sendJson(res, { ok: true });
}

async function handleOverview(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const [dbCheck] = await sql`SELECT 1 as ok`.catch(() => [{ ok: false }]);
  const [sessionCounts] = await sql`
    SELECT count(*)::int as total, count(*) FILTER (WHERE status = 'active')::int as active
    FROM sessions WHERE id != 0
  `;
  const [tokens24h] = await sql`
    SELECT count(*)::int as requests,
      coalesce(sum(input_tokens), 0)::int as input,
      coalesce(sum(output_tokens), 0)::int as output,
      coalesce(sum(total_tokens), 0)::int as total
    FROM api_request_stats WHERE created_at >= now() - interval '24 hours'
  `;
  const recentSessions = await sql`
    SELECT id, name, project_path, source, status, connected_at, last_active
    FROM sessions WHERE id != 0 ORDER BY last_active DESC LIMIT 5
  `;

  sendJson(res, {
    uptime: Math.round(process.uptime()),
    db: dbCheck?.ok !== false ? "connected" : "disconnected",
    transport: CONFIG.TELEGRAM_TRANSPORT,
    sessions: { active: sessionCounts.active, total: sessionCounts.total },
    tokens24h: { input: tokens24h.input, output: tokens24h.output, total: tokens24h.total, requests: tokens24h.requests },
    recentSessions,
    sse_clients: getSSEClientCount(),
  });
}

async function handleSessions(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, await sessionService.list());
}

async function handleSessionDetail(res: ServerResponse, id: number): Promise<void> {
  const detail = await sessionService.getDetail(id);
  if (!detail) { sendError(res, "Session not found", 404); return; }
  sendJson(res, detail);
}

async function handleSessionMessages(res: ServerResponse, id: number, url: URL): Promise<void> {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const messages = await sql`
    SELECT id, role, content, created_at FROM messages
    WHERE session_id = ${id} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
  `;
  const [{ total }] = await sql`SELECT count(*)::int as total FROM messages WHERE session_id = ${id}`;
  sendJson(res, { messages, total });
}

async function handleDeleteSession(res: ServerResponse, id: number): Promise<void> {
  await sessionService.delete(id);
  sendJson(res, { ok: true });
}

async function handleRenameSession(req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  const { name } = await parseBody(req);
  if (!name) { sendError(res, "name required"); return; }
  const row = await sessionService.rename(id, name);
  if (!row) { sendError(res, "Session not found", 404); return; }
  sendJson(res, row);
}

async function handleStats(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const [apiStats, transcription, messages] = await Promise.all([
    getApiStats(), getTranscriptionStats(), getMessageStats(),
  ]);
  sendJson(res, { api: apiStats, transcription, messages });
}

async function handleDailyStats(res: ServerResponse, url: URL): Promise<void> {
  const days = Math.min(Number(url.searchParams.get("days") ?? 30), 365);
  const rows = await sql`
    SELECT date_trunc('day', created_at)::date as date,
      count(*)::int as requests,
      coalesce(sum(input_tokens), 0)::int as input_tokens,
      coalesce(sum(output_tokens), 0)::int as output_tokens,
      coalesce(sum(total_tokens), 0)::int as total_tokens,
      count(*) FILTER (WHERE status = 'error')::int as errors
    FROM api_request_stats
    WHERE created_at >= now() - make_interval(days => ${days})
    GROUP BY 1 ORDER BY 1
  `;
  sendJson(res, rows);
}

async function handleLogs(res: ServerResponse, url: URL): Promise<void> {
  const sessionId = url.searchParams.get("session_id");
  const level = url.searchParams.get("level");
  const search = url.searchParams.get("search");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const conditions = [];

  if (sessionId) conditions.push(sql`r.session_id = ${Number(sessionId)}`);
  if (level) conditions.push(sql`r.level = ${level}`);
  if (search) conditions.push(sql`r.message ILIKE ${"%" + search + "%"}`);

  const where = conditions.length > 0
    ? sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`
    : sql``;

  const logs = await sql`
    SELECT r.id, r.session_id, s.name as session_name, r.level, r.stage, r.message, r.created_at
    FROM request_logs r LEFT JOIN sessions s ON s.id = r.session_id
    ${where} ORDER BY r.created_at DESC LIMIT ${limit} OFFSET ${offset}
  `;
  const [{ total }] = await sql`SELECT count(*)::int as total FROM request_logs r ${where}`;
  sendJson(res, { logs, total });
}

async function handleMemories(res: ServerResponse, url: URL): Promise<void> {
  const type = url.searchParams.get("type");
  const projectPath = url.searchParams.get("project_path");
  const search = url.searchParams.get("search");
  const tag = url.searchParams.get("tag");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const conditions = [];
  if (type) conditions.push(sql`type = ${type}`);
  if (projectPath) conditions.push(sql`project_path = ${projectPath}`);
  if (search) conditions.push(sql`content ILIKE ${"%" + search + "%"}`);
  if (tag) conditions.push(sql`${tag} = ANY(tags)`);

  const where = conditions.length > 0
    ? sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`
    : sql``;

  const [memories, [{ total }], hotContext] = await Promise.all([
    sql`SELECT id, source, type, content, tags, project_path, created_at FROM memories ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    sql`SELECT count(*)::int as total FROM memories ${where}`,
    sql`SELECT id, source, type, content, tags, project_path, created_at FROM memories ORDER BY created_at DESC LIMIT 10`,
  ]);

  sendJson(res, { memories, total, hotContext, indexing: isIndexing() });
}

async function handleMemoryTags(res: ServerResponse): Promise<void> {
  const rows = await sql`
    SELECT unnest(tags) as tag, count(*)::int as count
    FROM memories
    WHERE tags IS NOT NULL AND array_length(tags, 1) > 0
    GROUP BY tag ORDER BY count DESC LIMIT 100
  `;
  sendJson(res, rows);
}

async function handleDeleteMemoryByTag(res: ServerResponse, tag: string): Promise<void> {
  const result = await sql`
    DELETE FROM memories WHERE ${tag} = ANY(tags) RETURNING id
  `;
  sendJson(res, { deleted: result.length });
}

async function handleDeleteMemory(res: ServerResponse, id: number): Promise<void> {
  await sql`DELETE FROM memories WHERE id = ${id}`;
  sendJson(res, { ok: true });
}

async function handleListProjects(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, await projectService.list());
}

async function handleCreateProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { name, path } = await parseBody(req);
  if (!name || typeof name !== "string") { sendError(res, "name required"); return; }
  if (!path || typeof path !== "string") { sendError(res, "path required"); return; }
  if (!path.startsWith("/")) { sendError(res, "path must be absolute"); return; }
  try {
    const project = await projectService.create(name, path);
    if (!project) { sendError(res, "Project with this path already exists", 409); return; }
    sendJson(res, project, 201);
  } catch (err: any) {
    if (err.code === "23505") { sendError(res, "Project already exists", 409); return; }
    throw err;
  }
}

async function handleProjectAction(_req: IncomingMessage, res: ServerResponse, id: number, action: "start" | "stop"): Promise<void> {
  const result = action === "start" ? await projectService.start(id) : await projectService.stop(id);
  if (!result.ok) { sendError(res, result.error ?? "Failed", 404); return; }
  sendJson(res, { ok: true });
}

async function handleDeleteProject(res: ServerResponse, id: number): Promise<void> {
  const result = await projectService.delete(id);
  if (!result.ok) {
    const status = result.error?.includes("active") ? 409 : 404;
    sendError(res, result.error ?? "Failed", status);
    return;
  }
  sendJson(res, { ok: true });
}

// --- Process Health API ---

async function handleGetProcessHealth(res: ServerResponse): Promise<void> {
  const [health, sessions] = await Promise.all([
    sql`SELECT name, status, detail, updated_at FROM process_health ORDER BY name`,
    sql`SELECT COUNT(*) AS cnt FROM sessions WHERE status = 'active' AND id != 0`,
  ]);
  const activeCount = Number((sessions[0] as any)?.cnt ?? 0);
  sendJson(res, { health, activeSessionCount: activeCount });
}

async function handleProcessAction(req: IncomingMessage, res: ServerResponse, action: "restart-daemon" | "restart-docker"): Promise<void> {
  if (action === "restart-daemon") {
    await sql`INSERT INTO admin_commands (command, payload) VALUES ('restart_admin_daemon', '{}')`;
    sendJson(res, { ok: true });
    return;
  }
  if (action === "restart-docker") {
    const { container } = await parseBody(req);
    if (!container || typeof container !== "string") { sendError(res, "container required"); return; }
    await sql`INSERT INTO admin_commands (command, payload) VALUES ('docker_restart', ${JSON.stringify({ container })}::jsonb)`;
    sendJson(res, { ok: true });
    return;
  }
  sendError(res, "Unknown action", 400);
}

// --- Git API ---

async function gitExec(projectPath: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const cwd = hostToContainerPath(projectPath);
  const proc = Bun.spawn(["git", "-c", "safe.directory=*", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { ok: code === 0, out: code === 0 ? out : err };
}

async function getSessionPath(sessionId: number): Promise<string | null> {
  const [row] = await sql`SELECT project_path FROM sessions WHERE id = ${sessionId}`;
  return row?.project_path ?? null;
}

async function handleGitTree(res: ServerResponse, sessionId: number): Promise<void> {
  const path = await getSessionPath(sessionId);
  if (!path) { sendError(res, "Session not found", 404); return; }
  const { ok, out } = await gitExec(path, ["ls-tree", "--name-only", "-r", "HEAD"]);
  if (!ok) { sendError(res, out || "Not a git repo"); return; }
  sendJson(res, { files: out.trim().split("\n").filter(Boolean) });
}

async function handleGitFile(res: ServerResponse, sessionId: number, url: URL): Promise<void> {
  const path = await getSessionPath(sessionId);
  if (!path) { sendError(res, "Session not found", 404); return; }
  const file = url.searchParams.get("path");
  if (!file) { sendError(res, "path required"); return; }
  // Prevent path traversal
  if (file.includes("..")) { sendError(res, "Invalid path", 400); return; }
  const rawRef = url.searchParams.get("ref") ?? "HEAD";
  const ref = /^[a-zA-Z0-9._\-\/~^:]{1,200}$/.test(rawRef) ? rawRef : "HEAD";
  const { ok, out } = await gitExec(path, ["show", `${ref}:${file}`]);
  if (!ok) { sendError(res, out || "File not found", 404); return; }
  sendJson(res, { content: out });
}

async function handleGitDiff(res: ServerResponse, sessionId: number, url: URL): Promise<void> {
  const path = await getSessionPath(sessionId);
  if (!path) { sendError(res, "Session not found", 404); return; }
  const rawRef = url.searchParams.get("ref") ?? "HEAD~1";
  const ref = /^[a-zA-Z0-9._\-\/~^:]{1,200}$/.test(rawRef) ? rawRef : "HEAD~1";
  const file = url.searchParams.get("path");
  const args = file ? ["diff", ref, "--", file] : ["diff", ref];
  const { ok, out } = await gitExec(path, args);
  if (!ok) { sendError(res, out || "Git error"); return; }
  sendJson(res, { diff: out });
}

async function handleGitLog(res: ServerResponse, sessionId: number, url: URL): Promise<void> {
  const path = await getSessionPath(sessionId);
  if (!path) { sendError(res, "Session not found", 404); return; }
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const { ok, out } = await gitExec(path, ["log", `--pretty=format:%H|%h|%s|%an|%ar`, `-${limit}`]);
  if (!ok) { sendError(res, out || "Git error"); return; }
  const commits = out.trim().split("\n").filter(Boolean).map((line) => {
    const [hash, short, subject, author, date] = line.split("|");
    return { hash, short, subject, author, date };
  });
  sendJson(res, { commits });
}

async function handleGitStatus(res: ServerResponse, sessionId: number): Promise<void> {
  const path = await getSessionPath(sessionId);
  if (!path) { sendError(res, "Session not found", 404); return; }
  const { ok, out } = await gitExec(path, ["status", "--porcelain"]);
  if (!ok) { sendError(res, out || "Git error"); return; }
  const files = out.trim().split("\n").filter(Boolean).map((line) => ({
    status: line.slice(0, 2).trim(),
    file: line.slice(3),
  }));
  sendJson(res, { files });
}

async function handleGitBranches(res: ServerResponse, sessionId: number): Promise<void> {
  const path = await getSessionPath(sessionId);
  if (!path) { sendError(res, "Session not found", 404); return; }
  const { ok, out } = await gitExec(path, ["branch", "-a", "--format=%(refname:short)|%(HEAD)"]);
  if (!ok) { sendError(res, out || "Git error"); return; }
  const branches = out.trim().split("\n").filter(Boolean).map((line) => {
    const [name, current] = line.split("|");
    return { name, current: current === "*" };
  });
  sendJson(res, { branches });
}

async function handleGitCommitDiff(res: ServerResponse, sessionId: number, hash: string): Promise<void> {
  const path = await getSessionPath(sessionId);
  if (!path) { sendError(res, "Session not found", 404); return; }
  const { ok, out } = await gitExec(path, ["show", hash, "--stat", "--patch"]);
  if (!ok) { sendError(res, out || "Commit not found", 404); return; }
  sendJson(res, { diff: out });
}

// --- GitHub PR API ---

/** Parse owner/repo from git remote URL (SSH or HTTPS). */
function parseGitHubRepo(remoteUrl: string): { owner: string; repo: string } | null {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  return null;
}

async function getGitHubRepo(projectPath: string): Promise<{ owner: string; repo: string } | null> {
  const { ok, out } = await gitExec(projectPath, ["remote", "get-url", "origin"]);
  if (!ok) return null;
  return parseGitHubRepo(out.trim());
}

async function githubReq<T>(path: string): Promise<T | null> {
  const token = CONFIG.GITHUB_TOKEN;
  if (!token) return null;
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) return null;
  return res.json() as Promise<T>;
}

/** Resolve the GitHub login for the configured token. Cached after first call. */
let _githubLoginCache: string | null | undefined = undefined;
async function getGitHubLogin(): Promise<string | null> {
  if (_githubLoginCache !== undefined) return _githubLoginCache;
  const user = await githubReq<{ login: string }>("/user");
  _githubLoginCache = user?.login ?? null;
  return _githubLoginCache;
}

async function handleGitHubPRs(res: ServerResponse, sessionId: number, url: URL): Promise<void> {
  const path = await getSessionPath(sessionId);
  if (!path) { sendError(res, "Session not found", 404); return; }

  const token = CONFIG.GITHUB_TOKEN;
  if (!token) { sendError(res, "GITHUB_TOKEN not configured", 503); return; }

  const repo = await getGitHubRepo(path);
  if (!repo) { sendError(res, "Could not determine GitHub repo from git remote", 400); return; }

  // Filters — author defaults to the token's own GitHub login
  const authorParam = url.searchParams.get("author");
  const filterAuthor = authorParam === "all" ? null : (authorParam || await getGitHubLogin());
  const filterDraft = url.searchParams.get("draft"); // "true" | "false" | null

  // Fetch all open PRs (GitHub API max 100 per page)
  const prs = await githubReq<any[]>(
    `/repos/${repo.owner}/${repo.repo}/pulls?state=open&per_page=100&sort=updated&direction=desc`
  );
  if (!prs) { sendError(res, "GitHub API error", 502); return; }

  let filtered = prs;
  if (filterAuthor) filtered = filtered.filter((p) => p.user?.login === filterAuthor);
  if (filterDraft === "true") filtered = filtered.filter((p) => p.draft === true);
  if (filterDraft === "false") filtered = filtered.filter((p) => p.draft === false);

  const result = filtered.map((p) => ({
    number: p.number as number,
    title: p.title as string,
    state: p.state as string,
    draft: p.draft as boolean,
    author: p.user?.login as string,
    author_avatar: p.user?.avatar_url as string,
    head: p.head?.ref as string,
    base: p.base?.ref as string,
    created_at: p.created_at as string,
    updated_at: p.updated_at as string,
    body: (p.body ?? "") as string,
    html_url: p.html_url as string,
    head_sha: p.head?.sha as string,
    comments: p.comments as number,
    review_comments: p.review_comments as number,
    additions: p.additions as number,
    deletions: p.deletions as number,
    changed_files: p.changed_files as number,
  }));

  sendJson(res, { prs: result, repo });
}

async function handleGitHubPRDetail(res: ServerResponse, sessionId: number, prNumber: number): Promise<void> {
  const path = await getSessionPath(sessionId);
  if (!path) { sendError(res, "Session not found", 404); return; }

  const token = CONFIG.GITHUB_TOKEN;
  if (!token) { sendError(res, "GITHUB_TOKEN not configured", 503); return; }

  const repo = await getGitHubRepo(path);
  if (!repo) { sendError(res, "Could not determine GitHub repo", 400); return; }

  const base = `/repos/${repo.owner}/${repo.repo}`;

  // Fetch PR, reviews, inline comments, and checks in parallel
  const [pr, reviews, inlineComments] = await Promise.all([
    githubReq<any>(`${base}/pulls/${prNumber}`),
    githubReq<any[]>(`${base}/pulls/${prNumber}/reviews?per_page=100`),
    githubReq<any[]>(`${base}/pulls/${prNumber}/comments?per_page=100`),
  ]);

  if (!pr) { sendError(res, "PR not found", 404); return; }

  // Fetch check runs for the PR head SHA
  const checks = await githubReq<any>(`${base}/commits/${pr.head.sha}/check-runs?per_page=100`);

  sendJson(res, {
    pr: {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: pr.draft,
      author: pr.user?.login,
      author_avatar: pr.user?.avatar_url,
      head: pr.head?.ref,
      base: pr.base?.ref,
      head_sha: pr.head?.sha,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      body: pr.body ?? "",
      html_url: pr.html_url,
    },
    reviews: (reviews ?? []).map((r: any) => ({
      id: r.id,
      author: r.user?.login,
      author_avatar: r.user?.avatar_url,
      state: r.state, // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED
      body: r.body ?? "",
      submitted_at: r.submitted_at,
    })),
    comments: (inlineComments ?? []).map((c: any) => ({
      id: c.id,
      author: c.user?.login,
      author_avatar: c.user?.avatar_url,
      body: c.body ?? "",
      path: c.path,
      line: c.line ?? c.original_line,
      created_at: c.created_at,
      diff_hunk: c.diff_hunk,
    })),
    checks: (checks?.check_runs ?? []).map((cr: any) => ({
      id: cr.id,
      name: cr.name,
      status: cr.status, // queued | in_progress | completed
      conclusion: cr.conclusion, // success | failure | neutral | cancelled | skipped | timed_out | action_required
      started_at: cr.started_at,
      completed_at: cr.completed_at,
      html_url: cr.html_url,
    })),
  });
}

// --- Session Stats API ---

async function handleSessionStats(res: ServerResponse, sessionId: number, url: URL): Promise<void> {
  const days = Math.min(Number(url.searchParams.get("days") ?? 30), 365);
  const dateFilter = sql`AND created_at >= now() - make_interval(days => ${days})`;

  const [summary, byModel] = await Promise.all([
    sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'success')::int AS success,
        count(*) FILTER (WHERE status = 'error')::int AS errors,
        coalesce(sum(input_tokens), 0)::int AS input_tokens,
        coalesce(sum(output_tokens), 0)::int AS output_tokens,
        coalesce(sum(total_tokens), 0)::int AS total_tokens,
        coalesce(avg(duration_ms) FILTER (WHERE status = 'success'), 0)::int AS avg_latency_ms
      FROM api_request_stats
      WHERE session_id = ${sessionId} ${dateFilter}
    `,
    sql`
      SELECT provider, model,
        count(*)::int AS requests,
        count(*) FILTER (WHERE status = 'error')::int AS errors,
        coalesce(sum(input_tokens), 0)::int AS input_tokens,
        coalesce(sum(output_tokens), 0)::int AS output_tokens,
        coalesce(sum(total_tokens), 0)::int AS total_tokens,
        coalesce(avg(duration_ms) FILTER (WHERE status = 'success'), 0)::int AS avg_ms
      FROM api_request_stats
      WHERE session_id = ${sessionId} ${dateFilter}
      GROUP BY provider, model
      ORDER BY requests DESC
    `,
  ]);

  sendJson(res, { summary: summary[0], by_model: byModel, days });
}

// --- Session Timeline API ---

async function handleSessionTimeline(res: ServerResponse, sessionId: number, url: URL): Promise<void> {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  // Merge messages + tool calls + memories chronologically
  const rows = await sql`
    SELECT 'message' AS kind, id::text, role AS actor, content, NULL::text AS response, created_at
    FROM messages
    WHERE session_id = ${sessionId} AND archived_at IS NULL
    UNION ALL
    SELECT 'tool', id::text, tool_name, description, COALESCE(status, response), created_at
    FROM permission_requests
    WHERE session_id = ${sessionId} AND archived_at IS NULL
    UNION ALL
    SELECT 'memory', id::text, type AS actor, left(content, 500), NULL::text AS response, created_at
    FROM memories
    WHERE session_id = ${sessionId} AND archived_at IS NULL
    ORDER BY created_at ASC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const total = await sql`
    SELECT (
      (SELECT count(*) FROM messages WHERE session_id = ${sessionId} AND archived_at IS NULL) +
      (SELECT count(*) FROM permission_requests WHERE session_id = ${sessionId} AND archived_at IS NULL) +
      (SELECT count(*) FROM memories WHERE session_id = ${sessionId} AND archived_at IS NULL)
    )::int AS total
  `;

  sendJson(res, { items: rows, total: total[0].total, limit, offset });
}

// --- Permissions API ---

async function handleGetPermissions(res: ServerResponse, sessionId: number): Promise<void> {
  const rows = await sql`
    SELECT id, tool_name, description, status, created_at
    FROM permission_requests
    WHERE session_id = ${sessionId} AND status = 'pending' AND archived_at IS NULL
    ORDER BY created_at ASC
  `;
  sendJson(res, rows);
}

async function handleGetPendingPermissions(res: ServerResponse): Promise<void> {
  const rows = await sql`
    SELECT pr.id, pr.tool_name, pr.description, pr.status, pr.created_at,
           pr.session_id, s.name AS session_name, s.project_path
    FROM permission_requests pr
    LEFT JOIN sessions s ON s.id = pr.session_id
    WHERE pr.status = 'pending'
    ORDER BY pr.created_at ASC
  `;
  sendJson(res, rows);
}

async function handlePermissionStats(res: ServerResponse, url: URL): Promise<void> {
  const sessionId = url.searchParams.get("session_id") ? Number(url.searchParams.get("session_id")) : null;
  const days = Math.min(Number(url.searchParams.get("days") ?? 30), 365);

  const sessionFilter = sessionId ? sql`AND session_id = ${sessionId}` : sql``;
  const dateFilter = sql`AND created_at >= now() - make_interval(days => ${days})`;

  const [summary, topTools] = await Promise.all([
    sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE response = 'allow')::int AS allowed,
        count(*) FILTER (WHERE response = 'deny')::int AS denied,
        count(*) FILTER (WHERE response = 'always')::int AS always_allowed,
        count(*) FILTER (WHERE response IS NULL)::int AS pending
      FROM permission_requests
      WHERE true ${sessionFilter} ${dateFilter}
    `,
    sql`
      SELECT
        tool_name,
        count(*)::int AS total,
        count(*) FILTER (WHERE response = 'allow')::int AS allowed,
        count(*) FILTER (WHERE response = 'deny')::int AS denied,
        count(*) FILTER (WHERE response = 'always')::int AS always_allowed
      FROM permission_requests
      WHERE true ${sessionFilter} ${dateFilter}
      GROUP BY tool_name
      ORDER BY total DESC
      LIMIT 15
    `,
  ]);

  sendJson(res, { summary: summary[0], top_tools: topTools, days, session_id: sessionId });
}

async function handleRespondPermission(req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  const { response } = await parseBody(req);
  if (!["allow", "deny"].includes(response)) { sendError(res, "response must be allow or deny"); return; }
  const rows = await sql`
    UPDATE permission_requests SET response = ${response}, status = ${response === "allow" ? "approved" : "rejected"}
    WHERE id = ${id} AND status = 'pending'
    RETURNING id, session_id
  `;
  if (rows.length === 0) { sendError(res, "Permission request not found or already answered", 404); return; }
  sendJson(res, { ok: true });
}

async function handleAlwaysAllowPermission(req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  const [perm] = await sql`SELECT id, tool_name, session_id FROM permission_requests WHERE id = ${id}`;
  if (!perm) { sendError(res, "Not found", 404); return; }

  const [session] = await sql`SELECT project_path FROM sessions WHERE id = ${perm.session_id}`;
  if (!session?.project_path) { sendError(res, "Session has no project path", 400); return; }

  // Determine settings.local.json path (project-scoped or global)
  const hostClaudeConfig = process.env.HOST_CLAUDE_CONFIG ?? "/host-claude-config";
  const encodedPath = session.project_path.replace(/\//g, "%2F");
  const projectSettings = join(hostClaudeConfig, "projects", encodedPath, "settings.local.json");
  const globalSettings = join(hostClaudeConfig, "settings.local.json");

  // Use project-scoped if it exists, else global
  const settingsPath = await access(projectSettings).then(() => projectSettings, () => globalSettings);

  let settings: any = { permissions: { allow: [] } };
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.permissions ??= { allow: [] };
    settings.permissions.allow ??= [];
  } catch {}

  const pattern = `${perm.tool_name}(*)`;
  if (!settings.permissions.allow.includes(pattern)) {
    settings.permissions.allow.push(pattern);
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  }

  // Also mark as allowed
  await sql`UPDATE permission_requests SET response = 'allow', status = 'approved' WHERE id = ${id}`;
  sendJson(res, { ok: true });
}

// --- Agents / Tasks / Models API (PRD §16 dashboard + §17.7 CLI) ---
//
// All handlers delegate to agentManager and orchestrator singletons. They
// return JSON shaped to match the corresponding TS types (AgentInstance,
// AgentTask, etc.) so dashboard React components can consume them
// directly without re-mapping.

async function handleListAgents(res: ServerResponse, url: URL): Promise<void> {
  // Delegated to AgentManager.listInstancesEnriched — see F-006 in the
  // PR #7 review. Previously this handler issued its own JOIN across
  // agent_instances + agent_definitions + projects, duplicating schema
  // knowledge with AgentManager.
  const projectIdParam = url.searchParams.get("project_id");
  const desiredState = url.searchParams.get("desired_state") ?? undefined;
  const actualState = url.searchParams.get("actual_state") ?? undefined;
  const rows = await agentManager.listInstancesEnriched({
    ...(projectIdParam ? { projectId: Number(projectIdParam) } : {}),
    ...(desiredState ? { desiredState: desiredState as any } : {}),
    ...(actualState ? { actualState: actualState as any } : {}),
  });
  // Translate camelCase AgentInstance fields back to snake_case for the
  // wire format the dashboard already consumes (avoid breaking change).
  const wire = rows.map((r) => ({
    id: r.id,
    definition_id: r.definitionId,
    project_id: r.projectId,
    name: r.name,
    desired_state: r.desiredState,
    actual_state: r.actualState,
    runtime_handle: r.runtimeHandle,
    last_snapshot: r.lastSnapshot,
    last_snapshot_at: r.lastSnapshotAt,
    last_health_at: r.lastHealthAt,
    restart_count: r.restartCount,
    last_restart_at: r.lastRestartAt,
    session_id: r.sessionId,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    definition_name: r.definition_name,
    runtime_type: r.runtime_type,
    capabilities: r.capabilities,
    definition_enabled: r.definition_enabled,
    project_name: r.project_name,
  }));
  sendJson(res, wire);
}

async function handleListAgentDefinitions(res: ServerResponse): Promise<void> {
  const defs = await agentManager.listDefinitions();
  sendJson(res, defs);
}

async function handleGetAgent(res: ServerResponse, id: number): Promise<void> {
  const inst = await agentManager.getInstance(id);
  if (!inst) { sendError(res, "agent not found", 404); return; }
  sendJson(res, inst);
}

async function handleAgentAction(
  req: IncomingMessage,
  res: ServerResponse,
  id: number,
  action: "start" | "stop" | "restart",
): Promise<void> {
  const body = await parseBody(req).catch(() => ({}));
  const reason = typeof body?.reason === "string" ? body.reason : `dashboard ${action}`;
  // start and restart both converge to desired_state='running' — the
  // reconciler will pick up actual_state and either leave it or restart.
  // stop sets desired_state='stopped'.
  const desired = action === "stop" ? "stopped" : "running";
  try {
    const inst = await agentManager.setDesiredState(id, desired as any, reason);
    sendJson(res, inst);
  } catch (e) {
    sendError(res, e instanceof Error ? e.message : String(e), 400);
  }
}

async function handleListTasks(res: ServerResponse, url: URL): Promise<void> {
  const status = url.searchParams.get("status") as TaskStatus | null;
  const agentInstanceId = url.searchParams.get("agent_instance_id");
  const parentTaskId = url.searchParams.get("parent_task_id");
  const filter: { status?: TaskStatus; agentInstanceId?: number; parentTaskId?: number | null } = {};
  if (status) filter.status = status;
  if (agentInstanceId) filter.agentInstanceId = Number(agentInstanceId);
  if (parentTaskId === "null") filter.parentTaskId = null;
  else if (parentTaskId) filter.parentTaskId = Number(parentTaskId);
  const tasks = await orchestrator.listTasks(filter);
  sendJson(res, tasks);
}

async function handleGetTaskTree(res: ServerResponse, id: number): Promise<void> {
  const tree = await orchestrator.getTaskTree(id);
  if (!tree) { sendError(res, "task not found", 404); return; }
  sendJson(res, tree);
}

async function handleReassignTask(req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  const body = await parseBody(req).catch(() => ({}));
  const reason = typeof body?.reason === "string" ? body.reason : "manual reassign from dashboard";
  try {
    const result = await orchestrator.handleFailure(id, { reason });
    sendJson(res, result);
  } catch (e) {
    sendError(res, e instanceof Error ? e.message : String(e), 400);
  }
}

/**
 * Re-link an agent_instance's definition to a different model_profile.
 * Implements the runtime side of `helyx model set <agent> <profile>`
 * (PRD §17.7) and the future dashboard model-routing UI.
 *
 * Note on shape: model_profile_id lives on `agent_definitions`, not on
 * `agent_instances` — definitions are role templates and the profile
 * binding belongs there. We update the linked definition rather than
 * the instance row directly. The caller scope is "this agent uses this
 * profile" but the storage is one-level deeper. This is acceptable for
 * the current 1:N (definition:instances) cardinality; if multiple
 * instances of the same definition need different profiles, a per-
 * instance override column will be needed later.
 */
async function handleSetAgentProfile(req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  const body = await parseBody(req).catch(() => ({}));
  const profileRef = body?.profile;
  if (!profileRef || (typeof profileRef !== "string" && typeof profileRef !== "number")) {
    sendError(res, "body must include `profile` (id or name)", 400);
    return;
  }

  // All four steps (profile lookup, instance lookup, agent_definitions
  // UPDATE, agent_events INSERT) must be atomic. Without a transaction,
  // a concurrent profile DELETE between lookup and UPDATE could ON DELETE
  // SET NULL silently — caller would see ok=true but the DB has
  // model_profile_id=NULL. The audit event is also lost on partial crash.
  try {
    const result = await sql.begin(async (tx) => {
      let profileId: number;
      if (typeof profileRef === "number" || /^\d+$/.test(String(profileRef))) {
        profileId = Number(profileRef);
        const exists = (await tx`
          SELECT id FROM model_profiles WHERE id = ${profileId} AND enabled = true LIMIT 1
        `) as any[];
        if (exists.length === 0) throw new Error(`__NOT_FOUND__:model_profile id=${profileId} not found or disabled`);
      } else {
        const rows = (await tx`
          SELECT id FROM model_profiles WHERE name = ${profileRef} AND enabled = true LIMIT 1
        `) as any[];
        if (rows.length === 0) throw new Error(`__NOT_FOUND__:model_profile "${profileRef}" not found or disabled`);
        profileId = Number(rows[0].id);
      }

      const inst = (await tx`
        SELECT id, definition_id, name FROM agent_instances WHERE id = ${id} LIMIT 1
      `) as any[];
      if (inst.length === 0) throw new Error("__NOT_FOUND__:agent not found");
      const definitionId = Number(inst[0].definition_id);

      await tx`
        UPDATE agent_definitions SET model_profile_id = ${profileId}, updated_at = now()
        WHERE id = ${definitionId}
      `;
      await tx`
        INSERT INTO agent_events (agent_instance_id, event_type, message, metadata)
        VALUES (
          ${id},
          'model_profile_change',
          ${`profile binding updated to model_profile_id=${profileId}`},
          ${JSON.stringify({ definition_id: definitionId, model_profile_id: profileId })}::jsonb
        )
      `;
      return { agent_id: id, definition_id: definitionId, model_profile_id: profileId };
    });
    sendJson(res, { ok: true, ...result });
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("__NOT_FOUND__:")) {
      sendError(res, msg.slice("__NOT_FOUND__:".length), 404);
    } else {
      sendError(res, msg, 400);
    }
  }
}

/**
 * Create a new agent_instance from an existing definition. Validates:
 *   - definition exists and is enabled
 *   - project_id, if provided, exists
 *   - (project_id, name) is unique (DB constraint will reject otherwise)
 *
 * Does NOT create new agent_definitions — definitions are seeded by
 * migrations and the wizard. To add a new definition, edit a migration
 * (long-term) or use `helyx setup-agents` (operational).
 */
async function handleCreateAgent(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseBody(req).catch(() => null);
  if (!body || typeof body !== "object") { sendError(res, "JSON body required", 400); return; }

  const definitionRef = body.definition;
  const projectRef = body.project ?? null;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const desiredState = body.desired_state ?? "stopped";

  if (!definitionRef) { sendError(res, "definition (id or name) required", 400); return; }
  if (!name) { sendError(res, "name required", 400); return; }
  if (!["running", "stopped", "paused"].includes(desiredState)) {
    sendError(res, `desired_state must be one of: running, stopped, paused`, 400);
    return;
  }

  // Resolve definition through agentManager — F-006-residual: previously
  // this handler issued raw SQL on agent_definitions / projects, the same
  // boundary leak F-006 closed for handleListAgents. Now both writes and
  // reads in this file route through services.
  let def: import("../agents/agent-manager.ts").AgentDefinition | null = null;
  if (typeof definitionRef === "number" || /^\d+$/.test(String(definitionRef))) {
    def = await agentManager.getDefinition(Number(definitionRef));
  } else {
    def = await agentManager.getDefinitionByName(String(definitionRef));
  }
  if (!def) { sendError(res, `agent_definition "${definitionRef}" not found`, 404); return; }
  if (!def.enabled) { sendError(res, `agent_definition "${def.name}" is disabled`, 404); return; }

  // Resolve project through projectService (optional — null = unattached).
  let projectId: number | null = null;
  if (projectRef !== null && projectRef !== undefined && projectRef !== "") {
    let proj: import("../services/project-service.ts").Project | null = null;
    if (typeof projectRef === "number" || /^\d+$/.test(String(projectRef))) {
      proj = await projectService.get(Number(projectRef));
    } else {
      proj = await projectService.getByName(String(projectRef));
    }
    if (!proj) { sendError(res, `project "${projectRef}" not found`, 404); return; }
    projectId = proj.id;
  }

  try {
    const inst = await agentManager.createInstance({
      definitionId: def.id,
      projectId,
      name,
      desiredState,
    });
    sendJson(res, inst);
  } catch (err: any) {
    // Unique constraint (project_id, name) → 409 Conflict.
    if (err?.code === "23505" || /duplicate.*key/i.test(String(err?.message))) {
      sendError(res, `agent with name "${name}" already exists in project ${projectId ?? "(global)"}`, 409);
      return;
    }
    sendError(res, err?.message ?? String(err), 400);
  }
}

async function handleAgentEvents(res: ServerResponse, id: number, url: URL): Promise<void> {
  // Return recent agent_events for an agent instance. Default limit 50;
  // accepts ?limit=N (capped at 500). Used by `helyx agent logs <id>`
  // and the dashboard agent detail page.
  const limitParam = Number(url.searchParams.get("limit") ?? "50");
  const limit = Math.max(1, Math.min(500, isFinite(limitParam) ? limitParam : 50));
  const rows = await sql`
    SELECT id, agent_instance_id, task_id, event_type, from_state, to_state, message, metadata, created_at
    FROM agent_events
    WHERE agent_instance_id = ${id}
    ORDER BY created_at DESC
    LIMIT ${limit}
  ` as any[];
  sendJson(res, rows);
}

/**
 * Send a tiny live request to the provider's API to verify credentials +
 * endpoint reachability (PRD §16.6 #9). Doesn't burn a model_profile —
 * uses default_model from the model_providers row directly.
 *
 * The fallback policy is intentionally bypassed (_fallbackInProgress=true)
 * so the user sees the primary provider's actual error, not a masking
 * fallback success.
 */
async function handleProviderTest(res: ServerResponse, id: number): Promise<void> {
  const rows = await sql`
    SELECT id, name, provider_type, base_url, api_key_env, default_model
    FROM model_providers WHERE id = ${id} LIMIT 1
  ` as any[];
  const p = rows[0];
  if (!p) { sendError(res, "provider not found", 404); return; }

  const apiKey = p.api_key_env ? process.env[p.api_key_env] : "";
  // Ollama is the only currently-supported provider that doesn't need a key.
  if (!apiKey && p.provider_type !== "ollama") {
    sendJson(res, {
      ok: false,
      provider: p.name,
      error: `API key env "${p.api_key_env}" is not set in the bot's environment`,
      durationMs: 0,
    });
    return;
  }

  // SSRF guard: validate base_url before issuing an authenticated outbound
  // HTTP call. Without this an authenticated operator who edited a
  // model_providers row could point base_url at cloud-metadata services
  // (169.254.169.254) or internal RFC-1918 ranges, then read up to 200
  // chars of the response back through the API reply. helyx is single-
  // tenant but operator privilege ≠ trust to read internal network.
  //
  // Allowed: known-good public hosts (api.anthropic.com, api.openai.com,
  // openrouter.ai, generativelanguage.googleapis.com, api.deepseek.com,
  // api.groq.com), or the explicit Ollama localhost configured at install.
  // Anything else is rejected before the fetch.
  const baseUrlValidationError = validateProviderBaseUrl(p.base_url, p.provider_type);
  if (baseUrlValidationError) {
    sendJson(res, {
      ok: false,
      provider: p.name,
      error: baseUrlValidationError,
      durationMs: 0,
    });
    return;
  }

  const { generateResponse } = await import("../llm/client.ts");
  const resolved = {
    providerType: p.provider_type,
    model: p.default_model || "claude-haiku-4-5",
    apiKey: apiKey || undefined,
    baseUrl: p.base_url ?? undefined,
    maxTokens: 16,
  };

  const start = Date.now();
  try {
    const result = await generateResponse(
      [{ role: "user", content: "ping" }],
      "Reply with one word.",
      { provider: resolved as any, operation: "provider-test", _fallbackInProgress: true },
    );
    // Truncate response to a short snippet AND strip anything that looks
    // like a bearer token, in case the upstream echoed something like
    // "your key sk-... is invalid" in the response body.
    const snippet = result.slice(0, 200).replace(/\b(?:sk|pk|Bearer)[A-Za-z0-9_.-]{8,}/gi, "***");
    sendJson(res, {
      ok: true,
      provider: p.name,
      model: resolved.model,
      durationMs: Date.now() - start,
      response: snippet,
    });
  } catch (err: any) {
    // Sanitize error message identically — third-party SDKs may include
    // partial keys or tokens in their thrown errors.
    const msg = (err?.message ?? String(err)).slice(0, 500)
      .replace(/\b(?:sk|pk|Bearer)[A-Za-z0-9_.-]{8,}/gi, "***");
    sendJson(res, {
      ok: false,
      provider: p.name,
      model: resolved.model,
      durationMs: Date.now() - start,
      error: msg,
    });
  }
}

/**
 * SSRF allowlist for provider test calls. Returns null when the URL is
 * acceptable; otherwise returns a human-readable rejection reason.
 *
 *   - Ollama: localhost / 127.0.0.1 / host.docker.internal allowed
 *     (Ollama is intentionally a local service)
 *   - All others: must be HTTPS + a hostname in the public allowlist
 *
 * IPv6 link-local / unique-local + RFC-1918 / loopback / link-local IPv4
 * are explicitly rejected even when the user types them as the host.
 */
function validateProviderBaseUrl(baseUrl: string | null, providerType: string): string | null {
  if (!baseUrl) {
    // Anthropic and a few others use SDK-default URL; that path skips
    // base_url entirely and goes through the official endpoint. OK.
    return null;
  }
  let parsed: URL;
  try { parsed = new URL(baseUrl); }
  catch { return `invalid base_url: "${baseUrl}"`; }

  const host = parsed.hostname.toLowerCase();
  const ollamaHosts = new Set(["localhost", "127.0.0.1", "host.docker.internal", "::1"]);
  if (providerType === "ollama") {
    if (ollamaHosts.has(host)) return null;
    return `Ollama base_url must be one of: ${[...ollamaHosts].join(", ")} (got "${host}")`;
  }
  // For non-Ollama providers, demand HTTPS + a public allowlisted host.
  if (parsed.protocol !== "https:") {
    return `non-Ollama provider must use https:// (got "${parsed.protocol}")`;
  }
  // Reject obvious internal addresses by IP form.
  if (/^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.|::1$|fe80:|fc00:|fd00:)/.test(host)) {
    return `base_url points to an internal address (${host}) — refused (SSRF guard)`;
  }
  if (ollamaHosts.has(host)) {
    return `base_url points to a local address (${host}) but provider_type is "${providerType}" — refused`;
  }
  // Allowlist of well-known managed-LLM endpoints. Add to this list when
  // a new public provider lands. We deliberately do NOT allow arbitrary
  // public hostnames — operators with custom enterprise endpoints should
  // add them explicitly via a code patch (gateways inside private
  // networks are out of scope for the test endpoint).
  const allowedSuffixes = [
    "api.anthropic.com",
    "api.openai.com",
    "openrouter.ai",
    "generativelanguage.googleapis.com",
    "api.deepseek.com",
    "api.groq.com",
  ];
  if (!allowedSuffixes.some((s) => host === s || host.endsWith("." + s))) {
    return `base_url host "${host}" is not in the allowlist for provider test. Allowed: ${allowedSuffixes.join(", ")}`;
  }
  return null;
}

async function handleListProviders(res: ServerResponse): Promise<void> {
  const rows = await sql`
    SELECT id, name, provider_type, base_url, api_key_env, default_model, enabled, metadata, created_at, updated_at
    FROM model_providers
    ORDER BY id ASC
  ` as any[];
  sendJson(res, rows);
}

async function handleListProfiles(res: ServerResponse): Promise<void> {
  const rows = await sql`
    SELECT mp.id, mp.name, mp.provider_id, mpr.name AS provider_name, mp.model,
           mp.max_tokens, mp.temperature, mp.system_prompt, mp.enabled, mp.metadata,
           mp.created_at, mp.updated_at
    FROM model_profiles mp
    JOIN model_providers mpr ON mpr.id = mp.provider_id
    ORDER BY mp.id ASC
  ` as any[];
  sendJson(res, rows);
}

async function handleRuntimeStatus(res: ServerResponse): Promise<void> {
  // Lightweight aggregate: counts + tmux-driver health probe via a single
  // session lookup. Intentionally NOT exposing per-driver internals — the
  // dashboard only needs traffic-light status (ok/degraded/down) per
  // surface area.
  const [totals] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM agent_instances) AS total_instances,
      (SELECT COUNT(*)::int FROM agent_instances WHERE actual_state = 'running') AS running_instances,
      (SELECT COUNT(*)::int FROM agent_instances WHERE actual_state = 'stopped') AS stopped_instances,
      (SELECT COUNT(*)::int FROM agent_instances WHERE actual_state = 'waiting_approval') AS waiting_approval,
      (SELECT COUNT(*)::int FROM agent_instances
        WHERE desired_state != actual_state AND desired_state != 'stopped') AS desired_actual_drift,
      (SELECT COUNT(*)::int FROM agent_tasks WHERE status = 'pending') AS pending_tasks,
      (SELECT COUNT(*)::int FROM agent_tasks WHERE status = 'in_progress') AS in_progress_tasks,
      (SELECT COUNT(*)::int FROM agent_tasks WHERE status = 'failed') AS failed_tasks
  ` as any[];
  sendJson(res, {
    totals,
    drivers: { tmux: "ok", pty: "not-implemented", docker: "not-implemented", process: "not-implemented" },
  });
}

// --- WebApp auth ---

async function handleAuthWebApp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { initData } = await parseBody(req);
  if (!initData || typeof initData !== "string") {
    logger.warn("webapp-auth: missing initData");
    sendError(res, "initData required"); return;
  }

  const params = new URLSearchParams(initData);
  const authDate = Number(params.get("auth_date"));
  const age = Math.round(Date.now() / 1000 - authDate);
  logger.info({ age, hashPrefix: params.get("hash")?.slice(0, 8) }, "webapp-auth: initData received");

  const user = verifyWebAppInitData(initData);
  if (!user) {
    logger.warn({ age }, "webapp-auth: verification failed");
    sendError(res, "Invalid initData", 401); return;
  }

  const allowed = CONFIG.ALLOWED_USERS.map(Number);
  logger.info({ userId: user.id, username: user.username }, "webapp-auth: user identified");
  if (!allowed.includes(user.id)) { sendError(res, "Forbidden", 403); return; }

  const token = await signJwt(user);
  logger.info({ userId: user.id }, "webapp-auth: success");
  sendJson(res, { ok: true, user, token });
}

// --- Static file serving ---

async function serveWebApp(res: ServerResponse, subpath: string): Promise<boolean> {
  let filePath = resolve(join(WEBAPP_DIST_DIR, subpath));
  if (!filePath.startsWith(WEBAPP_DIST_DIR)) return false;
  const exists = await access(filePath).then(() => true, () => false);
  if (!exists || !subpath || subpath === "/") filePath = join(WEBAPP_DIST_DIR, "index.html");
  const indexExists = await access(filePath).then(() => true, () => false);
  if (!indexExists) return false;
  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const content = await readFile(filePath);
  const isHtml = ext === ".html" || filePath.endsWith("index.html");
  const cacheHeader = isHtml ? "no-store" : "public, max-age=31536000, immutable";
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": cacheHeader });
  res.end(content);
  return true;
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  let filePath = resolve(join(DIST_DIR, pathname));
  if (!filePath.startsWith(DIST_DIR)) return false; // path traversal protection

  const exists = await access(filePath).then(() => true, () => false);
  if (!exists || pathname === "/") {
    filePath = join(DIST_DIR, "index.html");
  }
  const indexExists = await access(filePath).then(() => true, () => false);
  if (!indexExists) return false;

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

// --- Main router ---

export async function handleDashboardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const { pathname } = url;
  const method = req.method ?? "GET";

  // Auth endpoints (no JWT required)
  if (pathname === "/api/auth/webapp" && method === "POST") {
    await handleAuthWebApp(req, res);
    return true;
  }
  if (pathname === "/api/auth/telegram" && method === "POST") {
    await handleAuthTelegram(req, res);
    return true;
  }
  if (pathname === "/api/auth/me" && method === "GET") {
    await handleAuthMe(req, res);
    return true;
  }
  if (pathname === "/api/auth/logout" && method === "POST") {
    await handleAuthLogout(req, res);
    return true;
  }

  // CLI registration endpoints — protected by isLocalRequest in server.ts, not JWT
  if (
    pathname === "/api/sessions/register" ||
    pathname === "/api/sessions/disconnect" ||
    pathname === "/api/sessions/expect"
  ) return false;

  // SSE endpoint — requires auth cookie but uses streaming response
  if (pathname === "/api/events" && method === "GET") {
    const user = await getUser(req);
    if (!user) { sendError(res, "Unauthorized", 401); return true; }

    const clientId = crypto.randomUUID();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Send initial heartbeat
    send("connected", { clientId, timestamp: new Date().toISOString() });

    addSSEClient({ id: clientId, send, close: () => res.end() });

    // Keepalive ping every 30s
    const pingInterval = setInterval(() => {
      try { res.write(": ping\n\n"); } catch {
        clearInterval(pingInterval);
        removeSSEClient(clientId);
      }
    }, 30_000);

    req.on("close", () => {
      clearInterval(pingInterval);
      removeSSEClient(clientId);
    });

    return true;
  }

  // All other /api/* routes require auth
  if (pathname.startsWith("/api/")) {
    const user = await getUser(req);
    if (!user) { sendError(res, "Unauthorized", 401); return true; }

    // CSRF protection: verify Origin header on state-changing requests
    if (method !== "GET" && method !== "HEAD") {
      const origin = req.headers.origin;
      const host = req.headers.host;
      if (origin && host && !origin.includes(host)) {
        sendError(res, "CSRF: origin mismatch", 403);
        return true;
      }
    }

    // Parse session ID from path
    const sessionMatch = pathname.match(/^\/api\/sessions\/(\d+)(\/messages|\/switch|\/stats|\/timeline)?$/);

    if (pathname === "/api/overview" && method === "GET") {
      await handleOverview(req, res);
      return true;
    }
    if (pathname === "/api/sessions" && method === "GET") {
      logger.debug({ cookiePrefix: req.headers.cookie?.slice(0, 40) ?? "none" }, "sessions list request");
      await handleSessions(req, res);
      return true;
    }
    if (pathname === "/api/sessions/active" && method === "GET") {
      const user = await getUser(req);
      if (!user) { sendError(res, "Unauthorized", 401); return true; }
      const chatId = String(user.id);
      const [chatSess] = await sql`
        SELECT active_session_id FROM chat_sessions WHERE chat_id = ${chatId}
      `;
      if (!chatSess?.active_session_id) { sendJson(res, null); return true; }
      const [session] = await sql`
        SELECT id, name, project, project_path, source, status, last_active
        FROM sessions WHERE id = ${chatSess.active_session_id}
      `;
      sendJson(res, session ?? null);
      return true;
    }
    if (sessionMatch) {
      const id = Number(sessionMatch[1]);
      const sub = sessionMatch[2];
      if (sub === "/messages" && method === "GET") {
        await handleSessionMessages(res, id, url);
        return true;
      }
      if (sub === "/stats" && method === "GET") {
        await handleSessionStats(res, id, url);
        return true;
      }
      if (sub === "/timeline" && method === "GET") {
        await handleSessionTimeline(res, id, url);
        return true;
      }
      if (!sub && method === "GET") {
        await handleSessionDetail(res, id);
        return true;
      }
      if (!sub && method === "DELETE") {
        await handleDeleteSession(res, id);
        return true;
      }
      if (!sub && method === "PATCH") {
        await handleRenameSession(req, res, id);
        return true;
      }
      if (sub === "/switch" && method === "POST") {
        const user = await getUser(req);
        if (!user) { sendError(res, "Unauthorized", 401); return true; }
        const chatId = String(user.id);
        await sessionManager.switchSession(chatId, id);
        sendJson(res, { ok: true });
        return true;
      }
    }
    if (pathname === "/api/stats" && method === "GET") {
      await handleStats(req, res);
      return true;
    }
    if (pathname === "/api/stats/daily" && method === "GET") {
      await handleDailyStats(res, url);
      return true;
    }
    if (pathname === "/api/stats/errors" && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
      const errors = await getRecentErrors(limit);
      sendJson(res, errors);
      return true;
    }
    if (pathname === "/api/stats/claude-code" && method === "GET") {
      const days = Math.min(Number(url.searchParams.get("days") ?? 30), 365);
      const cutoffMs = days > 0 ? Date.now() - days * 86400_000 : 0;
      const projectsDir = join(CONFIG.HOST_CLAUDE_CONFIG, "projects");
      const usage = await getClaudeCodeUsage(projectsDir, cutoffMs);
      sendJson(res, usage);
      return true;
    }
    if (pathname === "/api/logs" && method === "GET") {
      await handleLogs(res, url);
      return true;
    }
    if (pathname === "/api/memories" && method === "GET") {
      await handleMemories(res, url);
      return true;
    }
    if (pathname === "/api/memories/tags" && method === "GET") {
      await handleMemoryTags(res);
      return true;
    }
    const memoryTagMatch = pathname.match(/^\/api\/memories\/tag\/(.+)$/);
    if (memoryTagMatch && method === "DELETE") {
      await handleDeleteMemoryByTag(res, decodeURIComponent(memoryTagMatch[1]));
      return true;
    }
    if (pathname.match(/^\/api\/memories\/(\d+)$/) && method === "DELETE") {
      const id = Number(pathname.split("/").pop());
      await handleDeleteMemory(res, id);
      return true;
    }

    // Projects
    if (pathname === "/api/projects" && method === "GET") {
      await handleListProjects(req, res);
      return true;
    }
    if (pathname === "/api/projects" && method === "POST") {
      await handleCreateProject(req, res);
      return true;
    }
    const projectActionMatch = pathname.match(/^\/api\/projects\/(\d+)\/(start|stop)$/);
    if (projectActionMatch && method === "POST") {
      const id = Number(projectActionMatch[1]);
      const action = projectActionMatch[2] as "start" | "stop";
      await handleProjectAction(req, res, id, action);
      return true;
    }
    if (pathname.match(/^\/api\/projects\/(\d+)$/) && method === "DELETE") {
      const id = Number(pathname.split("/").pop());
      await handleDeleteProject(res, id);
      return true;
    }

    // Process health
    if (pathname === "/api/process-health" && method === "GET") {
      await handleGetProcessHealth(res);
      return true;
    }
    const processActionMatch = pathname.match(/^\/api\/process-health\/(restart-daemon|restart-docker)$/);
    if (processActionMatch && method === "POST") {
      await handleProcessAction(req, res, processActionMatch[1] as "restart-daemon" | "restart-docker");
      return true;
    }

    // Git API
    const gitMatch = pathname.match(/^\/api\/git\/(\d+)\/(tree|file|diff|log|status|branches|commit\/([a-f0-9]+))$/);
    if (gitMatch && method === "GET") {
      const sessionId = Number(gitMatch[1]);
      const action = gitMatch[2];
      if (action === "tree") { await handleGitTree(res, sessionId); return true; }
      if (action === "file") { await handleGitFile(res, sessionId, url); return true; }
      if (action === "diff") { await handleGitDiff(res, sessionId, url); return true; }
      if (action === "log") { await handleGitLog(res, sessionId, url); return true; }
      if (action === "status") { await handleGitStatus(res, sessionId); return true; }
      if (action === "branches") { await handleGitBranches(res, sessionId); return true; }
      if (gitMatch[3]) { await handleGitCommitDiff(res, sessionId, gitMatch[3]); return true; }
    }
    // GitHub PR API
    const prListMatch = pathname.match(/^\/api\/git\/(\d+)\/prs$/);
    if (prListMatch && method === "GET") {
      await handleGitHubPRs(res, Number(prListMatch[1]), url); return true;
    }
    const prDetailMatch = pathname.match(/^\/api\/git\/(\d+)\/prs\/(\d+)$/);
    if (prDetailMatch && method === "GET") {
      await handleGitHubPRDetail(res, Number(prDetailMatch[1]), Number(prDetailMatch[2])); return true;
    }

    // Permissions API
    if (pathname === "/api/permissions/stats" && method === "GET") {
      await handlePermissionStats(res, url);
      return true;
    }
    if (pathname === "/api/permissions/pending" && method === "GET") {
      await handleGetPendingPermissions(res);
      return true;
    }
    const permMatch = pathname.match(/^\/api\/permissions\/(\d+)$/);
    if (permMatch) {
      const id = Number(permMatch[1]);
      if (method === "GET") { await handleGetPermissions(res, id); return true; }
    }
    const permActionMatch = pathname.match(/^\/api\/permissions\/(\d+)\/(respond|always)$/);
    if (permActionMatch && method === "POST") {
      const id = Number(permActionMatch[1]);
      if (permActionMatch[2] === "respond") { await handleRespondPermission(req, res, id); return true; }
      if (permActionMatch[2] === "always") { await handleAlwaysAllowPermission(req, res, id); return true; }
    }

    // --- Agents API (PRD §16, §17.7) ---
    if (pathname === "/api/agents" && method === "GET") {
      await handleListAgents(res, url); return true;
    }
    if (pathname === "/api/agents" && method === "POST") {
      await handleCreateAgent(req, res); return true;
    }
    if (pathname === "/api/agents/definitions" && method === "GET") {
      await handleListAgentDefinitions(res); return true;
    }
    const agentDetailMatch = pathname.match(/^\/api\/agents\/(\d+)$/);
    if (agentDetailMatch && method === "GET") {
      await handleGetAgent(res, Number(agentDetailMatch[1])); return true;
    }
    const agentActionMatch = pathname.match(/^\/api\/agents\/(\d+)\/(start|stop|restart)$/);
    if (agentActionMatch && method === "POST") {
      const id = Number(agentActionMatch[1]);
      const action = agentActionMatch[2] as "start" | "stop" | "restart";
      await handleAgentAction(req, res, id, action); return true;
    }
    const agentEventsMatch = pathname.match(/^\/api\/agents\/(\d+)\/events$/);
    if (agentEventsMatch && method === "GET") {
      await handleAgentEvents(res, Number(agentEventsMatch[1]), url); return true;
    }
    const agentProfileMatch = pathname.match(/^\/api\/agents\/(\d+)\/model-profile$/);
    if (agentProfileMatch && (method === "PATCH" || method === "POST")) {
      await handleSetAgentProfile(req, res, Number(agentProfileMatch[1])); return true;
    }

    // --- Tasks API ---
    if (pathname === "/api/tasks" && method === "GET") {
      await handleListTasks(res, url); return true;
    }
    const taskTreeMatch = pathname.match(/^\/api\/tasks\/(\d+)$/);
    if (taskTreeMatch && method === "GET") {
      await handleGetTaskTree(res, Number(taskTreeMatch[1])); return true;
    }
    const taskReassignMatch = pathname.match(/^\/api\/tasks\/(\d+)\/reassign$/);
    if (taskReassignMatch && method === "POST") {
      await handleReassignTask(req, res, Number(taskReassignMatch[1])); return true;
    }

    // --- Providers / Profiles API ---
    if (pathname === "/api/providers" && method === "GET") {
      await handleListProviders(res); return true;
    }
    const providerTestMatch = pathname.match(/^\/api\/providers\/(\d+)\/test$/);
    if (providerTestMatch && method === "POST") {
      await handleProviderTest(res, Number(providerTestMatch[1])); return true;
    }
    if (pathname === "/api/profiles" && method === "GET") {
      await handleListProfiles(res); return true;
    }

    // --- Runtime status ---
    if (pathname === "/api/runtime/status" && method === "GET") {
      await handleRuntimeStatus(res); return true;
    }

    sendError(res, "Not found", 404);
    return true;
  }

  // Redirect legacy /telegram/webapp/* → /webapp/*
  if (method === "GET" && pathname.startsWith("/telegram/webapp")) {
    const rest = pathname.slice("/telegram/webapp".length) || "/";
    res.writeHead(301, { Location: `/webapp${rest}` });
    res.end();
    return true;
  }

  // WebApp static files
  if (method === "GET" && pathname.startsWith("/webapp")) {
    const subpath = pathname.slice("/webapp".length) || "/";
    if (await serveWebApp(res, subpath)) return true;
  }

  // Static files (dashboard SPA)
  if (method === "GET" && !pathname.startsWith("/mcp") && pathname !== "/health" && pathname !== CONFIG.TELEGRAM_WEBHOOK_PATH) {
    if (await serveStatic(res, pathname)) return true;
  }

  return false;
}
