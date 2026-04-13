# Changelog

## v1.27.2

### feat(setup): TTS configuration in setup wizard with Piper voice selection

Setup wizard now includes a full TTS configuration block:

- **Provider selection**: auto / Piper / Yandex SpeechKit / Kokoro / OpenAI / Groq / Disable
- **Piper voice multi-select**: choose languages to download (English required); voices downloaded automatically from HuggingFace
  - English: `en_US-lessac-medium` (male)
  - Russian: `ru_RU-irina-medium` (female), `ru_RU-denis-medium` (male)
  - German, Spanish, French available
- **Piper language-aware model selection**: `PIPER_MODEL_EN` / `PIPER_MODEL_RU` env vars; Piper now picks the right model per detected language
- **Yandex SpeechKit**: API key, Folder ID, voice (alena/filipp/jane/omazh/zahar), language
- **Kokoro**: dtype and voice selection
- **OpenAI**: API key

Also:
- `config.ts`: `TTS_PROVIDER` enum extended with `"piper"`, `"openai"`, `"groq"`, `"none"`
- `utils/tts.ts`: language-aware Piper model selection; English auto-mode now tries Piper first before Kokoro

Setup wizard (`bun cli.ts setup`) now includes a full TTS configuration block:

- **Provider selection**: auto / Piper / Yandex SpeechKit / Kokoro / OpenAI / Groq / Disable
- **Piper**: configure custom `PIPER_DIR` and voice model filename
- **Yandex SpeechKit**: API key, Folder ID, voice (alena/filipp/jane/omazh/zahar), language
- **Kokoro**: dtype (q4/q8/fp16/fp32) and voice selection
- **OpenAI**: API key

All settings are written to `.env` automatically.

Also:
- `config.ts`: `TTS_PROVIDER` enum extended with `"piper"`, `"openai"`, `"groq"`, `"none"`
- `utils/tts.ts`: `PIPER_MODEL` now configurable via `PIPER_MODEL` env var; added `none`/`openai`/`groq` provider handling

---

## v1.27.1

### fix(channel): prevent duplicate replies on Stop/Start restart

When a Claude Code process was killed between a successful Telegram send and the
`UPDATE pending_replies SET delivered_at = NOW()` call, the `deliverPendingReplies`
recovery on next startup would resend the already-delivered message — causing
duplicate replies.

**Fix:** `delivered_at` is now set *before* the Telegram send, not after. This
gives at-most-once delivery semantics: if the process dies mid-send, recovery
won't retry (the message may be lost), but it won't send duplicates.

### fix(status): less alarmist response guard message

The 5-minute "no reply" guard message was reworded from "сессия могла упасть
или зависнуть" to "возможно думает над задачей или сессия зависла" — Claude
might simply be running extended thinking, not crashed.

---

## v1.27.0

### Live pane snapshots for all sessions in split-pane mode

Tmux watchdog now captures terminal output for every active session, including
projects running as panes inside a shared tmux window (i.e. `helyx up -s`).

Previously only sessions that had their own dedicated tmux window received
`pane_snapshot` updates — in split-pane mode all projects share window 0
("helyx"), so the watchdog couldn't find them by window name.

**Fix:** watchdog now falls back to matching sessions by `project_path` against
`pane_current_path` from `tmux list-panes -a`. If no window matches by name,
the matching pane (e.g. `0.3`) is used as the tmux target for both pane capture
and permission-prompt interactions.

Also in this release:
- **fix(permissions):** expire all pending permission requests on bot startup
  (previously only requests older than 2 min were expired, leaving orphaned
  pending rows when the bot restarted quickly)
- **fix(callbacks):** `.catch(() => {})` on `answerCallbackQuery` /
  `editMessageText` to silence "query is too old" errors after restart

---

## v1.26.0

### DB as single source of truth for projects

`tmux-projects.json` is removed. The `projects` DB table is now the only registry.

