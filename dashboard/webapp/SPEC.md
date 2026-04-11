# Helyx — Telegram WebApp Specification

## Overview

A Telegram Mini App embedded in Helyx, providing a mobile-optimized interface for managing Claude Code sessions. The webapp is served at `/webapp/` and opens via the bot's menu button.

## Architecture

```
Telegram WebApp (React)
  ↕ fetch + Authorization: Bearer <jwt>
Bot API Server (Bun HTTP, port 3847)
  ↕ SQL
PostgreSQL (sessions, memories, permission_requests)
  ↕ git exec
Host filesystem (via /host-home volume mount)
```

### Auth Flow

1. Telegram injects `window.Telegram.WebApp.initData` when the app is opened
2. App calls `POST /api/auth/webapp` with `{ initData }`
3. Server verifies HMAC-SHA256 signature using bot token (per Telegram spec)
4. Server returns `{ ok, user, token }` — JWT signed with bot token derived secret
5. Token stored in module-level `_token` variable in `api.ts`
6. All subsequent API requests send `Authorization: Bearer <token>`
7. `getUser()` checks Bearer header first, then falls back to `token` cookie (dashboard compat)

### Cookie policy note

Telegram WebView does NOT reliably persist cookies. All auth uses Bearer tokens in memory.

---

## URL Routes

| Path | Description |
|------|-------------|
| `/webapp/` | Serves React SPA (index.html) |
| `/webapp/assets/*` | Static assets (JS, CSS) |
| `/telegram/webapp/*` | 301 redirect → `/webapp/*` (BotFather legacy URL) |
| `/api/auth/webapp` | POST — authenticate with Telegram initData |
| `/api/sessions` | GET — list all non-standalone sessions |
| `/api/sessions/active` | GET — active session for the authenticated user (from chat_sessions table) |
| `/api/sessions/:id` | GET — session detail (includes message_count, tokens, recent_tools) |
| `/api/sessions/:id/messages` | GET `?limit=&offset=` — paginated message history (newest first) |
| `/api/sessions/:id/switch` | POST — make session active for the authenticated user |
| `/api/sessions/:id` | DELETE — delete session (cascade) |
| `/api/git/:id/tree` | GET — git ls-tree for session project path |
| `/api/git/:id/file` | GET `?path=&ref=` — file contents at ref |
| `/api/git/:id/diff` | GET `?ref=&path=` — git diff |
| `/api/git/:id/log` | GET `?limit=` — commit log |
| `/api/git/:id/status` | GET — working tree status |
| `/api/git/:id/branches` | GET — branch list |
| `/api/git/:id/commit/:hash` | GET — single commit diff |
| `/api/permissions/:id` | GET — pending permission requests for session |
| `/api/permissions/:id/respond` | POST `{ response: "allow"\|"deny" }` |
| `/api/permissions/:id/always` | POST — add to auto-approve |

---

## Components

### App.tsx — Root

- Auth state machine: `Connecting → Authed | AuthError`
- Session state: `sessions[]`, `selectedSession`
- Sidebar: session list with `SessionCard` components
- Session selection: calls `/api/sessions/active` to get the user's actual active session (from `chat_sessions` table); falls back to first active session if not set
- Bottom nav: Files / Perms / Messages / Monitor tabs (only when session selected)
- Auto-opens sidebar when sessions exist but none is active

### SessionCard

Props: `session, selected, onSelect, onSwitch, onDelete`

Buttons:
- **Switch** — visible when session is not active; calls `POST /api/sessions/:id/switch` to make it the bot's active session for this user
- **Delete** — visible when `source === "local"` and `status !== "active"`; calls `DELETE /api/sessions/:id`

Source badge colors: `remote` → purple, `local` → blue, `standalone` → gray

### GitBrowser.tsx

Three sub-tabs: **Files**, **Log**, **Changes**

#### FileTree

- Fetches flat file list from `/api/git/:id/tree`
- Parses into hierarchical `TreeNode[]` with `buildTree()`
- Folders sorted before files, both alphabetically
- `filterTree(query)` — filters matching files, auto-expands parent folders
- Search input with live filter
- File icons via `getFileIcon(path)` — extension-based colored badges
- Folder icons (open/closed SVG)
- Click file → `CodeViewer` with syntax highlighting

#### CodeViewer

