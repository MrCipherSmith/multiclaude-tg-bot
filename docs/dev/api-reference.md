# Helyx API Reference

This document covers all interfaces a developer integrating with or building on top of Helyx needs to know: the Telegram bot command surface, the two MCP tool layers (stdio channel adapter and HTTP Docker server), the dashboard REST API, and the WebApp Mini App API.

---

## Part 1: Telegram Bot Commands

All commands are gated by `accessMiddleware`. Only users whose Telegram ID appears in `ALLOWED_USERS`, or when `ALLOW_ALL_USERS=true`, can interact with the bot. Unauthorized updates are silently dropped.

### Session Management

| Command | Arguments | Description |
|---|---|---|
| `/start` | — | Welcome message with a condensed command list |
| `/help` | — | Full categorized help text |
| `/sessions` | — | List all sessions with status; inline delete buttons for inactive local sessions |
| `/switch` | `[id]` | Switch the active session; prompts for ID if omitted; loads project context briefing |
| `/standalone` | — | Switch to standalone mode (Anthropic API, no Claude Code CLI) |
| `/session` | — | Show current session name, project path, status, and source |
| `/rename` | — | Rename the current session (prompts for new name) |
| `/remove` | — | Remove a session record from the database |
| `/cleanup` | — | Drop all inactive sessions |

### Memory

| Command | Arguments | Description |
|---|---|---|
| `/remember` | `[text]` | Save a memory; prompts for content if omitted |
| `/recall` | `<query>` | Semantic search over long-term memory |
| `/memories` | — | List stored memories with type and tags |
| `/forget` | `<id>` | Delete a memory by its numeric ID |
| `/clear` | — | Clear the short-term message context for the current session |
| `/summarize` | — | Force-summarize the current session context now |
| `/resume` | — | Inject the last saved summary into the active session queue (use after a restart) |
| `/memory_export` | `[path]` | Export memories as a JSON file sent to Telegram |
| `/memory_import` | — | Import memories from a JSON file (attach as document or reference by path) |

### Projects

| Command | Arguments | Description |
|---|---|---|
| `/add` | — | Register the current (or specified) directory as a Claude Code session project |
| `/projects` | — | List all projects with start/stop inline buttons |
| `/project_add` | — | Add a new project (with optional forum topic creation) |
| `/project_facts` | — | Show facts and memories for the current project |
| `/project_scan` | — | Scan the project directory and save structural knowledge to memory |

### Forum / Topic Mode

| Command | Arguments | Description |
|---|---|---|
| `/forum_setup` | — | Configure forum supergroup chat; create topics for all projects; pin Dev Hub button |
| `/forum_sync` | — | Re-sync topics: create any missing ones |
| `/forum_clean` | — | Remove orphaned forum topics |
| `/forum_hub` | — | Send or re-send the Dev Hub WebApp pinned button to the General topic |
| `/topic_rename` | — | Rename the current project forum topic |
| `/topic_close` | — | Close the current project forum topic |
| `/topic_reopen` | — | Reopen the current project forum topic |

### Monitoring & Admin

| Command | Arguments | Description |
|---|---|---|
| `/status` | — | Bot health: DB connection, active sessions, uptime |
| `/stats` | — | API token usage, request latency, per-session breakdown |
| `/logs` | `[id]` | Session request logs (filtered by session ID if provided) |
| `/pending` | — | List pending tool permission requests |
| `/permission_stats` | — | Permission approval and denial statistics by tool |
| `/session_export` | — | Export full session data as a file |
| `/tools` | — | List all available MCP tools |
| `/skills` | — | List skills from the `goodai-base` registry |
| `/rules` | — | List rules from the `goodai-base` registry |
| `/commands` | — | List all available bot commands |
| `/hooks` | — | List configured Claude Code hooks |
| `/monitor` | — | Process health dashboard (Docker container, tmux, admin-daemon) with inline actions |
| `/system` | — | System control panel: start/stop/restart actions (admin-only) |
| `/interrupt` | — | Send Escape to the current tmux session (forum-topic-aware) |
| `/remote_control` | — | Show tmux session status with start/stop inline buttons |
| `/menu` | — | Two-level command navigator inline menu |

### Claude Model Selection

| Command | Arguments | Description |
|---|---|---|
| `/model` | — | Select Claude model via inline keyboard (fetches live list from Anthropic API) |

### Codex Integration

