# Changelog

## v1.31.0

### fix: security hardening + concurrency correctness (full project review)

Comprehensive review of 58 files (4009 insertions since v1.24.0) produced 6 blockers
and 18 major findings — all fixed in this release.

**Security:**
- `handleMonitorCallback` now checks `TELEGRAM_CHAT_ID` before queuing Docker/daemon
  restarts — matches the guard already present in `handleSupervisorCallback`
- `scan_project_knowledge` MCP tool validates the target path is within
  `HOST_PROJECTS_DIR` / `HOME` to prevent path traversal
- `cli.ts` `helyx add` / `helyx remove`: allowlist regex validation + LIKE wildcard
  escaping (`%`, `_`, `\`) — `helyx remove %` no longer deletes all projects
- Dashboard restart buttons now require `window.confirm()` before firing
- Dashboard mutation errors (restart daemon / restart container) now surface to the
  user instead of being silently swallowed

**Concurrency:**
- All 5 supervisor `setInterval` loops now carry in-flight guards
  (`sessionCheckRunning`, `queueCheckRunning`, `voiceCheckRunning`,
  `broadcastRunning`, `idleCheckRunning`) — prevents overlapping executions that
  caused duplicate `proj_start` commands and duplicate Telegram alerts
- `tgPost` 429-retry now creates a fresh `AbortSignal.timeout(10_000)` instead of
  reusing the already-elapsed one from the first request — all retries actually fire
- `writeProcessHealth`: in-flight guard + `timeout 10 docker ps` to prevent DB pool
  starvation when Docker daemon is hung
- `admin-daemon` startup: reset `admin_commands` rows stuck at `status='processing'`
  (crash-recovery for commands lost between TX commit and `setImmediate` dispatch)

**Data integrity:**
- `checkIdleSessions`: `forceSummarize` return value checked before deleting messages
  — no more data loss when summary quality check skips trivial content
- `checkIdleSessions`: `deleteBefore` timestamp captured before `forceSummarize` call
  — messages arriving during the 30s Ollama call are not deleted
- `IDLE_COMPACT_MIN`: minimum bound `Math.max(10, ...)` prevents accidental compaction
  of all sessions when env var is empty or zero
- `voiceStatusId` race fixed: `INSERT INTO voice_status_messages` is now `await`-ed
  before `enqueueForTopic` — `clearVoiceStatus()` always has a valid ID; removed
  redundant explicit calls on early-return paths (only `finally` runs cleanup now)

**Correctness:**
- `updateDiff` recursive self-call on Telegram edit failure replaced with direct
  non-recursive `sendTelegramMessage` — eliminates stack overflow risk
- `diffMessages` key now includes `message_thread_id` via `diffKey(chatId, extra)` —
  prevents key collision across multiple forum topics sharing the same `chatId`
- `handleMonitor` refresh: `handleMonitor(ctx)` called before `deleteMessage()` so
  the old message stays intact if the new send fails
- `gemma4:e4b` hardcode replaced with
  `OLLAMA_CHAT_MODEL ?? SUMMARIZE_MODEL ?? "gemma4:e4b"` in both `supervisor.ts`
  and `supervisor-actions.ts` — no more 10s hang on installs without that model
- `sendStatusBroadcast` success log: `console.error` → `console.log`

---

## v1.30.0

### feat: Supervisor idle auto-compact + SUMMARIZE_MODEL + summary quality validation

- **feat(supervisor)**: idle session auto-compact after `IDLE_COMPACT_MIN` minutes
  (default 60) with ≥10 messages — calls `forceSummarize`, clears cache + DB
- **feat(memory)**: `SUMMARIZE_MODEL` env var — use local Ollama model for
  summarization (`SUMMARIZE_MODEL=gemma4:e4b`), falls back to main LLM on failure
- **feat(memory)**: summary quality validation before saving — rejects trivial
  summaries (`< 50 chars`, matches "nothing significant" patterns); pre-check skips
  summarization for sessions with avg message length < 25 chars
- **feat(setup)**: Ollama detection in setup wizard — prompts to configure
  `EMBEDDING_MODEL` and `SUMMARIZE_MODEL` when Ollama is available

---

## v1.29.0

### feat: Supervisor LLM diagnosis with Ollama + /status in supervisor topic

- **feat(supervisor)**: switched to `gemma4:e4b` via Ollama `/api/chat` with
  `think: false` (~3.2s vs 7.6s for thinking models)
- **feat(supervisor)**: any message in supervisor topic returns live status + LLM
  assessment of system health, scoped to Helyx monitoring context
- **feat(supervisor)**: recovery verification — polls `active_status_messages` for
  60s after `proj_start`; sends ✅ or ⛔ result; inline 🔄 retry button on failure
- **feat(supervisor)**: 5-minute status broadcast replaces hourly pulse — deletes
  previous message so new one triggers notification

---

## v1.28.0

### feat: Helyx Supervisor — automated session health monitoring

New `scripts/supervisor.ts` module integrated into `admin-daemon`:

- **Session watchdog**: checks `active_status_messages` every 60s — stale heartbeat
  (> 2 min) triggers `proj_start` via `admin_commands`
- **Queue watchdog**: stuck `message_queue` entries (> 5 min, `delivered=false`)
  surface as inline-button alerts (🔄 Restart / ✅ Ignore)
- **Voice cleanup**: `voice_status_messages` rows > 3 min edited to "bot restarted"
  warning + deleted from DB
- **LLM diagnosis**: every incident includes an Ollama explanation (best-effort,
  10s timeout, skipped gracefully when Ollama unavailable)
- **Telegram notifications**: all alerts → `SUPERVISOR_TOPIC_ID` with 429 retry
- **Idempotency**: 5-minute dedup window prevents duplicate alerts per incident

---

## v1.27.7

### fix(voice): track status messages in DB — recover stale "downloading..." on restart

When the bot restarted mid-download, the "🎤 Voice message — downloading..." Telegram
message was never updated, leaving it visually stuck forever. Fix:
- New `voice_status_messages` table: each in-flight voice download registers its
  Telegram status message ID.
- On bot startup, `recoverStaleVoiceStatusMessages` edits any rows older than 5 min to
  "⚠️ Бот перезапущен — голосовое не обработано. Отправь повторно."
- DB row is deleted via `finally {}` after the queue task completes (success or error).

### fix(voice): explicit file_path null check + error reason in status message

Telegram Bot API omits `file_path` for files >20 MB. Using `file.file_path!` (non-null
assertion) caused a silent TypeError crash. Fix throws a descriptive error
(`"File not accessible via Bot API, possibly >20 MB"`). Download failures now show the
actual reason in the Telegram status message instead of a generic "Failed to download".

### fix(voice): 30 s download timeout + queued/downloading status distinction

`downloadFile` had no timeout on the Telegram CDN fetch — a slow response blocked the
per-topic queue indefinitely. Added `AbortSignal.timeout(30_000)`. Status message now
shows "queued..." when the slot is occupied and updates to "downloading..." when the
task actually starts.

---

## v1.27.6

### fix(tmux-watchdog): auto-confirm dev-channel prompt in ALL windows, not just active sessions

Root cause of the "altsay stuck at Enter to confirm" deadlock: `pollWindows()` only
checked windows with active sessions, but a session can only become active *after*
the startup prompt is confirmed — a circular dependency. Fix adds a global window
scan at the top of each poll cycle that sends Enter to any window showing the
`--dangerously-load-development-channels` warning, regardless of session state.

### fix(channel): heartbeat failure counter — exit after 2 consecutive DB errors

Previous code used `.catch(() => true)` on `renewLease()`, silently treating any
DB error as "lease still held". This meant a channel.ts process whose DB connection
died would keep running indefinitely, holding a zombie session. Fix tracks
consecutive failures; exits after 2 so the session is released and a fresh restart
can recover.

### fix(tts): return audio format from synthesize() — prevent MP3-as-WAV delivery

`synthesize()` previously returned `Buffer | null`; callers always sent
`audio/wav` / `voice.wav`. Yandex and OpenAI return MP3, so Telegram rejected the
audio. Fix changes the return type to `{ buf: Buffer; fmt: "mp3" | "wav" } | null`.
Each provider now tags its output format; `maybeAttachVoice` and `maybeAttachVoiceRaw`
use the correct MIME type and filename (`voice.mp3` vs `voice.wav`).

### fix(message_queue): deduplicate on restart — prevent double delivery after Docker restart

Root cause of duplicate responses after `docker compose up -d`: grammY's long-polling
re-delivers Telegram updates that weren't acknowledged before the process died. The
same message was inserted into `message_queue` twice (no uniqueness constraint), both
rows were dequeued and delivered to Claude, producing two replies.

Fix:
- Migration v19: partial unique index on `message_queue(chat_id, message_id)` excluding
  empty strings and `'tool'` entries.
- `bot/text-handler.ts` and `bot/media.ts`: INSERTs now use
  `ON CONFLICT ... DO NOTHING` so duplicate Telegram updates are silently dropped.

---

## v1.27.5

### fix(status): spinner animates at 1 fps instead of every 5 s

Status message edit interval reduced from 5 000 ms to 1 000 ms so the braille
spinner visibly rotates every second. The edit is cheap — pane snapshot and token
counters are already cached; only the spinner frame and elapsed counter change on
each tick.

---

## v1.27.4

### feat(bot): `/interrupt` command — interrupt running Claude session via Telegram

New `/interrupt` Telegram command (`bot/commands/interrupt.ts`):

- If one active remote session → interrupts immediately, no extra prompts.
- If multiple active sessions → shows inline keyboard with ⚡ button per session.
- Inserts `tmux_send_keys` + `esc` action into `admin_commands` queue.

### fix(admin-daemon): poll-based interrupt confirmation instead of fixed sleep

`tmux_send_keys` with `action: "esc"` now polls for the confirmation dialog
(`Enter to confirm / Esc to cancel`) in a loop (200 ms intervals, 1.5 s deadline)
instead of a fixed 800 ms sleep. Faster on quick machines, reliable on slow ones.
Result message distinguishes confirmed vs. Escape-only.

### feat(status): animated braille spinner with stale indicator

`channel/status.ts` now uses a 10-frame braille spinner (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) instead
of a static ⏳ icon. If no `update_status` call arrives for >60 s, the spinner
shows ⚠️ to indicate the session may be stalled.

### fix(channel/tools): delete status after reply is sent

`reply` tool previously deleted the status message before sending the reply, so
the ✅ completion indicator briefly disappeared before the answer appeared.
Status is now deleted after the reply is confirmed sent.

### fix(run-cli.sh): faster and longer auto-confirm polling

Shell-side "development channels" warning auto-confirmer now polls every 0.5 s
(was 1 s) for up to 120 iterations (60 s, was 30 s). Comment updated to reflect
the actual behaviour.

### fix(tmux-watchdog): fallback dev-channel prompt auto-confirm

Added `detectDevChannelPrompt()` as a watchdog fallback for the startup
`--dangerously-load-development-channels` warning. If `run-cli.sh`'s shell-side
watcher races or times out, the watchdog silently sends Enter on the next poll
cycle. No Telegram notification is generated.

### fix(tmux-monitor): visible-only pane capture; normalize status for comparison

`captureTmux()` now captures only the current visible screen (no `-S` scrollback
lines), eliminating ghost detections from already-answered dialogs and stale tool
calls. `normalizeForComparison()` strips elapsed time and token counters before
diffing, preventing status updates from firing every 5 s just because the timer
incremented.

---

## v1.27.3

### fix(projects): idempotency — suppress duplicate start/stop commands

Double-clicking a project button or rapid retries no longer enqueues duplicate
commands. Both layers are guarded:

- **UI layer** (`bot/commands/projects.ts`): checks `getPendingActions()` before
  enqueuing; answers the callback with "Already starting/stopping…" if one is
  already in flight. Also suppresses the Telegram "message is not modified" error
  (content unchanged → no-op instead of delete-and-resend).
- **Service layer** (`services/project-service.ts`): `ProjectService.action()`
  now skips `INSERT` if a matching `pending`/`processing` row already exists.
  `listAll()` uses a `LATERAL` join to surface the most relevant session
  (active preferred, then most-recently-active).

### fix(admin-daemon): kill ALL matching tmux windows to prevent zombie accumulation

`tmux kill-window -t "bots:<name>"` only kills the first matching window — if
multiple windows share the same name (e.g. after a rapid restart), the extras
survive as zombies. Fixed by looping `kill-window` until none remain:

```bash
while tmux kill-window -t "bots:<name>" 2>/dev/null; do :; done
```

Applied to both the `start` path (before re-creating the window) and the `stop`
path. Stop command now prefers `project_id` over name for the session status update.

### fix(tmux-watchdog): visible-only pane capture for permission prompt detection

Permission prompt detection previously used `capturePane()` which includes
scroll-back history. If a dialog had already been answered and scrolled out of
view, the watchdog would re-detect it as active — causing spurious "still active"
false positives.

**Fix:** added `capturePaneVisible()` (no `-S`/`-E` range → current screen only)
and switched permission detection and polling to use it. Dialogs in scroll-back
are already answered and must not trigger re-detection.

Also added a 1 s delay before the first polling iteration so a very fast
auto-approval doesn't make the dialog disappear before the first check, which
previously caused an immediate false "Resolved in terminal" on the first tick.

### fix(tts): language guard after LLM normalization

`normalizeForSpeech` now receives `isRussian` and injects a `Language: Russian /
English. DO NOT translate. Output in <lang> only.` prefix into the user message,
reducing wrong-language normalization.

Additionally, a post-normalization guard checks whether the script ratio changed
(Cyrillic vs Latin). If the normalizer returned text in the wrong language despite
instructions, the bot falls back to the pre-normalization stripped text so the TTS
model always receives input in the correct language.

### feat(docker): Piper TTS directory mounted into container

`docker-compose.yml` now mounts `./piper` as a read-only volume at `/app/piper`
and passes `PIPER_DIR=/app/piper`. The `piper/` directory is added to `.gitignore`
(binary + voice models are not tracked in git).

---

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
