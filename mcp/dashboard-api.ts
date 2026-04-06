import { IncomingMessage, ServerResponse } from "http";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, extname, resolve } from "path";
import { sql } from "../memory/db.ts";
import { deleteSessionCascade } from "../sessions/delete.ts";
import { CONFIG } from "../config.ts";
import { signJwt, verifyJwt, verifyTelegramLogin, type AuthPayload } from "../dashboard/auth.ts";
import { getApiStats, getTranscriptionStats, getMessageStats, getRecentErrors } from "../utils/stats.ts";

const DIST_DIR = join(import.meta.dirname, "../dashboard/dist");

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
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
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
    SELECT id, name, project_path, status, connected_at, last_active
    FROM sessions WHERE id != 0 ORDER BY last_active DESC LIMIT 5
  `;

  sendJson(res, {
    uptime: Math.round(process.uptime()),
    db: dbCheck?.ok !== false ? "connected" : "disconnected",
    transport: CONFIG.TELEGRAM_TRANSPORT,
    sessions: { active: sessionCounts.active, total: sessionCounts.total },
    tokens24h: { input: tokens24h.input, output: tokens24h.output, total: tokens24h.total, requests: tokens24h.requests },
    recentSessions,
  });
}

async function handleSessions(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rows = await sql`
    SELECT id, name, project_path, status, connected_at, last_active
    FROM sessions WHERE id != 0 ORDER BY last_active DESC
  `;
  sendJson(res, rows);
}

async function handleSessionDetail(res: ServerResponse, id: number): Promise<void> {
  const [session] = await sql`
    SELECT id, name, project_path, client_id, status, metadata, connected_at, last_active
    FROM sessions WHERE id = ${id}
  `;
  if (!session) { sendError(res, "Session not found", 404); return; }
  const [{ count }] = await sql`SELECT count(*)::int FROM messages WHERE session_id = ${id}`;
  sendJson(res, { ...session, message_count: count });
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
  await deleteSessionCascade(id);
  sendJson(res, { ok: true });
}

async function handleRenameSession(req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  const { name } = await parseBody(req);
  if (!name) { sendError(res, "name required"); return; }
  const [row] = await sql`
    UPDATE sessions SET name = ${name} WHERE id = ${id}
    RETURNING id, name, project_path, status, connected_at, last_active
  `;
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
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const conditions = [];
  if (type) conditions.push(sql`type = ${type}`);
  if (projectPath) conditions.push(sql`project_path = ${projectPath}`);
  if (search) conditions.push(sql`content ILIKE ${"%" + search + "%"}`);

  const where = conditions.length > 0
    ? sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`
    : sql``;

  const memories = await sql`
    SELECT id, source, type, content, tags, project_path, created_at
    FROM memories ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
  `;
  const [{ total }] = await sql`SELECT count(*)::int as total FROM memories ${where}`;
  sendJson(res, { memories, total });
}

async function handleDeleteMemory(res: ServerResponse, id: number): Promise<void> {
  await sql`DELETE FROM memories WHERE id = ${id}`;
  sendJson(res, { ok: true });
}

// --- Static file serving ---

async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  let filePath = resolve(join(DIST_DIR, pathname));
  if (!filePath.startsWith(DIST_DIR)) return false; // path traversal protection
  if (!existsSync(filePath) || pathname === "/") {
    filePath = join(DIST_DIR, "index.html");
  }
  if (!existsSync(filePath)) return false;

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
    const sessionMatch = pathname.match(/^\/api\/sessions\/(\d+)(\/messages)?$/);

    if (pathname === "/api/overview" && method === "GET") {
      await handleOverview(req, res);
      return true;
    }
    if (pathname === "/api/sessions" && method === "GET") {
      await handleSessions(req, res);
      return true;
    }
    if (sessionMatch) {
      const id = Number(sessionMatch[1]);
      const sub = sessionMatch[2];
      if (sub === "/messages" && method === "GET") {
        await handleSessionMessages(res, id, url);
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
    if (pathname.match(/^\/api\/memories\/(\d+)$/) && method === "DELETE") {
      const id = Number(pathname.split("/").pop());
      await handleDeleteMemory(res, id);
      return true;
    }

    sendError(res, "Not found", 404);
    return true;
  }

  // Static files (dashboard SPA)
  if (method === "GET" && !pathname.startsWith("/mcp") && pathname !== "/health" && pathname !== CONFIG.TELEGRAM_WEBHOOK_PATH) {
    if (await serveStatic(res, pathname)) return true;
  }

  return false;
}