| Command | Arguments | Description |
|---|---|---|
| `/codex_setup` | — | Authenticate Codex CLI via device auth flow |
| `/codex_status` | — | Check Codex login status |
| `/codex_review` | `[prompt]` | Run an AI code review via Codex |

### Onboarding

| Command | Arguments | Description |
|---|---|---|
| `/quickstart` | — | Step-by-step guide for forum and project setup |

---

## Part 2: MCP Tools — stdio Channel Adapter

The stdio adapter (`channel/`) runs on the **host machine** alongside Claude Code CLI. Claude Code connects to it over stdin/stdout. These tools are the primary interface Claude uses during a session.

Transport: `StdioServerTransport` (MCP SDK)
Trust boundary: process boundary (no network auth)

Every tool call also touches `sessions.last_active = now()` to prevent idle timeout.

### `reply`

Send a message to a Telegram chat. Converts Markdown to Telegram HTML, optionally attaches a TTS voice clip, buffers the message to the `pending_replies` table before sending (crash-safe delivery), and routes to the correct forum topic when in forum mode.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chat_id` | string | Yes | Telegram chat ID |
| `text` | string | Yes | Message text (Markdown supported) |

### `remember`

Save a fact, note, decision, or summary to long-term memory. Generates an Ollama embedding and inserts into the `memories` table with pgvector indexing.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | Yes | Text to remember (write as a self-contained sentence) |
| `type` | string | No | One of `fact`, `summary`, `decision`, `note` (default: `note`) |
| `tags` | string[] | No | Tags for categorization |

### `recall`

Semantic search over long-term memory using pgvector cosine distance.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Natural language search query |
| `limit` | number | No | Maximum results (default: 5) |

### `forget`

Delete a memory by its numeric ID.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | number | Yes | Memory ID to delete |

### `update_status`

Update the live Telegram status message visible to the user while Claude is working. Optionally sends or edits a companion "diff" message showing file changes.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chat_id` | string | Yes | Telegram chat ID |
| `status` | string | Yes | Short status text, e.g. `"Analyzing code"`, `"Running tests"` |
| `diff` | string | No | Optional diff or code block shown as a separate message |

### `list_memories`

List memories with optional filters, ordered by recency.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `type` | string | No | Filter by type: `fact`, `summary`, `decision`, or `note` |
| `limit` | number | No | Maximum results (default: 20) |

### `search_project_context`

Semantic search over `project_context` and `summary` type memories scoped to a project path. Use this at session start to load context from prior sessions.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Natural language search query |
| `project_path` | string | No | Project path to search in; defaults to current session's project path |
| `limit` | number | No | Results to return (default: 5, max: 20) |

### `scan_project_knowledge`

Scan a project directory tree and save structural knowledge (tech stack, entry points, architecture) to long-term memory.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_path` | string | No | Directory to scan; defaults to current session project path |
| `force_rescan` | boolean | No | Archive existing project knowledge and rescan from scratch (default: false) |

### `react`

Set an emoji reaction on a Telegram message via `setMessageReaction`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chat_id` | string | Yes | Telegram chat ID |
| `message_id` | number | Yes | Target message ID |
| `emoji` | string | Yes | Single emoji character, e.g. `"👍"`, `"🔥"` |

### `edit_message`

Edit a previously sent bot message. Attempts HTML parse mode first; falls back to plain text on parse error.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chat_id` | string | Yes | Telegram chat ID |
| `message_id` | number | Yes | Message ID to edit |
| `text` | string | Yes | New message text |

### `send_poll`

Send one or more Telegram polls to the user for multi-choice clarification. Creates a `poll_sessions` DB record; user answers are collected by the bot and returned as a follow-up message to Claude.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chat_id` | string | Yes | Telegram chat ID |
| `title` | string | No | Brief description shown before the polls |
| `questions` | array | Yes | Array of `{ question: string, options: string[] }` objects; 2–10 options each |

### `skill_view`

Load a skill file from `goodai-base/skills/` and return its content with inline shell token expansion (`!`cmd`` syntax resolved at runtime).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Skill name in kebab-case, e.g. `"git-state"` |

### `propose_skill`

Distill a session transcript into a new `SKILL.md` and send an approval message to Telegram. Creates an `agent_created_skills` row with `proposed` status.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `transcript` | string | Yes | Session transcript for distillation |
| `name` | string | No | Suggested skill name (kebab-case) |
| `description` | string | No | One-line description starting with "Use when" |
| `body` | string | No | Explicit SKILL.md body (skips distillation if provided) |
| `chat_id` | string | No | Telegram chat ID for the approval message |

