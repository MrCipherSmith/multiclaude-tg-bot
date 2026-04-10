# PRD: Security Hardening

**Date:** 2026-04-10  
**Status:** Draft  
**Priority:** P0 — Fix before next release  
**Scope:** Path traversal, webhook spoofing, internal API access, port exposure, git ref injection

---

## 1. Context

A security review identified 4 High/Critical and 2 Medium vulnerabilities. None require external infrastructure changes — all are code or config fixes that can be deployed in a single Docker image rebuild.

---

## 2. Vulnerabilities

### 2.1 [CRITICAL] Path Traversal via Filename — `utils/files.ts:27`

**What:** When a user sends a document via Telegram, `doc.file_name` is used directly as the filename on disk:

```typescript
const safeName = filename ?? `${fileId}.${ext}`;
const destPath = join(INBOX_DIR, safeName);
```

`path.join()` does NOT protect against traversal. A filename of `../../.env` resolves outside `INBOX_DIR`.

**Impact:** Attacker sends a Telegram document named `../../.env` (or any sensitive file). The bot overwrites it with arbitrary content. In a container this could corrupt runtime config.

**Fix — `utils/files.ts`:**
```typescript
import { basename } from "path";

const safeName = filename
  ? basename(filename).replace(/[^a-zA-Z0-9._\-]/g, "_") || `${fileId}.${ext}`
  : `${fileId}.${ext}`;
```

**Test:** Send a document named `../../.env` — it must land in INBOX_DIR as `____env` or similar.

---

### 2.2 [HIGH] Webhook Secret Optional — `mcp/server.ts:385`

**What:** The webhook handler only validates the secret if `TELEGRAM_WEBHOOK_SECRET` is set in env:

```typescript
if (CONFIG.TELEGRAM_WEBHOOK_SECRET && secretToken !== CONFIG.TELEGRAM_WEBHOOK_SECRET) {
  res.writeHead(401); res.end(); return;
}
```

If the env var is absent — ALL webhook POSTs are accepted without authentication.

**Impact:** Anyone who knows or guesses the webhook URL can inject fake Telegram updates — forging messages from any user, including bot admins. Full privilege escalation.

**Fix — `mcp/server.ts`:** Fail hard at startup if webhook mode is enabled without a secret. Add a startup check:

```typescript
// In startMcpHttpServer() or startup entry point:
if (CONFIG.TELEGRAM_TRANSPORT === "webhook" && !CONFIG.TELEGRAM_WEBHOOK_SECRET) {
  console.error("[security] FATAL: TELEGRAM_WEBHOOK_SECRET must be set in webhook mode");
  process.exit(1);
}
```

Also add to `.env.example`:
```
TELEGRAM_WEBHOOK_SECRET=  # REQUIRED in webhook mode — generate with: openssl rand -hex 32
```

**Also fix setup wizard (`cli.ts`):** The webhook registration step must always pass `--secret-token` flag to the Telegram API.

---

### 2.3 [HIGH] `isLocalRequest` Too Broad — `mcp/server.ts:31`

**What:** Internal-only endpoints (`/api/hooks/stop`, `/mcp`, `/api/sessions/*`) trust the entire RFC 1918 range:

```typescript
return a === 10 ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 168);
```

**Impact:** In shared cloud/Docker environments, any container or host on a 10.x or 192.168.x subnet can call internal APIs. This is a realistic threat in any non-isolated Docker deployment.

**Fix:** Accept ONLY loopback and the Docker bridge (`172.17.0.0/16`). Remove `10.x` and `192.168.x`:

```typescript
function isLocalRequest(req: IncomingMessage): boolean {
  const raw = req.socket.remoteAddress ?? "";
  if (raw === "127.0.0.1" || raw === "::1" || raw === "::ffff:127.0.0.1" || raw === "") return true;
  const addr = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  const parts = addr.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;
  const [a, b] = parts;
  // Only Docker default bridge (172.17.x.x) + loopback
  return a === 172 && b === 17;
}
```

> **Note:** If the bot runs on a non-default Docker network (e.g., `172.18.x.x`), adjust the bridge range accordingly. Check with `docker network inspect claude-bot`.

---

### 2.4 [HIGH] `transcript_path` Unvalidated in `/api/hooks/stop` — `mcp/server.ts:361`

**What:** The Stop hook endpoint accepts a caller-controlled path and passes it to `readFileSync`:

```typescript
const { transcript_path, project_path } = JSON.parse(body);
extractFactsFromTranscript(transcript_path, project_path);
// → readFileSync(transcriptPath) in summarizer.ts
```

**Impact:** Combined with the broad `isLocalRequest`, any host on the Docker network can POST `{"transcript_path": "/etc/passwd", "project_path": "/"}` — the file's contents will be sent to the Claude API and stored in the memory database.

**Fix — `mcp/server.ts`:** Validate the path is inside a known safe directory before processing:

```typescript
import { resolve } from "path";

const ALLOWED_TRANSCRIPT_DIRS = [
  "/home", // Claude Code transcripts in ~/.claude/projects/
  "/root",
  "/tmp",
];

function isAllowedTranscriptPath(p: string): boolean {
  const resolved = resolve(p);
  return ALLOWED_TRANSCRIPT_DIRS.some((dir) => resolved.startsWith(dir));
}

// In the /api/hooks/stop handler:
if (!isAllowedTranscriptPath(transcript_path)) {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Invalid transcript_path" }));
  return;
}
```

---

### 2.5 [MEDIUM] Port 3847 Exposed on All Interfaces — `docker-compose.yml`

**What:**
```yaml
ports:
  - "3847:3847"
```

Binds on `0.0.0.0` — the dashboard and all APIs are publicly accessible.

**Impact:** The `/health` endpoint leaks uptime and session count without auth. The dashboard is accessible from any IP with only JWT as protection.

**Fix — `docker-compose.yml`:**
```yaml
ports:
  - "127.0.0.1:3847:3847"
```

External dashboard access → via Cloudflare Tunnel (already configured). The tunnel provides the external-facing HTTPS endpoint; the container should not be directly exposed.

---

### 2.6 [MEDIUM] Unsanitized `ref` Parameter in Git API — `mcp/dashboard-api.ts:371`

**What:**
```typescript
const ref = url.searchParams.get("ref") ?? "HEAD";
const { ok, out } = await gitExec(path, ["show", `${ref}:${file}`]);
```

While `gitExec` uses an array (no shell injection), an attacker-controlled `ref` could exploit git's own argument parsing (e.g., refs starting with `--`).

**Fix — `mcp/dashboard-api.ts`:** Validate `ref` format before use:

```typescript
const rawRef = url.searchParams.get("ref") ?? "HEAD";
const ref = /^[a-zA-Z0-9._\-\/~^:]{1,200}$/.test(rawRef) ? rawRef : "HEAD";
```

Also apply to the `diff` endpoint's `ref` parameter.

---

## 3. Implementation Plan

### Phase 1 — Code fixes (no downtime)

Order matters: fix all 6 issues in one commit.

| Step | File | Change | Time |
|------|------|--------|------|
| 1 | `utils/files.ts` | Path traversal — `basename()` + sanitize | 5 min |
| 2 | `mcp/server.ts` | Narrow `isLocalRequest` to 172.17.x.x only | 5 min |
| 3 | `mcp/server.ts` | Add `isAllowedTranscriptPath()` validation | 10 min |
| 4 | `mcp/server.ts` | Startup check: exit if webhook mode + no secret | 5 min |
| 5 | `docker-compose.yml` | Bind port to 127.0.0.1 | 2 min |
| 6 | `mcp/dashboard-api.ts` | Sanitize `ref` parameter | 5 min |
| 7 | `.env.example` | Document `TELEGRAM_WEBHOOK_SECRET` as required | 2 min |

### Phase 2 — Deploy (requires downtime ~2 min)

```bash
cd ~/bots/claude-bot

# 1. Verify TELEGRAM_WEBHOOK_SECRET is set in .env
grep TELEGRAM_WEBHOOK_SECRET .env

# 2. Rebuild the bot image with new code
docker compose build bot

# 3. Restart (bot will exit on startup if secret missing)
docker compose up -d bot

# 4. Verify health
curl http://localhost:3847/health
```

### Phase 3 — Verification

```bash
# Test path traversal fix
# Send a Telegram document named "../../.env" — must land as "__..__.env" or similar in inbox

# Test isLocalRequest — from a container on 10.x network:
docker run --rm curlimages/curl curl -sf http://host:3847/api/sessions/register
# → must get 403

# Test webhook without secret:
# Start bot without TELEGRAM_WEBHOOK_SECRET → must fail on startup with FATAL message

# Test transcript_path validation:
curl -X POST http://localhost:3847/api/hooks/stop \
  -H "Content-Type: application/json" \
  -d '{"transcript_path": "/etc/passwd", "project_path": "/tmp"}'
# → must get 400 Invalid transcript_path
```

---

## 4. Acceptance Criteria

- [ ] Document named `../../.env` sent via Telegram lands safely in INBOX_DIR with sanitized name
- [ ] Bot refuses to start in webhook mode without `TELEGRAM_WEBHOOK_SECRET`
- [ ] `/api/hooks/stop` with `transcript_path=/etc/passwd` returns 400
- [ ] Port 3847 not reachable from external IP (only via Cloudflare Tunnel)
- [ ] `ref=--upload-pack=malicious` in git API is silently replaced with `HEAD`
- [ ] `bun test tests/unit/` — all 77 tests pass
- [ ] Docker container starts and passes `/health` check

---

## 5. What Does NOT Need to Change

- Access control middleware (`bot/access.ts`) — already correct
- JWT auth on dashboard — already correct
- Telegram user allowlist — already correct
- MCP auth flow — already correct
