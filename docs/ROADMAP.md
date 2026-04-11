# Helyx — Roadmap

## How to Use This Document

- **Update status** when a feature is implemented or a decision is made
- **Add new planned items** when PRDs are created
- **Status key:**
  - ✅ Done — completed and released
  - 🚧 In Progress — on a feature branch or explicitly WIP
  - 📋 Planned — has a PRD, ready to implement
  - 💡 Idea — no PRD yet, but identified as valuable

---

## ✅ Implemented

### v1.23.0 (Latest)

#### Voice Replies (TTS) — Yandex SpeechKit + Smart Triggers

- **Yandex SpeechKit** replaces Piper as primary TTS provider (`utils/tts.ts`): REST v1 API, voice `alena`, `ru-RU`, format `mp3`, up to 5000 chars per request. Requires `YANDEX_API_KEY` + `YANDEX_FOLDER_ID` in `.env`.
- **Removed Piper** — local TTS was low quality and required a binary bundle; directory preserved but unused.
- **Groq Orpheus** (`canopylabs/orpheus-v1-english`) kept as fallback; English-only — avoid for Russian content. Free tier limit: **3600 tokens/day**. Upgrade to Dev Tier for production use.
- **TTS priority**: Yandex SpeechKit → Groq Orpheus (OpenAI TTS still in code but not wired as default — add `OPENAI_API_KEY` to activate multilingual fallback).
- **Two voice reply conditions** (`maybeAttachVoiceRaw`): (1) user sent a voice message → always reply with voice regardless of length; (2) reply text ≥300 chars (was 200) → auto-attach voice.
- **`isVoice` flag in queue** (`bot/media.ts`): voice messages enqueued with `attachments = {"isVoice": true}` so the channel adapter can detect and force a voice reply.
- **`forceVoice` propagation**: poller reads `row.attachments.isVoice` → sets `forceVoice` flag in `index.ts` → `tools.ts` passes it to `maybeAttachVoiceRaw` → `shouldSendVoice` check bypassed.
- **System note injected per message** (`channel/poller.ts`): if voice → "ALWAYS send a voice reply"; otherwise → "Replies ≥300 chars sent automatically".
- **`shouldSendVoice` regex fix** (`utils/tts.ts`): diff detection regex `^[+\-][^+\-]` incorrectly matched markdown list bullets (`- item`). Fixed to `^[+\-][^ +\-]` — only matches real diff lines like `+added` or `-removed`.
- **Files changed:** `utils/tts.ts`, `bot/media.ts`, `channel/poller.ts`, `channel/tools.ts`, `channel/index.ts`, `config.ts`

#### Session Lease: Force-Steal on Contention

- **Bug fixed** (`channel/session.ts`): when multiple `channel.ts` processes start simultaneously for the same project (e.g. batch restart), the loser would fail to acquire the lease, then try to INSERT a new session row — hitting the `idx_sessions_project_remote` UNIQUE constraint and crashing with a fatal error.
- **Fix**: after max retry attempts, force-update the lease on the existing session (unconditional `UPDATE`). The unique constraint exists precisely to enforce one remote session per project, so force-stealing is correct behavior.
- **Files changed:** `channel/session.ts`

#### run-cli.sh: Shared .env Loading

- **Bug fixed** (`scripts/run-cli.sh`): API keys set in `helyx/.env` (e.g. `GROQ_API_KEY`, `YANDEX_API_KEY`) were not available in non-helyx project channels because only the project's own `.env` was loaded.
- **Fix**: `load_env()` function now loads `helyx/.env` first, then overlays the project-specific `.env`. Already-set vars (e.g. Docker-injected `DATABASE_URL`) are never overridden.
- **Files changed:** `scripts/run-cli.sh`

#### Findings: TTS Provider Comparison

