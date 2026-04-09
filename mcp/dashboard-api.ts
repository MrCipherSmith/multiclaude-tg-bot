import { IncomingMessage, ServerResponse } from "http";
import { readFile, access, writeFile } from "fs/promises";
import { join, extname, resolve } from "path";
import { homedir } from "os";
import { sql } from "../memory/db.ts";
import { sessionManager } from "../sessions/manager.ts";
import { CONFIG } from "../config.ts";
import { signJwt, verifyJwt, verifyTelegramLogin, verifyWebAppInitData, type AuthPayload } from "../dashboard/auth.ts";
import { getApiStats, getTranscriptionStats, getMessageStats, getRecentErrors } from "../utils/stats.ts";
import { isIndexing } from "../memory/long-term.ts";
import { addSSEClient, removeSSEClient, getSSEClientCount } from "./notification-broadcaster.ts";
import { sessionService } from "../services/session-service.ts";
import { projectService } from "../services/project-service.ts";

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
  const ref = url.searchParams.get("ref") ?? "HEAD";
  const { ok, out } = await gitExec(path, ["show", `${ref}:${file}`]);
  if (!ok) { sendError(res, out || "File not found", 404); return; }
  sendJson(res, { content: out });
}

async function handleGitDiff(res: ServerResponse, sessionId: number, url: URL): Promise<void> {
  const path = await getSessionPath(sessionId);
  if (!path) { sendError(res, "Session not found", 404); return; }
  const ref = url.searchParams.get("ref") ?? "HEAD~1";
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
    WHERE session_id = ${sessionId} AND status = 'pending'
    ORDER BY created_at ASC
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

// --- WebApp auth ---

async function handleAuthWebApp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { initData } = await parseBody(req);
  if (!initData || typeof initData !== "string") {
    console.log("[webapp-auth] missing initData");
    sendError(res, "initData required"); return;
  }

  const params = new URLSearchParams(initData);
  const authDate = Number(params.get("auth_date"));
  const age = Math.round(Date.now() / 1000 - authDate);
  console.log(`[webapp-auth] initData received, auth_date age=${age}s, hash=${params.get("hash")?.slice(0, 8)}...`);

  const user = verifyWebAppInitData(initData);
  if (!user) {
    console.log(`[webapp-auth] verification failed — age=${age}s (limit=3600), token=${CONFIG.TELEGRAM_BOT_TOKEN.slice(0, 10)}...`);
    sendError(res, "Invalid initData", 401); return;
  }

  const allowed = CONFIG.ALLOWED_USERS.map(Number);
  console.log(`[webapp-auth] user=${user.id} (${user.username}), allowed=${allowed.join(",")}`);
  if (!allowed.includes(user.id)) { sendError(res, "Forbidden", 403); return; }

  const token = await signJwt(user);
  console.log(`[webapp-auth] success for user=${user.id}`);
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
      console.log(`[sessions] cookie=${req.headers.cookie?.slice(0, 40) ?? "none"}`);
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

    // Permissions API
    if (pathname === "/api/permissions/stats" && method === "GET") {
      await handlePermissionStats(res, url);
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