- `helyx add` — writes to `projects` table via `psql` (same as `/project_add` in bot)
- `helyx up` / `helyx ps` / `helyx remove` — all read from DB
- `/project_add` in bot — unchanged, already wrote to DB
- Adding a project via bot now automatically shows up in `helyx up` without any manual JSON editing

This eliminates the dual-registry problem where projects added via `/project_add` (bot) were invisible to `helyx up` (CLI).

---

## v1.25.0

### Process Monitor — Dashboard & WebApp

Process health dashboard now available in both the web dashboard and the Telegram WebApp.

#### Web dashboard (`/monitor` page)

New sidebar page (Monitor → `Activity` icon) with three sections:
- **admin-daemon** — PID, uptime, stale heartbeat warning (>90 s), `🔄 Restart daemon` button
- **Docker containers** — per-container status from `docker ps`, `🔄 Restart bot` button for the bot container
- **tmux sessions** — active session count from DB

Auto-refreshes every 15 s; restart buttons optimistically queue `admin_commands` and re-poll after a brief delay.

#### Telegram WebApp (`🖥 Procs` tab)

New fifth tab in the WebApp bottom nav, styled with Telegram CSS variables. Shows the same three sections (admin-daemon, Docker, tmux sessions) with restart buttons. Available even when no session is selected (host-level view).

#### API

- `GET /api/process-health` — returns `process_health` rows + active session count
- `POST /api/process-health/restart-daemon` — queues `restart_admin_daemon` admin command
- `POST /api/process-health/restart-docker` — queues `docker_restart {container}` admin command

#### Files

- `dashboard/src/pages/Monitor.tsx` — new dashboard page
- `dashboard/webapp/src/components/ProcessHealth.tsx` — new WebApp component
- `mcp/dashboard-api.ts` — `handleGetProcessHealth`, `handleProcessAction` handlers
- `dashboard/src/api/client.ts` — `ProcessHealthRow`, `ProcessHealthResponse` types + API methods
- `dashboard/webapp/src/api.ts` — `processHealth`, `restartDaemon`, `restartDockerContainer` methods
- `dashboard/src/i18n.ts` — `nav.monitor` translations (EN/RU)

---

## v1.24.0

### tmux Watchdog — Session Health Monitoring & External MCP Permissions

Host-side watchdog that polls active Claude Code sessions every 5 s and routes problems to Telegram with actionable buttons.

#### Permission routing for external MCP tools

Claude Code's built-in `permission_request` channel only covers native tools (Bash, Edit, Read). External MCP tools (docker, github, etc.) show an interactive dialog in the terminal. The watchdog intercepts these and routes them to Telegram with the same **✅ Yes / ✅ Always / ❌ No** buttons. User response is fed back via `tmux send-keys`. The **Always** action writes the tool to `settings.local.json` for permanent auto-approval.

#### Stall detection

Detects when a session shows a spinner but `last_active` hasn't been updated for 2.5+ min — the definitive signal of a hung MCP transport. Alert includes **[⚡ Interrupt]** button that sends `Escape` + auto-confirms the interrupt prompt. Cooldown: 10 min.

#### Editor detection

Detects vim/nano opened in the pane (e.g. from `git commit` without `-m`). Alert includes **[📝 Force close]** button that sends `:q!` `Enter`. Cooldown: 5 min, resets when editor closes.

#### Credential prompt detection

Detects `Password:`, passphrase, or git https Username prompts blocking the session. Informational alert. Cooldown: 5 min.

#### Crash / restart detection

Detects `[run-cli] Exited with code N` from the auto-restart wrapper. Informational alert; `run-cli.sh` restarts automatically. Cooldown: 3 min.

#### Architecture

- `scripts/tmux-watchdog.ts` — replaces `tmux-permission-watcher.ts`; all detectors in one file
- `scripts/admin-daemon.ts` — starts the watchdog; adds `tmux_send_keys` command handler
- `bot/commands/tmux-actions.ts` — new `tmux:ACTION:PROJECT` callback handler
- `bot/callbacks.ts` — registers `tmux:` prefix
- `memory/db.ts` — migration v16: `tmux_target TEXT` column on `permission_requests`
- `docs/tmux-watchdog.md` — architecture and detector reference
- `tests/unit/tmux-watchdog.test.ts` — 64 unit tests for all pure detection functions