| Provider | Language | Quality | Limit | Notes |
|---|---|---|---|---|
| **Yandex SpeechKit** | ru-RU + multilingual | ★★★★★ | Pay-per-use | Best Russian, REST v1, `Api-Key` auth, `YANDEX_API_KEY` + `YANDEX_FOLDER_ID` required, service account needs `ai.speechkit.tts` IAM role |
| **Groq Orpheus** | English only | ★★★☆☆ | 3600 TPD (free) | `canopylabs/orpheus-v1-english`, WAV output, terrible for Russian; Dev Tier removes daily limit |
| **OpenAI TTS** | Multilingual | ★★★★☆ | Pay-per-use | `tts-1`, voice `nova`, MP3, good Russian; `OPENAI_API_KEY` must be set separately (not merged into `OPENROUTER_API_KEY`) |
| **Piper** | Russian | ★★☆☆☆ | Free, local | Offline, binary bundle, low naturalness; removed |

### v1.22.0

#### UX Improvements — Phase 1 & 2 (P1)
- **Voice to disconnected topic** (`bot/media.ts`): early exit before Whisper transcription with user-facing error + `/standalone` hint
- **Improved "session not active" message** (`bot/text-handler.ts`): shows project path, explains auto-reconnect, actionable `/standalone` and `/sessions` links; HTML-safe via `escapeHtml()`
- **Typing indicator refresh** (`bot/streaming.ts`): `startTyping()` every 4s with correct `message_thread_id` for forum topics; replaces raw `setInterval`
- **Queue depth feedback** (`bot/topic-queue.ts` + `bot/text-handler.ts`): "⏳ В очереди (#N)..." shown when a message is queued behind another; `onQueued` callback with `.catch()`
- **`/quickstart` command** (`bot/commands/quickstart.ts`): 5-step onboarding guide for new users (forum setup → project add → launch Claude Code)
- **Session crash notifications** (`sessions/manager.ts` + `mcp/server.ts`): forum topic receives a message when a session terminates unexpectedly via `setTerminationCallback()`
- **`escapeHtml()` shared utility** (`bot/format.ts`): prevents HTML injection in all Telegram `parse_mode: "HTML"` messages
- **N+1 SQL eliminated** (`sessions/manager.ts`): `project_path` merged into existing SELECTs in `disconnect()` and `markStale()`

### v1.21.0

#### Security Hardening (P0)
- **Path traversal fix** (`utils/files.ts`): `doc.file_name` now sanitized via `basename()` + regex before use as disk path
- **Webhook secret enforced** (`mcp/server.ts`): bot refuses to start in webhook mode without `TELEGRAM_WEBHOOK_SECRET`
- **`isLocalRequest` narrowed** (`mcp/server.ts`): trusted range reduced from all RFC 1918 to loopback + 172.17.x (Docker bridge only)
- **`transcript_path` validated** (`mcp/server.ts`): `/api/hooks/stop` now checks path is under `/home`, `/root`, or `/tmp`
- **Port bound to localhost** (`docker-compose.yml`): port 3847 now `127.0.0.1:3847:3847` — external access only via Cloudflare Tunnel
- **`ref` parameter sanitized** (`mcp/dashboard-api.ts`): git ref validated by regex before passing to git
- **PRD:** `docs/requirements/security-hardening-2026-04-10/en/security-hardening.md`
- **Commit:** `e343bc4`

#### Per-Topic Parallel Processing
- New `bot/topic-queue.ts`: messages from different forum topics processed in parallel; same topic — sequential
- Webhook changed to fire-and-forget: bot returns 200 to Telegram immediately, preventing retries and double voice downloads
- Voice message processing moved into per-topic queue; status message shown before queue entry
- **Commit:** `0c30f7a`

#### Memory: Stop Hook + Proactive Recall
- Claude Code Stop hook auto-extracts project facts from session transcripts via `/api/hooks/stop`
- `scripts/save-session-facts.sh` installed by setup wizard into `~/.claude/settings.json`
- `extractFactsFromTranscript()` in `memory/summarizer.ts` parses `.jsonl` transcripts
- `project_add` now injects recall instructions into project `CLAUDE.md`
- **Commit:** `fbed5e3`

### v1.20.0

#### Forum Topics — One Topic Per Project

