# Telegram Mini App — Claude Dev Hub: Implementation Spec

## Overview

A Telegram Mini App (WebApp) embedded in @GoodeaAIBot that provides a mobile-first interface for monitoring Claude sessions, browsing git repositories, and managing permission requests. Served at `/webapp/` by the bot's HTTP server.

---

## Architecture

```
Telegram Mini App (React SPA)
    ↕ HTTPS / initData auth (JWT cookie)
Bot API (mcp/dashboard-api.ts)
    ├─ POST /api/auth/webapp          ← initData HMAC verification
    ├─ GET  /api/sessions             ← session list (existing)
    ├─ GET  /api/sessions/:id         ← session detail (existing)
    ├─ GET  /api/git/:sessionId/tree       → git ls-tree HEAD
    ├─ GET  /api/git/:sessionId/file       → git show HEAD:path
    ├─ GET  /api/git/:sessionId/diff       → git diff <ref>
    ├─ GET  /api/git/:sessionId/log        → git log --pretty
    ├─ GET  /api/git/:sessionId/status     → git status --porcelain
    ├─ GET  /api/git/:sessionId/branches   → git branch -a
    ├─ GET  /api/git/:sessionId/commit/:hash → git show <hash>
    ├─ GET  /api/permissions/:sessionId    → pending permission_requests
    ├─ POST /api/permissions/:id/respond   → allow|deny
    └─ POST /api/permissions/:id/always    → always allow (writes settings.local.json)
```

---

## File Structure

```
dashboard/webapp/
├─ package.json              # Separate Vite app (React + Tailwind)
├─ vite.config.ts            # base: /webapp/, proxy: /api → localhost:3847
├─ tsconfig.json
├─ index.html                # Loads Telegram WebApp JS SDK
└─ src/
   ├─ main.tsx
   ├─ index.css              # Telegram CSS variables (--tg-theme-*)
   ├─ api.ts                 # Typed API client
   ├─ App.tsx                # Auth gate + session sidebar + tab nav
   └─ components/
      ├─ GitBrowser.tsx      # Files | Log | Status tabs
      ├─ PermissionList.tsx  # Pending permissions + Allow/Deny/Always
      └─ SessionMonitor.tsx  # Session status + last active + pending count
```

---

## Authentication

**Endpoint:** `POST /api/auth/webapp`  
**Body:** `{ initData: string }` — raw Telegram `WebApp.initData` string  
**Algorithm:**
1. Parse initData as URLSearchParams
2. Extract `hash`, delete from params
3. Check `auth_date` freshness (≤ 1 hour)
4. Build `data_check_string`: sorted `key=value\n...` pairs
5. `secret_key = HMAC-SHA256("WebAppData", bot_token)`
6. `computed = HMAC-SHA256(data_check_string, secret_key)`
7. Timing-safe compare with `hash`
8. Parse `user` JSON, verify against `ALLOWED_USERS`
9. Sign JWT, set `auth` cookie (HttpOnly, SameSite=None; Secure)

**Dev mode:** Auth skipped when `import.meta.env.DEV` and no `Telegram.WebApp.initData`.

---

## Git API

All git endpoints:
- Require JWT auth cookie
- Resolve `project_path` from `sessions` table via `sessionId`
- Map host path → container path via `hostToContainerPath()`:
  ```
  /home/user/project → /host-home/project
  (requires ${HOME}:/host-home:ro in docker-compose.yml)
  ```
- Execute git via `Bun.spawn(["git", ...args], { cwd: containerPath })`

### Endpoints

| Method | Path | Git command | Query params |
|--------|------|------------|-------------|
| GET | `/api/git/:id/tree` | `git ls-tree --name-only -r HEAD` | — |
| GET | `/api/git/:id/file` | `git show HEAD:path` | `path`, `ref` |
| GET | `/api/git/:id/diff` | `git diff <ref>` | `ref` (default HEAD~1), `path` |
| GET | `/api/git/:id/log` | `git log --pretty=format:%H\|%h\|%s\|%an\|%ar` | `limit` (max 200) |
| GET | `/api/git/:id/status` | `git status --porcelain` | — |
| GET | `/api/git/:id/branches` | `git branch -a --format=%(refname:short)\|%(HEAD)` | — |
| GET | `/api/git/:id/commit/:hash` | `git show <hash> --stat --patch` | — |