Only windows with `status = 'active'` DB sessions are polled; idle projects are skipped entirely.

#### Telegram timeout fix (v1.23.x backport)

- `channel/telegram.ts` — `FETCH_TIMEOUT_MS = 10 s` + `MAX_TOTAL_MS = 60 s` total deadline on all Telegram API calls; prevents infinite hang on network stall (root cause of 37-min session freezes)
- `channel/permissions.ts` — fast-fail auto-deny when `sendTelegramMessage` fails instead of silently polling for 10 min

---

## v1.23.0

### Admin Daemon Auto-Start

- **`helyx up` now starts admin-daemon** — `ensureAdminDaemon()` is called after tmux windows are launched; checks `pgrep` and spawns `admin-daemon.ts` in background if not running. Applies to both fresh start and "already running" branches.
- **`helyx setup` installs systemd service** — copies `scripts/helyx.service` to `/etc/systemd/system/helyx@USER.service` and enables it so `helyx up` + admin-daemon auto-start on boot. Gracefully skips with manual instructions if sudo is unavailable.
- **`/projects` ▶️ Start button now works out of the box** — previously required admin-daemon to be started manually; now guaranteed to be running after any `helyx up`.

## v1.22.0

### UX Improvements

- **Voice to disconnected topic** — early exit before Whisper transcription; user sees a clear error with `/standalone` hint instead of a silent failure
- **Better "session not active" message** — shows project path, explains auto-reconnect, links to `/standalone` and `/sessions`
- **Typing indicator refresh** — typing action re-sent every 4s during long responses; correctly targets forum topic via `message_thread_id`
- **Queue depth feedback** — "⏳ In queue (#N)..." message when a request is waiting behind another in the per-topic queue
- **`/quickstart` command** — 5-step onboarding guide: forum group → project add → Claude Code launch
- **Session crash notifications** — forum topic receives a message when a session terminates unexpectedly
- **`escapeHtml()` utility** — shared in `bot/format.ts`; all user-supplied strings in HTML messages are now properly escaped
- **N+1 SQL eliminated** in `sessions/manager.ts` — `project_path` merged into existing SELECTs in `disconnect()` and `markStale()`

## v1.21.0

### Interactive Polls

Claude can ask clarifying questions as native Telegram polls (`send_poll` MCP tool). You tap answers, press **Submit ✅**, and results flow back automatically as a user message. Supports forum topic routing, 24h expiry, and vote retraction. See [Interactive Polls guide](guides/polls.md).

### Read Receipts

👀 reaction when the bot receives your message, ⚡ when Claude Code picks it up and starts working.

### Codex Code Review

OpenAI Codex CLI integration for AI-powered code review. Authenticate headlessly via `/codex_setup` (device flow, no terminal needed). Trigger via `/codex_review` or natural language. Falls back silently to Claude's native review on quota or auth errors. See [Codex Review guide](guides/codex.md).

### `/forum_clean` command

Scans all projects with a `forum_topic_id`, validates each against the Telegram API, and nulls out IDs that correspond to deleted topics. Run `/forum_sync` afterward to recreate missing topics.

## v1.20.0

### Forum Topics — One Topic Per Project

The primary UX model is now a **Telegram Forum Supergroup** where each project has a dedicated topic:

- `/forum_setup` — run once in the General topic; bot creates one topic per registered project and stores the group ID in `bot_config`
- `/project_add` — automatically creates a forum topic for the new project when forum is configured
- **Message routing** — `sessions/router.ts` resolves `message_thread_id` → project → active session; General topic (thread ID = 1) is control-only
- **Status messages** — `StatusManager` in `channel/status.ts` sends all status updates to the project topic; project name prefix suppressed (the topic already identifies the project)
- **Permission requests** — `PermissionHandler` in `channel/permissions.ts` sends Allow/Always/Deny buttons to the correct project topic
- **`reply` and `update_status` MCP tools** — automatically include `message_thread_id` when called from a forum session
- **Forum cache** — `bot/forum-cache.ts` lazy-loads `forum_chat_id` from DB with invalidation on setup/sync
- **DB migration v13** — `forum_topic_id INTEGER` column on `projects`, `bot_config` table for runtime settings
- **34 new unit tests** — `tests/unit/forum-topics.test.ts` covers routing logic, icon color rotation, `replyInThread`, StatusManager forum target, PermissionHandler forum target, migration schema shape
- **Backward compatible** — if `/forum_setup` was never run, the bot operates in DM mode unchanged

## v1.19.0

### Lease-Based Session Ownership
Replaced `pg_advisory_lock` with a `lease_owner` + `lease_expires_at` column in the `sessions` table (migration v12). The lease is renewed every 60 seconds; if the channel process crashes, the lease auto-expires after 3 minutes and another process can take over. Eliminates orphaned locks and connection-scope issues from PostgreSQL pool reconnects.

### Session State Machine
`sessions/state-machine.ts` defines valid status transitions and enforces them atomically. Invalid transitions (e.g., `terminated → active`) are blocked with a warning log. All disconnects in `sessions/manager.ts` and `channel/session.ts` now route through `transitionSession()`.

### File Intent Prompt

Files and photos received without a caption now trigger a prompt: `📎 filename saved. What should I do with it?`. The bot waits up to 5 minutes for the user's reply, then forwards the file to Claude with that text as the caption. Files with a caption still forward immediately.

### MessageService & SummarizationService
`services/message-service.ts` and `services/summarization-service.ts` wrap short-term memory and summarizer functions with a clean typed API, including `queue()` with attachments support and `pendingCount()`.

### Centralized Telegram API Client
`channel/telegram.ts` now exposes a unified `telegramRequest()` with automatic retry on 429 (respects `retry_after`) and 5xx errors (3 retries with backoff). All tool calls and status updates route through it.

### Cleanup Jobs with Dry-Run
`cleanup/jobs.ts` exposes `runAllCleanupJobs(dryRun)` with per-job row counts. `handleCleanup` in the bot and `helyx cleanup --dry-run` in the CLI use it to preview or apply cleanup.

### Security Fail-Fast
Bot exits immediately at startup if `ALLOWED_USERS` is empty and `ALLOW_ALL_USERS=true` is not set. No silent open-access deployments.

### Anthropic CLI Usage Tracking

Claude Code (Anthropic) model usage is now visible in the dashboard Stats page and the Telegram Mini App session monitor. When a CLI session response completes, the token count captured from the tmux/output monitor is recorded in `api_request_stats` with `provider=anthropic` and model from the session's `cli_config`. The "By model" table in both UIs now shows Sonnet/Opus/Haiku usage alongside standalone providers (Google AI, OpenRouter, Ollama).

### Media Forwarding

Photos, documents, and videos forwarded to Claude via MCP channel with structured `attachments` field (`base64` for images ≤5 MB, `path` for larger files). Migration v11 adds `attachments JSONB` to `message_queue`.

## v1.18.0

### Service Layer

`services/` directory introduces typed, testable wrappers over raw SQL for all domain operations. `ProjectService.create()` atomically handles INSERT + remote session registration. `PermissionService.transition()` enforces the state machine — `pending → approved | rejected | expired` — and rejects re-transitions into terminal states.

### Structured Logging (Pino)

All `console.log/error/warn` replaced with Pino structured logging. `logger.ts` exports two loggers: `logger` (stdout) and `channelLogger` (stderr fd 2, safe for MCP stdio). Every log entry carries structured fields (`sessionId`, `chatId`, `messageCount`) — searchable with any JSON log aggregator. Set `LOG_LEVEL=debug` in `.env` for verbose output.