### `save_skill`

Approve or reject a proposed skill by its ID.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `skill_id` | number | Yes | Skill ID returned by `propose_skill` |
| `approved` | boolean | Yes | `true` to approve, `false` to reject |

### `list_agent_skills`

List all active agent-created skills. No parameters.

### `curator_run`

Manually trigger the skill curator, which reviews and pins or archives agent-created skills. No parameters.

### `curator_status`

Get recent curator run history.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | number | No | Number of runs to return (default: 10) |

---

## Part 3: MCP Tools — HTTP Docker Server

The HTTP MCP server (`mcp/`) runs **inside the Docker container** on port 3847. Claude Code connects to it over `POST /mcp` (StreamableHTTP transport). Access is restricted to loopback and Docker bridge networks (`172.16.0.0/12`); no external callers can reach this surface.

The tool surface is the same 16 tools as the stdio adapter, but the schemas have additional parameters available here. Key differences from the channel adapter:

- `remember` accepts a `source` parameter (`telegram`, `cli`, or `api`).
- `recall` accepts `type` and `tags` filters (not just `query` + `limit`).
- `list_memories` accepts an `offset` parameter for pagination.
- `reply`, `react`, and `edit_message` accept an optional `parse_mode` field (`Markdown`, `MarkdownV2`, or `HTML`).
- `set_session_name` accepts `project_path` to set the working directory.
- `search_project_context` and `propose_skill` accept the same extended parameters as the channel adapter.

### Tool Schemas (HTTP server)

#### `remember`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | Yes | Information to save |
| `type` | string | No | `fact`, `summary`, `decision`, or `note` (default: `note`) |
| `tags` | string[] | No | Tags for categorization |
| `source` | string | No | `telegram`, `cli`, or `api` (default: `cli`) |

#### `recall`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Search query |
| `limit` | number | No | Max results (default: 5) |
| `type` | string | No | Filter by memory type |
| `tags` | string[] | No | Filter by tags |

#### `forget`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | number | Yes | Memory ID to delete |

#### `list_memories`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `type` | string | No | Filter by type |
| `tags` | string[] | No | Filter by tags |
| `limit` | number | No | Page size (default: 20) |
| `offset` | number | No | Pagination offset (default: 0) |

#### `reply`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chat_id` | string | Yes | Telegram chat ID |
| `text` | string | Yes | Message text |
| `parse_mode` | string | No | `Markdown`, `MarkdownV2`, or `HTML` |

#### `react`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chat_id` | string | Yes | Telegram chat ID |
| `message_id` | number | Yes | Message ID |
| `emoji` | string | Yes | Reaction emoji |

#### `edit_message`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chat_id` | string | Yes | Telegram chat ID |
| `message_id` | number | Yes | Message ID to edit |
| `text` | string | Yes | New text |
| `parse_mode` | string | No | `Markdown`, `MarkdownV2`, or `HTML` |

#### `list_sessions`

No parameters. Returns all registered sessions.

#### `session_info`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session_id` | number | Yes | Session ID |

#### `set_session_name`

Call this at the start of a session to associate a human-readable name and project path with the current MCP connection.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Human-readable session name (e.g. project name) |
| `project_path` | string | No | Working directory path |

#### `search_project_context`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Natural language search query |
| `project_path` | string | No | Project path; defaults to current session path |
| `limit` | number | No | Results (default: 5, max: 20) |

#### `skill_view`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Skill name in kebab-case |

#### `propose_skill`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `transcript` | string | Yes | Session transcript for distillation |
| `name` | string | No | Suggested skill name (kebab-case) |
| `description` | string | No | One-line description |
| `body` | string | No | Explicit SKILL.md body |
| `chat_id` | string | No | Telegram chat ID for approval |

#### `save_skill`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `skill_id` | number | Yes | Skill ID from `propose_skill` |
| `approved` | boolean | Yes | Approve or reject |

#### `list_agent_skills`

No parameters.

#### `curator_run`

No parameters.

#### `curator_status`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | number | No | Number of runs to return (default: 10) |

---

## Part 4: Dashboard REST API

Base URL: `http(s)://<host>:3847/api`

All `/api/*` routes (except auth and SSE) require authentication via either:
- An `HttpOnly` cookie named `token` (main dashboard, set after Telegram Login Widget flow)
- `Authorization: Bearer <token>` header (WebApp Mini App)

