# Telegram Mini App — Claude Dev Hub

The Claude Dev Hub is a mobile-first WebApp embedded in the bot, accessible via the **Dev Hub** button in Telegram's menu.

---

## Opening the App

1. Open your bot chat in Telegram
2. Tap the **Dev Hub** button in the menu bar (bottom of chat)
3. The app opens as a Telegram WebApp — auto-themed to your Telegram light/dark mode

---

## Git Browser (📁)

Browse your project's git repository directly from mobile.

**File Tree:**
- Hierarchical tree with collapsible folders (dirs first, then files alphabetically)
- File icons by extension (TypeScript, JavaScript, JSON, Markdown, Python, Go, Rust, and more)
- Current branch shown in header (⎇ branch-name)
- Live search/filter — matches anywhere in the path, auto-expands matching folders

**File Viewer:**
- Syntax highlighting via `highlight.js` (12 languages)
- Line numbers, dark theme
- Click any file in the tree to view its content

**Commit Log:**
- `git log` with author, relative date, short hash
- Click any commit to view its full diff

**Working Tree Status:**
- `git status` with status badges: `M` (modified), `A` (added), `D` (deleted), `R` (renamed)
- Click any file to view its diff vs HEAD

**Diff View:**
- Color-coded unified diff: green additions / red removals / blue hunk headers

> **Note:** The git browser reads committed and working tree state directly from the host filesystem via a Docker volume mount (`${HOME}:/host-home:ro`). It does not connect to GitHub.

---

## Permission Manager (🔑)

Review and respond to Claude's permission requests from mobile — no need to be at the terminal.

- Real-time list of pending permission requests (auto-polls every 3 seconds)
- **✅ Allow** — approve this specific request
- **❌ Deny** — deny this specific request
- **♾️ Always Allow** — approve and write a pattern to `settings.local.json` so future similar requests are auto-approved

The "Always Allow" button adds a pattern like `Edit(*)` or `Bash(git *)` to your local settings, which takes effect immediately for all future sessions.

---

## Session Monitor (📊)

Live overview of all sessions.

**Status indicators:**
- 🟢 **Working** (pulsing) — Claude is actively processing
- ⚪ **Idle** — session connected but no recent activity
- 🔴 **Inactive** — session disconnected

**Session detail:**
- Project name and path
- Session source: `remote` / `local`
- Connected time
- Pending permission count

**Session Sidebar:**
- All sessions listed with source badge and status dot
- **Switch** button — switches the bot's active session for your Telegram chat
- **Delete** button — visible only for `source=local` non-active sessions; deletes all session data

---

## Authentication

The app uses Telegram's built-in auth:

1. Telegram passes `initData` to the WebApp on launch
2. The bot verifies the HMAC-SHA256 signature server-side
3. A JWT is returned in the response body
4. All subsequent API requests use `Authorization: Bearer <jwt>`

> Telegram WebView does not reliably persist cookies, so JWT is stored in memory and passed as a header.

---

## Infrastructure

- Built as a separate Vite + React app in `dashboard/webapp/`
- Built to `dashboard/webapp/dist/`, served at `/webapp/`
- `/telegram/webapp/*` redirects to `/webapp/*` for BotFather URL compatibility
- `webapp-build` Dockerfile stage runs in parallel with the main dashboard build
- `git` is installed in the production Docker image for git API support

Full technical specification: [`dashboard/webapp/SPEC.md`](../dashboard/webapp/SPEC.md)