#### Forum Topics — One Topic Per Project
- Telegram Forum Supergroup: each project = one dedicated topic/thread
- `/forum_setup` creates topics for all existing projects, stores `forum_chat_id` in `bot_config`
- `/project_add` auto-creates a forum topic when forum is configured
- Message routing: `sessions/router.ts` resolves `message_thread_id` → project → active session
- General topic (thread_id=1) = control channel only; text/media routing blocked
- Status updates and permission requests go to the correct project topic
- `reply` and `update_status` MCP tools auto-inject `message_thread_id` in forum mode
- Forum config cached in-memory (`bot/forum-cache.ts`), invalidated after `/forum_setup`
- DB migration v13: `forum_topic_id` on `projects`, `bot_config` table
- `/forum_sync`, `/topic_rename`, `/topic_close`, `/topic_reopen` management commands
- 34 new unit tests in `tests/unit/forum-topics.test.ts`
- Backward compatible: DM mode works unchanged when forum not configured
- **PRD:** `docs/requirements/forum-topics-2026-04-09/en/forum-topics.md`
- **Commits:** acb1d6d, bece340, 4ee1d05

### v1.18.0

#### Service Layer
- Introduced `services/` directory — thin typed wrappers over raw SQL for all domain operations
- `SessionService` — `rename()`, `get()`, `list()`, `delete()`, `create()`
- `ProjectService` — `create()`, `get()`, `list()`, `start()`, `stop()`, `delete()`; `create()` handles INSERT + remote session registration atomically
- `PermissionService` — `transition()` with state machine validation (pending → approved/rejected/expired); idempotency guard rejects re-transitions into terminal states
- `MemoryService` — `reconcile()`, `save()`, `recall()`, `forget()`
- Bot commands and callbacks now call services instead of raw SQL: `commands/projects.ts`, `commands/session.ts`, `commands/project-add.ts`
- **Files changed:** `services/session-service.ts` (new), `services/project-service.ts` (new), `services/permission-service.ts` (new), `services/memory-service.ts` (new), `bot/commands/projects.ts`, `bot/commands/session.ts`, `bot/commands/project-add.ts`, `bot/callbacks.ts`

#### Structured Logging (Pino)
- Replaced all `console.log/error/warn` with Pino structured logging across the entire codebase
- `logger.ts` exports two loggers: `logger` (stdout, for main bot) and `channelLogger` (stderr fd 2, for MCP stdio compatibility)
- All log entries include structured fields: `{ sessionId, chatId, messageCount }` — no more string interpolation
- `LOG_LEVEL` env var controls log verbosity (default: `info`)
- **Files changed:** `logger.ts` (new), `channel/` modules, `sessions/manager.ts`, `memory/summarizer.ts`, `mcp/dashboard-api.ts`, `bot/bot.ts`, `bot/access.ts`, `bot/streaming.ts`, `bot/media.ts`, `bot/callbacks.ts`, `bot/commands/`

#### Channel Adapter Refactor (7 modules)
- `channel.ts` monolith (1 file) split into `channel/` directory with 7 focused modules
- `channel/index.ts` — entrypoint, initialization
- `channel/session.ts` — session lifecycle (register, stale detection, local/remote modes)
- `channel/permissions.ts` — permission request forwarding to Telegram
- `channel/tools.ts` — MCP tool registry and dispatch
- `channel/status.ts` — live status message management
- `channel/poller.ts` — `message_queue` polling loop
- `channel/telegram.ts` — Telegram message formatting helpers
- **Files changed:** `channel/` directory (new), `channel.ts` (now a thin re-export shim)

#### Environment Validation (Zod)
- All `process.env.*` reads centralized in `config.ts` with Zod schema validation
- Bot fails fast at startup on missing required vars (clear error vs. runtime crash)
- Remaining `process.env.*` scattered across `utils/transcribe.ts`, `utils/files.ts`, `bot/commands/admin.ts` migrated to `CONFIG.*`
- **Files changed:** `config.ts`, `utils/transcribe.ts`, `utils/files.ts`, `bot/commands/admin.ts`