State-changing requests (non-GET/HEAD) also enforce CSRF protection: the `Origin` header must match the `Host` header.

### Authentication

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/telegram` | Telegram Login Widget flow. Verifies `hash` via HMAC-SHA256; issues a 7-day `HttpOnly` JWT cookie. |
| `POST` | `/api/auth/webapp` | Telegram Mini App flow. Verifies `initData` via HMAC-SHA256; returns `{ ok, user, token }` with a Bearer JWT. |
| `GET` | `/api/auth/me` | Validate current session; returns the decoded JWT payload or 401. |
| `POST` | `/api/auth/logout` | Clears the `token` cookie. |

### Overview & Stats

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/overview` | System uptime, DB status, transport mode, active/total session counts, 24h token usage, recent sessions, SSE client count. |
| `GET` | `/api/stats` | Aggregate API, transcription, and message stats. |
| `GET` | `/api/stats/daily?days=N` | Daily token usage time-series (default 30 days, max 365). Returns array of `{ date, requests, input_tokens, output_tokens, total_tokens, errors }`. |
| `GET` | `/api/stats/errors?limit=N` | Recent API error records (default 20, max 100). |
| `GET` | `/api/stats/claude-code?days=N` | Claude Code usage across projects parsed from local project stats files. |

### Sessions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sessions` | List all sessions (name, project, status, source, last active). |
| `GET` | `/api/sessions/active` | Active session for the authenticated user's Telegram chat ID. |
| `GET` | `/api/sessions/:id` | Full session detail. |
| `GET` | `/api/sessions/:id/messages?limit=&offset=` | Paginated message history (max 200 per page). |
| `GET` | `/api/sessions/:id/stats?days=N` | Per-session token stats broken down by model (summary + `by_model` array). |
| `GET` | `/api/sessions/:id/timeline?limit=&offset=` | Merged chronological timeline of messages, tool calls, and memory entries. |
| `PATCH` | `/api/sessions/:id` | Rename session. Body: `{ name: string }`. |
| `DELETE` | `/api/sessions/:id` | Delete session and associated data. |
| `POST` | `/api/sessions/:id/switch` | Switch the authenticated user's active session to `:id`. |

#### Internal session endpoints (local network only, no JWT)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/sessions/register` | Register a project session from shell CLI. Body: `{ projectPath, name?, cliType?, cliConfig? }`. Returns `{ ok, sessionId, name }`. |
| `POST` | `/api/sessions/expect` | Pre-register an expected MCP connection from `channel.ts`. Body: `{ session_id: number }`. |
| `POST` | `/api/sessions/:id/summarize-work` | Trigger session work summarization. Runs in background; returns `{ ok, skipped }`. |
| `POST` | `/api/summarize` | Trigger disconnect summarization. Body: `{ session_id, project_path? }`. Runs in background. |
| `POST` | `/api/hooks/stop` | Claude Code Stop hook receiver. Body: `{ transcript_path, project_path }`. Extracts facts from transcript in background. |

### Logs

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/logs?session_id=&level=&search=&limit=&offset=` | Paginated request log with optional filters. Returns `{ logs, total }`. |

### Memories

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/memories?type=&project_path=&search=&tag=&limit=&offset=` | Filtered, paginated memory list plus `hotContext` (10 most recent memories) and `indexing` flag. |
| `GET` | `/api/memories/tags` | Tag frequency list (top 100 tags with counts). |
| `DELETE` | `/api/memories/:id` | Delete a memory by ID. |
| `DELETE` | `/api/memories/tag/:tag` | Delete all memories with the given tag. Returns `{ deleted: N }`. |

### Projects

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects` | List all registered projects. |
| `POST` | `/api/projects` | Create a project. Body: `{ name: string, path: string }` (path must be absolute). Returns 201 on success, 409 if path already exists. |
| `POST` | `/api/projects/:id/start` | Start the project's Claude Code session. |
| `POST` | `/api/projects/:id/stop` | Stop the project's Claude Code session. |
| `DELETE` | `/api/projects/:id` | Delete a project. Returns 409 if the project is currently active. |

### Permissions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/permissions/pending` | All cross-session pending permission requests (includes session name and project path). |
| `GET` | `/api/permissions/stats?session_id=&days=N` | Approval/denial stats by tool (summary + `top_tools` array). |
| `GET` | `/api/permissions/:id` | Pending permissions for a specific session. |
| `POST` | `/api/permissions/:id/respond` | Respond to a permission request. Body: `{ response: "allow" \| "deny" }`. |
| `POST` | `/api/permissions/:id/always` | Always allow this tool. Writes a `ToolName(*)` pattern to `settings.local.json` for the relevant project. |