- Uses `highlight.js` (registered languages: ts, js, py, bash, json, css, xml, sql, yaml, md, rs, go)
- Language detected via `getLang(path)` extension map
- Dark theme with custom token colors (Material Palenight inspired)
- Line numbers in left column
- Back button returns to tree

#### CommitLog

- Fetches `git log` (50 commits)
- Each commit: icon dot, short hash badge, subject, author, relative date
- Click → shows full diff via `DiffView`

#### GitStatus

- Fetches `git status --porcelain`
- Status badge: M/A/D/R/? with color coding
- File icon per file
- Click → shows working-tree diff via `DiffView`

#### DiffView

Colored diff lines:
- `+` lines → green background
- `-` lines → red background  
- `@@` hunks → blue
- `diff/index/---/+++` headers → dimmed

### SessionMonitor.tsx

- Polls session detail every 5s (manual refresh button also available)
- Status banner: Working (green pulse, last_active <10s) / Idle (blue) / Inactive (gray)
- Session metadata: ID, Project, Source, Status, Path, Connected time, Message count
- **Token Usage** section: API calls, total/input/output tokens for session lifetime (hidden if zero)
- **Tool Calls** section: last 15 tool calls with color-coded status dot (green=allow, red=deny, yellow=pending) and relative time
- SessionDetail API response includes: `message_count`, `tokens: { input_tokens, output_tokens, total_tokens, api_calls }`, `recent_tools: [{ tool_name, response, created_at }]`

### MessageHistory.tsx

- 💬 Messages tab — chronological chat history for selected session
- Bubble UI: user messages on right (blue), assistant on left (dark), system messages on left (yellow tint)
- Long messages (>400 chars) truncated with "tap to expand" affordance
- Loads 30 messages per page; "Load older" button shows remaining count
- Auto-scrolls to bottom on first load; auto-refreshes every 5s
- Uses `GET /api/sessions/:id/messages?limit=30&offset=N` (messages returned newest-first, reversed for display)

### PermissionList.tsx

- Lists pending permission requests for selected session
- Allow / Always / Deny buttons
- Calls `/api/permissions/:id/respond` or `/api/permissions/:id/always`

---

## File Icons (`utils/fileIcons.ts`)

Two-level lookup:
1. **Filename exact match** (e.g. `dockerfile`, `.gitignore`, `package.json`)
2. **Extension match** (e.g. `.ts` → `{ icon: "TS", color: "#3178c6" }`)

Icon rendered as colored text badge with matching border/background tint. Emoji icons (🐳, 🔒) rendered as-is.

`getLang(path)` maps extension → highlight.js language name for syntax highlighting.

---

## Git API — Host Path Mapping

Sessions store `project_path` as the absolute path on the **host** machine.
The host home directory is mounted read-only into the container at `/host-home`.

`hostToContainerPath(hostPath)`:
- `HOST_HOME` env var = host `$HOME` (e.g. `/home/altsay`)
- Replace prefix: `/home/altsay/...` → `/host-home/...`

All git commands include `-c safe.directory=*` to bypass ownership checks (container uid ≠ host uid).

---

## Security

- Telegram `initData` verified with `HMAC-SHA256(data_check_string, HMAC-SHA256("WebAppData", bot_token))`
- `auth_date` freshness check: max 1 hour old
- `ALLOWED_USERS` whitelist (Telegram user IDs from config)
- JWT signed with `HMAC-SHA256("jwt:" + bot_token)` derived secret, 7-day expiry
- All `/api/*` routes require valid JWT (Bearer or cookie)
- CSRF protection on state-changing requests (Origin header check)
- Git paths validated against session's project_path (no free-form path traversal)
- `/host-home` mounted `:ro` (read-only) — git write operations not possible

---

## Build

```bash
# Development
cd dashboard/webapp && bun dev  # proxy /api → localhost:3847

# Production (Dockerfile stage: webapp-build)
cd dashboard/webapp && bun run build
# Output: dashboard/webapp/dist/
# Served by bot at /webapp/*
# NOTE: dist/ is baked into Docker image — changes require docker compose up --build -d bot
```

### Cache Policy

- `index.html` → `Cache-Control: no-store` (always fresh)
- `assets/*.js`, `assets/*.css` → `Cache-Control: public, max-age=31536000, immutable` (content-hashed names)

Dependencies: `react`, `react-dom`, `highlight.js`, `tailwindcss`, `vite`