### Channel Adapter — 7 Modules

The `channel.ts` monolith is now `channel/` with focused modules: `session.ts`, `permissions.ts`, `tools.ts`, `status.ts`, `poller.ts`, `telegram.ts`, `index.ts`. Each module owns one concern; the entrypoint wires them together.

### Environment Validation (Zod)

`config.ts` validates all env vars with Zod at startup. Missing required variables produce a clear error and immediate exit instead of a runtime crash on first use. `ALLOWED_USERS` is now required — `ALLOW_ALL_USERS=true` must be set explicitly for open access.

### Unit Test Suite

43 pure unit tests with no DB, no network, no Telegram: `tests/unit/session-lifecycle.test.ts`, `tests/unit/permission-flow.test.ts`, `tests/unit/memory-reconciliation.test.ts`. Run with `bun test tests/unit/` — completes in ~24ms.

## v1.17.0

See [ROADMAP](docs/ROADMAP.md) for earlier version history.

## v1.14.0

### Google AI Provider in Setup Wizard

Re-added Google AI (Gemma 4) as an interactive option in `helyx setup`. The wizard now presents all four supported providers: Anthropic / Google AI / OpenRouter / Ollama. Selecting Google AI prompts for `GOOGLE_AI_API_KEY` and `GOOGLE_AI_MODEL` (default: `gemma-4-31b-it`).

### MCP Tools: react and edit_message in Channel Adapter

Added `react` (set emoji reaction) and `edit_message` (edit a bot message) to the `channel.ts` stdio MCP adapter. Both tools were already available in the HTTP MCP server — now they work in all connection modes.

## v1.13.0

### Telegram Mini App — Claude Dev Hub

A mobile-first WebApp accessible via the **Dev Hub** button in Telegram. Features:
- **Git browser** — file tree, commit log, status, diff viewer
- **Permission manager** — Allow / Deny / Always Allow from mobile
- **Session monitor** — live session status (working/idle/inactive), API stats by model (including Anthropic Claude usage from CLI sessions), token totals with cost estimate, permission history with tool breakdown, recent tool calls

See [Mini App Guide](guides/webapp.md) for full feature description and auth details. Full technical spec: [`dashboard/webapp/SPEC.md`](dashboard/webapp/SPEC.md)

## v1.12.0

### Local Session Management

- **Delete local sessions from Telegram** — `/sessions` now shows `🗑 Delete` inline buttons for local sessions that are not active; clicking deletes all session data and refreshes the list
- **Delete local sessions from dashboard** — Sessions table gains a `Delete` action column; button is visible only for `source=local` + non-active rows; uses `useMutation` with query invalidation
- **`source` field in sessions API** — `GET /api/sessions` and `GET /api/overview` now return `source` (`remote` | `local` | `standalone`); added to `Session` TypeScript interface

### Session Source Refactoring

Three distinct modes now instead of two:

| `CHANNEL_SOURCE` env | Mode | DB behavior |
|---|---|---|
| `remote` | `helyx up` / tmux | One persistent session per project; reattaches on reconnect |
| `local` | `helyx start` | New temporary session each run; work summary on exit |
| _(not set)_ | Plain `claude` | No DB registration (`sessionId = null`), no polling |

Previously, unset `CHANNEL_SOURCE` defaulted to `local`. Now it is a distinct standalone mode that skips DB entirely — preventing phantom sessions when running `claude` without the bot.

### CLI Changes

- **`helyx start`** — no longer invokes `run-cli.sh`; spawns `claude` directly with `CHANNEL_SOURCE=local` (simpler path, no auto-restart loop for local sessions)
- **`helyx restart`** — after rebuild, syncs `TELEGRAM_BOT_TOKEN` from `.env` into `~/.claude.json` MCP server config (`syncChannelToken`), so channel auth stays in sync without manual edits
- **`run()` helper** — new `stream: true` option pipes stdout/stderr directly to terminal (used in restart for real-time build output)

## v1.11.0