### Process Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/process-health` | Daemon and Docker container health records plus active session count. |
| `POST` | `/api/process-health/restart-daemon` | Queue a daemon restart command (inserts into `admin_commands` table). |
| `POST` | `/api/process-health/restart-docker` | Queue a Docker container restart. Body: `{ container: string }`. |

### Git (per session)

All Git endpoints resolve the project path from the session record and run `git` inside the container.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/git/:sessionId/tree` | File tree at HEAD (`git ls-tree -r`). Returns `{ files: string[] }`. |
| `GET` | `/api/git/:sessionId/file?path=&ref=` | File content at a given ref (default: `HEAD`). Returns `{ content: string }`. |
| `GET` | `/api/git/:sessionId/diff?ref=&path=` | Diff against a ref (default: `HEAD~1`), optionally scoped to a path. Returns `{ diff: string }`. |
| `GET` | `/api/git/:sessionId/log?limit=` | Commit log (default 50, max 200). Returns `{ commits: Array<{ hash, short, subject, author, date }> }`. |
| `GET` | `/api/git/:sessionId/status` | Working tree status (`git status --porcelain`). Returns `{ files: Array<{ status, file }> }`. |
| `GET` | `/api/git/:sessionId/branches` | All branches including remotes. Returns `{ branches: Array<{ name, current }> }`. |
| `GET` | `/api/git/:sessionId/commit/:hash` | Full diff and stat for a specific commit. Returns `{ diff: string }`. |
| `GET` | `/api/git/:sessionId/prs?author=&draft=` | GitHub open PRs for the session's repository. Requires `GITHUB_TOKEN`. `author` defaults to the token's GitHub login; pass `author=all` for all authors. |
| `GET` | `/api/git/:sessionId/prs/:number` | PR detail: PR metadata, reviews, inline comments, and CI check runs. |

### Real-time Events (SSE)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/events` | Server-Sent Events stream. Sends a `connected` event on open, then broadcasts server-push events (session updates, permission alerts, etc.). Sends a `: ping` keepalive comment every 30 s. Reconnects automatically after 5 s on error. |

### Health Check

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Returns `{ status, db, uptime, sessions }`. Returns HTTP 503 if DB is unreachable. |

---

## Part 5: WebApp Mini App API

The Telegram Mini App is served at `/webapp/` and loaded via the "Dev Hub" WebApp menu button in Telegram (set on startup when `TELEGRAM_WEBHOOK_URL` is configured). It provides a mobile-optimized interface with tabs: **git**, **permissions**, **monitor**, **timeline**, **sessions**, **processes**.

### Authentication Flow

1. On mount, the SPA calls `window.Telegram.WebApp.ready()` and `window.Telegram.WebApp.expand()`.
2. It reads `window.Telegram.WebApp.initData` (a URL-encoded string signed by Telegram).
3. It posts `initData` to `POST /api/auth/webapp`.
4. The server verifies the HMAC-SHA256 signature using `HMAC-SHA256("WebAppData", bot_token)` as the key, with a 1-hour freshness window.
5. On success, the server returns `{ ok: true, user: { id, first_name, username }, token: "<jwt>" }`.
6. All subsequent API calls include `Authorization: Bearer <token>`.

The JWT is not stored in a cookie; the webapp holds it in memory for the session lifetime.

### WebApp-Specific Endpoints

The webapp uses the same REST API as the main dashboard (see Part 4). The only WebApp-specific endpoint is:

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/webapp` | Verify Telegram Mini App `initData` and receive a Bearer JWT. Body: `{ initData: string }`. |

### Legacy Redirect

`GET /telegram/webapp/*` → `301` redirect to `/webapp/*` (backward compatibility for older clients).

### API Usage Notes

- All `/api/*` calls use `Authorization: Bearer <token>` (not cookies).
- A 401 response means the token has expired; re-authenticate via `POST /api/auth/webapp`.
- The webapp components (GitBrowser, PermissionList, SessionMonitor, SessionTimeline, ProcessHealth, PRList) all call the standard REST endpoints described in Part 4.
- Color scheme is read from `window.Telegram.WebApp.colorScheme` and applied at mount.