#### Security Defaults
- `ALLOWED_USERS` is now required at startup — bot exits with a clear error instead of silently serving all users
- `ALLOW_ALL_USERS=true` must be set explicitly if you want unrestricted access
- Protects against accidental public exposure after misconfigured deploys
- **Files changed:** `config.ts`, `bot/access.ts`

#### Permission State Machine
- Formal transition table: `pending → approved | rejected | expired` (all terminal)
- `PermissionService.transition()` validates state before writing — no double-approvals or race conditions
- Idempotency guard in Telegram callback handler: checks current status before processing, replies "Already handled" on duplicate delivery
- **Files changed:** `services/permission-service.ts`, `bot/callbacks.ts`

#### Unit Test Suite (43 tests)
- Pure unit tests with no DB, no network, no Telegram dependencies
- `tests/unit/session-lifecycle.test.ts` — 15 tests: state transitions, `sessionDisplayName`, disconnect rules per source type
- `tests/unit/permission-flow.test.ts` — 15 tests: valid transitions, terminal state blocking, idempotency, auto-approve patterns
- `tests/unit/memory-reconciliation.test.ts` — 13 tests: `parseReconcileDecision()` ADD/NOOP/UPDATE/DELETE parsing, similarity threshold logic
- `bun test tests/unit/` runs in ~24ms (all pure functions, no I/O)
- `package.json` scripts: `test` → unit only, `test:unit` → explicit, `test:e2e` → Playwright
- **Files changed:** `tests/unit/session-lifecycle.test.ts` (new), `tests/unit/permission-flow.test.ts` (new), `tests/unit/memory-reconciliation.test.ts` (new), `package.json`

#### Cleanup Jobs — DRY_RUN Mode
- Hourly cleanup job now supports `CLEANUP_DRY_RUN=true` for safe inspection without deleting
- All cleanup actions logged with Pino: counts of deleted rows per table
- **Files changed:** `memory/cleanup.ts`

### v1.17.0

#### Voice Transcription Live Progress
- Status message updates every 5s while Groq/Whisper transcribes: `🎤 Transcribing... (15s)`
- Timer only starts for voice messages ≥10s (short ones complete before first tick)
- Race condition guard: `cancelled` flag prevents the progress edit from overwriting the final transcription result
- **Files changed:** `bot/media.ts`

#### Session Timeline
- `GET /api/sessions/:id/timeline` — merged, chronologically sorted messages + memories (tool calls included when manually approved via Telegram)
- Webapp: new 🕐 **Timeline** tab — message bubbles + 🧠 memory events (purple blocks) interleaved, filter by All/Messages/Memories, "Load older" pagination, auto-refresh 5s (skips reset when paginated)
- Replaced the 💬 Messages tab — Timeline supersedes it with richer context
- `/session_export [id]` Telegram command — sends full session as a `.md` transcript file (capped at 5000 rows per type)
- **Files changed:** `mcp/dashboard-api.ts`, `dashboard/webapp/src/api.ts`, `dashboard/webapp/src/components/SessionTimeline.tsx` (new), `dashboard/webapp/src/App.tsx`, `bot/commands/admin.ts`, `bot/handlers.ts`, `bot/bot.ts`

### v1.16.0

#### Memory Export / Import
- `/memory_export [project_path]` — exports all active memories as a JSON manifest file
- `/memory_import` — send exported file with this caption; runs Smart Reconciliation on each entry (add/update/skip)
- Optional project filter: `/memory_export /home/user/project` exports only that project's memories
- **Files changed:** `bot/commands/memory-export.ts` (new), `bot/handlers.ts`, `bot/bot.ts`

#### Permission History Analytics
- `GET /api/permissions/stats` — summary (total/allowed/denied/always/pending) + top-15 tools breakdown, filterable by `session_id` and `days`
- Webapp Session Monitor: new **Permission History** section — summary counts + bar chart of top 8 tools with allow-rate indicator
- `/permission_stats [days]` Telegram command — ASCII bar chart per tool (default: 30d, max 365d)
- **Files changed:** `mcp/dashboard-api.ts`, `dashboard/webapp/src/api.ts`, `dashboard/webapp/src/components/SessionMonitor.tsx`, `bot/commands/admin.ts`