### Dashboard Project Management
- **Projects page** — create, start, and stop projects directly from the web dashboard (previously Telegram-only)
- **SSE notifications** — `GET /api/events` streams `session-state` events to dashboard via Server-Sent Events
- **Browser notifications** — dashboard requests Notification permission and shows push notifications on session state changes
- **Projects API** — `GET/POST /api/projects`, `POST /api/projects/:id/start|stop`, `DELETE /api/projects/:id`

### Memory TTL per Type
- **Per-type retention** — each memory type has its own TTL: `fact` 90d, `summary` 60d, `decision` 180d, `note` 30d, `project_context` 180d
- **Hourly cleanup** — expired memories deleted automatically based on `created_at`
- **Configurable** — override via `MEMORY_TTL_FACT_DAYS`, `MEMORY_TTL_SUMMARY_DAYS`, etc.
- **DB migration v9** — `archived_at` column + partial index on `memories` table

## v1.10.0

### Smart Memory Reconciliation
- **LLM deduplication** — `/remember` and work summaries no longer blindly insert; similar memories are found via vector search, then `claude-haiku` decides ADD / UPDATE / DELETE / NOOP
- **Updated replies** — `/remember` now shows `Saved (#N)` / `Updated #N` / `Already known (#N)` based on what actually happened
- **project_context deduplication** — session exit summaries update existing project context instead of accumulating duplicates
- **Graceful fallback** — Ollama or Claude API unavailable → falls back to plain insert, no data loss
- **New config** — `MEMORY_SIMILARITY_THRESHOLD` (default `0.35`) and `MEMORY_RECONCILE_TOP_K` (default `5`)

## v1.9.0

### Session Management Redesign
- **Persistent Projects** — `projects` DB table, `/project_add` saves to DB (not JSON file)
- **Remote/Local Sessions** — one remote session per project (persistent), multiple local (temporary per process)
- **Work Summary on Exit** — local session exit triggers AI summary of work done ([DECISIONS][FILES][PROBLEMS][PENDING][CONTEXT]), vectorized to long-term memory
- **Session Switch Briefing** — switching sessions shows last project context summary, injected as system context
- **Semantic Search** — `search_project_context` MCP tool + `search_context` command
- **Archival TTL** — messages and permission_requests archived on summarize, deleted after `ARCHIVE_TTL_DAYS` (default 30)
- **Status vocab** — `active | inactive | terminated` (was `active | disconnected`)
- **DB migrations v6-v8** — projects table, archived_at columns, project_id FK, unique remote-per-project

## v1.8.0

### Skills & Commands Integration
- **`/skills`** — Interactive skill browser with inline buttons (reads from `~/.claude/skills/`)
- **`/commands`** — Custom command launcher (reads from `~/.claude/commands/`)
- **`/hooks`** — View configured Hookify rules
- **Deferred input** — Tools requiring args prompt user then enqueue
- **Icon support** — 38+ emojis for quick visual identification

### Session Management Commands
- **`/add`** — Register project as Claude Code session (prompts for path, auto-switches)
- **`/model`** — Select Claude model via inline buttons (stored in `cli_config.model`)
- **Adapter pattern** — `adapters/ClaudeAdapter` (message_queue), extensible registry
- **Session router** — `sessions/router.ts` typed routing: standalone / cli / disconnected

### CLI Refactoring
- **`start [dir]`** — Register + launch project in current terminal (replaces old start = docker-only)
- **`docker-start`** — New command for `docker compose up -d` (old `start` behavior)
- **`add [dir]`** — Now registration-only (saves to config + bot DB, no launch)
- **`run [dir]`** — New command to launch registered project in terminal
- **`attach [dir]`** — New command to add window to running tmux `bots` session
- **tmux session renamed** — `claude` → `bots` (hosts both claude and opencode windows)

### Database Improvements
- **JSONB normalization** — Safe PostgreSQL storage with explicit casting
- **Read-merge-write** — Concurrent-safe provider config updates