---

## Permissions API

Wraps existing `permission_requests` table.

| Method | Path | Action |
|--------|------|--------|
| GET | `/api/permissions/:sessionId` | List pending (response IS NULL) |
| POST | `/api/permissions/:id/respond` | `{ response: "allow"\|"deny" }` → UPDATE |
| POST | `/api/permissions/:id/always` | Adds `ToolName(*)` to `settings.local.json`, sets response='allow' |

**Always Allow path resolution:**
1. Check `HOST_CLAUDE_CONFIG/projects/<encoded_path>/settings.local.json`
2. Fall back to `HOST_CLAUDE_CONFIG/settings.local.json`
3. Merge `permissions.allow` array (no duplicates), write back

`HOST_CLAUDE_CONFIG` = `/host-claude-config` (mounted from `~/.claude`)

---

## Frontend Components

### App.tsx
- Reads `window.Telegram.WebApp.initData` on mount
- POSTs to `/api/auth/webapp`, gets JWT cookie
- Loads session list, auto-selects first active session
- Sidebar: session list with status dots, source label, project path
- Header: current session name + status dot
- Bottom nav: Files (📁) | Permissions (🔑) | Monitor (📊)

### GitBrowser.tsx
Three sub-tabs:

**Files:** `git ls-tree` → file list with fuzzy filter → click → `git show HEAD:path` → `<pre>` viewer with Back button

**Log:** `git log` → commit list (short hash + subject + author + date) → click → `git show <hash>` → `DiffView` with color coding

**Status:** `git status --porcelain` → modified/staged/untracked files → click → `git diff HEAD -- file` → `DiffView`

**DiffView:** Line-by-line color coding: green (`+`), red (`-`), blue (`@@`), gray (headers)

### PermissionList.tsx
- Auto-polls `GET /api/permissions/:sessionId` every 3s
- Shows tool name, description (in `<pre>`), timestamp
- Allow (green) / Deny (red) / Always ♾️ (blue) buttons
- Pending state with `disabled` + opacity during API call

### SessionMonitor.tsx
- Polls session detail + permissions every 3s
- Status banner: Working (pulse green) / Idle (blue) / Inactive (gray)
  - "Working" = active + last_active < 10s ago
- Session info table (ID, project, source, status, path, connected)
- Pending permissions count

---

## Docker Changes

`docker-compose.yml`:
```yaml
volumes:
  - ${HOME}:/host-home:ro   # NEW: host filesystem read-only access for git
```

`Dockerfile`: Added `webapp-build` stage before production:
```dockerfile
FROM base AS webapp-build
COPY dashboard/webapp/package.json dashboard/webapp/bun.lock* ./dashboard/webapp/
RUN cd dashboard/webapp && bun install --frozen-lockfile
COPY dashboard/webapp/ dashboard/webapp/
RUN cd dashboard/webapp && bun run build

# In production stage:
COPY --from=webapp-build /app/dashboard/webapp/dist dashboard/webapp/dist
```

---

## Bot Menu Button

Configured in `bot/bot.ts` at startup:
```typescript
bot.api.setChatMenuButton({
  menu_button: {
    type: "web_app",
    text: "Dev Hub",
    web_app: { url: "https://your-domain.com/webapp/" }
  }
})
```
Only set when `TELEGRAM_WEBHOOK_URL` is configured (requires HTTPS for Telegram Mini Apps).

---

## CSS / Theming

Uses Telegram CSS variables automatically set by `telegram-web-app.js`:
- `--tg-theme-bg-color` → page background
- `--tg-theme-text-color` → primary text
- `--tg-theme-hint-color` → secondary/muted text
- `--tg-theme-button-color` → accent/active color
- `--tg-theme-secondary-bg-color` → cards/headers background

Dark/light theme follows user's Telegram app theme automatically.

---

## Non-Goals (Phase 1)

- File editing (read-only)
- Sending messages to Claude from WebApp
- GitHub API integration (Phase 2)
- Push notifications
- Multi-user access control beyond ALLOWED_USERS