#### Webapp: Expanded Session Monitor
- **API Stats (global)**: requests / errors / avg latency / tokens (total, input, output) / estimated cost / per-model breakdown
- Time window selector: 24h / Since restart / All time (shared with Permission History)
- Stats sourced from global `api_request_stats` (CLI sessions don't write session-scoped rows)
- **Files changed:** `mcp/dashboard-api.ts`, `dashboard/webapp/src/api.ts`, `dashboard/webapp/src/components/SessionMonitor.tsx`

### v1.15.0

#### Webapp: Active Session Fix
- Webapp now opens the user's actual active session instead of the first globally active session
- New `GET /api/sessions/active` reads `chat_sessions` table by JWT user's Telegram ID
- `App.tsx` calls both `/api/sessions` and `/api/sessions/active` in parallel; prefers user's session
- **Files changed:** `mcp/dashboard-api.ts`, `dashboard/webapp/src/api.ts`, `dashboard/webapp/src/App.tsx`

#### Webapp: Expanded Session Monitor
- Token usage section: API calls, total/input/output tokens for the session lifetime
- Tool call history: last 15 calls with color-coded status (green=allow, red=deny, yellow=pending)
- Message count added to Session info row
- Manual refresh button; auto-refresh interval changed to 5s
- Bug fix: `handleSessionDetail` now selects `project` and `source` columns (previously missing)
- **Files changed:** `mcp/dashboard-api.ts`, `dashboard/webapp/src/api.ts`, `dashboard/webapp/src/components/SessionMonitor.tsx`

#### Webapp: Messages Tab
- New 💬 Messages tab with chronological chat history
- Bubble UI: user messages right, assistant/system messages left
- Tap to expand truncated messages (>400 chars)
- Pagination: loads 30 messages at a time, "Load older" button
- Auto-refresh every 5s; auto-scrolls to latest on first load
- Uses existing `GET /api/sessions/:id/messages` endpoint
- **Files changed:** `dashboard/webapp/src/components/MessageHistory.tsx`, `dashboard/webapp/src/App.tsx`, `dashboard/webapp/src/api.ts`

#### Webapp: Cache Fix
- `index.html` now served with `Cache-Control: no-store`
- Hashed asset files served with `Cache-Control: public, max-age=31536000, immutable`
- Prevents Telegram WebView from serving stale JS after deploys
- **Files changed:** `mcp/dashboard-api.ts`

#### Project Knowledge Memory
- Auto-scan on session registration: reads README, package.json, entry points; LLM synthesizes 3–7 durable facts
- Session-end extraction: second LLM pass after `summarizeWork()` extracts durable project facts (not session-specific events)
- `scan_project_knowledge` MCP tool for manual/force rescan
- `/project_facts` and `/project_scan` Telegram commands
- **Files changed:** `memory/project-scanner.ts` (new), `memory/summarizer.ts`, `mcp/tools.ts`, `bot/commands/`, `bot/handlers.ts`, `bot/bot.ts`

### v1.14.0 (previously v1.14.0)

#### README Fixes — Ollama Optional, Missing Env Vars
- Ollama marked as "Optional (semantic memory search only)" in prerequisites table
- Added `CLAUDE_MODEL` and `MAX_TOKENS` to env vars table with defaults
- Fixed `OLLAMA_URL` from required → optional
- **PRD:** `docs/requirements/readme-env-vars-fix-2026-04-09/en/readme-env-vars-fix.md`

#### E2E Test Suite + CI Workflow
- Playwright test suite: 20 tests across API (sessions, git, auth) and dashboard (static serving, cache)
- `globalSetup` generates JWT from bot token — no browser required for auth
- `bun test` / `bun test:api` in root `package.json`
- `.github/workflows/e2e.yml` ready — waiting for GitHub secrets to activate

#### Google AI Provider in Setup Wizard
- Re-added Google AI (Gemma 4) as interactive option in `helyx setup`
- Wizard now presents all four supported providers: Anthropic / Google AI / OpenRouter / Ollama
- Collects `GOOGLE_AI_API_KEY` and optionally `GOOGLE_AI_MODEL` (default: `gemma-4-31b-it`)
- **Files changed:** `cli.ts` (~lines 111–130, provider selection block)

#### MCP Tools: react and edit_message in Channel Adapter
- Added `react` (set emoji reaction) and `edit_message` (edit bot message) to channel.ts stdio MCP adapter
- Both tools now work in all connection modes (HTTP MCP server + stdio channel adapter)
- **Files changed:** `channel.ts` (ListToolsRequestSchema + CallToolRequestSchema handlers)

### v1.13.0

#### Telegram Mini App — Claude Dev Hub
- Mobile-first WebApp accessible via "Dev Hub" button in Telegram
- Features: git browser (file tree, commit log, diffs), permission manager (Allow/Deny/Always Allow), session monitor
- Full spec: `dashboard/webapp/SPEC.md`
- **Files changed:** `dashboard/webapp/`, `bot/main.ts`, `bot/commands/`
- **Commits:** 4b71911, 502bb68, ada5d4b

### v1.12.0

#### Local Session Management
- Delete local sessions from Telegram via `/sessions` inline buttons (🗑 Delete)
- Delete local sessions from dashboard (Sessions table, Delete action column)
- `source` field in sessions API (`GET /api/sessions`, `GET /api/overview`) returns `source: "remote" | "local" | "standalone"`
- **Commits:** 3feb0f5

#### Session Source Refactoring
- Three distinct session modes: `remote` (persistent via tmux), `local` (temporary per process), `standalone` (no DB registration)
- `CHANNEL_SOURCE` env var determines behavior
- Plain `claude` without `CHANNEL_SOURCE` set now skips DB entirely (no phantom sessions)
- **Commits:** 3feb0f5, e88efb3

#### CLI Changes
- `helyx start` — spawns `claude` directly with `CHANNEL_SOURCE=local` (no `run-cli.sh`)
- `helyx restart` — syncs `TELEGRAM_BOT_TOKEN` from `.env` into `~/.claude.json` MCP server config
- `run()` helper — new `stream: true` option pipes stdout/stderr directly to terminal (real-time build output)

### v1.11.0

#### Dashboard Project Management
- Projects page — create, start, stop projects directly from web dashboard (previously Telegram-only)
- SSE notifications — `GET /api/events` streams `session-state` events to dashboard
- Browser notifications — dashboard requests Notification permission, shows push on session state changes
- Projects API — `GET/POST /api/projects`, `POST /api/projects/:id/start|stop`, `DELETE /api/projects/:id`

#### Memory TTL per Type
- Each memory type has its own TTL: `fact` 90d, `summary` 60d, `decision` 180d, `note` 30d, `project_context` 180d
- Hourly cleanup — expired memories deleted automatically based on `created_at`
- Configurable via `MEMORY_TTL_FACT_DAYS`, `MEMORY_TTL_SUMMARY_DAYS`, etc.
- DB migration v9 — `archived_at` column + partial index on `memories` table

### v1.10.0

#### Smart Memory Reconciliation
- LLM-based deduplication — before saving, vector search finds similar memories via cosine similarity, Claude Haiku decides ADD / UPDATE / DELETE / NOOP
- `/remember` shows outcome: `Saved (#N)` / `Updated #N` / `Already known (#N)`
- `project_context` deduplication — session exit summaries update existing context instead of accumulating duplicates
- Graceful fallback — Ollama or Claude API unavailable → plain `remember()`, no data loss
- Config vars: `MEMORY_SIMILARITY_THRESHOLD` (0.35), `MEMORY_RECONCILE_TOP_K` (5)
- **Commits:** 85aa582, d7e3176, d782f5e

### v1.9.0

#### Session Management Redesign
- **Persistent Projects** — `projects` DB table, `/project_add` command saves projects (not JSON file)
- **Remote/Local Sessions** — one remote session per project (persistent), multiple local (temporary per process)
- **Work Summary on Exit** — local session exit triggers AI summary of work done ([DECISIONS][FILES][PROBLEMS][PENDING][CONTEXT]), vectorized to long-term memory
- **Session Switch Briefing** — switching sessions shows last project context summary, injected as system context
- **Semantic Search** — `search_project_context` MCP tool + `/search_context` bot command
- **Archival TTL** — messages and permission_requests archived on summarize, deleted after `ARCHIVE_TTL_DAYS` (30 days default)
- **Status vocab** — `active | inactive | terminated` (was `active | disconnected`)
- DB migrations v6-v8 — projects table, archived_at columns, project_id FK, unique remote-per-project constraint
- **Commits:** df57eda, f52c7f5, 2994474, 4614a78

### v1.8.0

#### Skills & Commands Integration
- `/skills` — Interactive skill browser with inline buttons (reads from `~/.claude/skills/`)
- `/commands` — Custom command launcher (reads from `~/.claude/commands/`)
- `/hooks` — View configured Hookify rules
- Deferred input — Tools requiring args prompt user then enqueue
- Icon support — 38+ emojis for quick visual identification

#### Session Management Commands
- `/add` — Register project as Claude Code session (prompts for path, auto-switches)
- `/model` — Select Claude model via inline buttons (stored in `cli_config.model`)
- Adapter pattern — `adapters/ClaudeAdapter` (message_queue polling), extensible registry
- Session router — `sessions/router.ts` typed routing: standalone / cli / disconnected

#### CLI Refactoring
- `start [dir]` — Register + launch project in current terminal
- `docker-start` — New command for `docker compose up -d`
- `add [dir]` — Now registration-only (saves to config + bot DB, no launch)
- `run [dir]` — New command to launch registered project in terminal
- `attach [dir]` — New command to add window to running tmux `bots` session
- tmux session renamed — `claude` → `bots`

### Earlier Versions (v1.0–v1.7)

Core features established in foundational releases:
- Multi-Session MCP Server (HTTP, port 3847) with tool registry
- Channel Adapter (stdio MCP bridge to Claude Code, LISTEN/NOTIFY)
- One Session Per Project (reuse session on reconnect)
- Auto-Named Sessions (based on project directory basename)
- Standalone Mode (bot responds directly via LLM API)
- Voice Messages (Groq whisper-large-v3 with local Whisper fallback)
- Image Analysis (Claude API in CLI mode, Anthropic API in standalone)
- Auto-Summarization (15 min idle timeout)
- Dual-Layer Memory (short-term sliding window + long-term pgvector embeddings)
- Persistent Projects (projects table as permanent registry)
- Web Dashboard (React + Tailwind, stats/logs/memory/sessions pages)
- Permission Forwarding (Allow / Always / Deny inline buttons with diff preview)
- Statistics & Logging (`/stats`, `/logs`, dashboard charts)
- CLI Tool (setup wizard, session management, Docker integration)

---

## 🚧 In Progress

None currently. Latest merged work completed in v1.22.0.

---

## 📋 Planned

These items have PRDs written and are ready to implement.

### Project Rename: helyx → Helyx (temporary name, pending final decision)
- Full rename: CLI, MCP servers, Docker, DB, Telegram bot, domain, GitHub repo
- **PRD:** `docs/requirements/rename-to-helyx-2026-04-10/en/rename-to-helyx.md`
- **Blocked on:** final name decision

### GitHub Actions E2E CI — Activate Secrets
- Workflow `.github/workflows/e2e.yml` is committed and ready
- **Blocked on:** adding 3 secrets in GitHub repo Settings → Secrets and variables → Actions:
  - `CLAUDE_BOT_TOKEN` — Telegram bot token
  - `ALLOWED_USERS` — `446593035`
  - `TEST_BASE_URL` — `https://helyx.mrciphersmith.com`
- **After:** E2E tests run automatically on every push to main and PRs

---

## 💡 Future Ideas

Features identified as valuable but without PRDs yet.

### Multi-User Support
- Separate session namespaces per Telegram user
- Per-user memory and context isolation
- Role-based access control (read-only, admin, etc.)
- **Why:** Current bot is single-user (`ALLOWED_USERS` whitelist only). Teams and shared projects need isolation.
- **Effort:** High — major schema changes (user_id FK in sessions, memories, projects)

### Inline Mode
- Respond in any Telegram chat via `@bot` mention (not just private chat)
- Forward task updates to group chats or channels
- **Why:** Currently bot only works in private DMs. Shared task coordination requires a workaround.
- **Effort:** Medium — grammY supports inline queries; main work is adapting context routing

### Batch Deduplication
- Retroactive cleanup of existing duplicate memories
- LLM-driven reconciliation of entire `memories` table
- **Why:** Smart Memory Reconciliation (v1.10) only applies to new memories. Backlog may still have duplicates.
- **Effort:** High — scanning and reconciling 10K+ records; careful transaction handling

### Graph-Based Memory Relationships
- Track relationships between memories: depends_on, relates_to, contradicts, extends
- Use graph for more intelligent reconciliation and search
- **Why:** Currently memories are flat records with no explicit connections.
- **Effort:** Very High — requires schema redesign (separate relationships table, graph query logic)

### Multi-Provider Model Switching at Message Time
- Easy switching between providers mid-session
- Per-message provider override (`/use google-ai`, then send message)
- **Why:** Currently provider is fixed at setup; swapping requires `.env` edit + restart.
- **Effort:** Medium — routing logic in message handler + provider config per session

### Remote Access via SSH Tunnel (Automated)
- Auto-setup Cloudflare Tunnel or frp tunnel for remote laptop deployment
- `helyx setup-tunnel` command
- **Why:** Extended guide exists (`guides/remote-laptop-setup.md`); could be fully automated.
- **Effort:** High — tunnel management, DNS setup, certificate rotation

### Persistent Dashboard State
- Dashboard state survives page reload
- Deep linking via query params (`?tab=memory&type=fact&sort=recent`)
- LocalStorage for user preferences
- **Why:** Dashboard loses state on refresh (scroll position, open menus, filters).
- **Effort:** Low — localStorage middleware + query param routing

### Conversation Threading
- ~~Group messages by session/project in Telegram topic threads~~
- ~~Telegram topic per project~~
- Moved to 📋 Planned — PRD written: `docs/requirements/forum-topics-2026-04-09/en/forum-topics.md`

---

## How to Keep This Updated

### When to Update

**Add items to Planned:**
- When a new PRD is created in `docs/requirements/` → add PRD filename and brief description

**Move items to In Progress:**
- When work starts on a feature branch (`feat/...`); add branch name

**Move items to Done:**
- When PR is merged to `main` and released in a version tag
- Group by version number (descending), add commit hashes

**Update Future Ideas:**
- Add ideas when identified in discussions/issues
- Remove ideas that get PRDs (move to Planned)

### Where to Check

- **Latest commits:** `git log --oneline -40`
- **All PRDs:** `docs/requirements/*/en/*.md` (newer dates = higher priority)
- **Shipped features:** README.md "Recent Changes" sections
- **Guides:** `guides/` directory for documented workflows

---

## Quick Links

- **[README](../README.md)** — Features, Quick Start, Architecture diagram
- **[Architecture](../guides/architecture.md)** — Module map, service layer, logging, testing internals
- **[Human Spec](spec/en/spec.md)** — Full project specification for developers
- **[AI Spec](spec/ai/spec.md)** — Machine-readable spec for AI agents
- **[Usage Scenarios](../guides/usage-scenarios.md)** — Common workflows
- **[Memory System](../guides/memory.md)** — Short-term and long-term memory details
- **[Webapp Guide](../guides/webapp.md)** — Telegram Mini App features
- **[MCP Tools](../guides/mcp-tools.md)** — Available MCP tools for Claude Code
- **[Remote Laptop Setup](../guides/remote-laptop-setup.md)** — Deploy on remote machines

---

**Last updated:** 2026-04-09 (v1.20.0)
