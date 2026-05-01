# Helyx — Architecture

**Version:** 1.46.0

---

## Overview

Helyx is a durable, crash-tolerant orchestrator that exposes a Claude Code CLI session to a human operator via Telegram. Architecturally it is a **hybrid event-driven message-broker system with a split-deployment MCP bridge**: all user messages flow through a PostgreSQL `message_queue` table rather than direct in-process calls, real-time state changes propagate via Server-Sent Events (SSE) and `LISTEN/NOTIFY`, and the system deliberately occupies two separate execution environments — a Docker container and the host machine — because certain subsystems cannot run inside Docker.

The most architecturally unusual feature is the use of the Model Context Protocol (MCP) on **both sides** of Claude Code simultaneously, using two completely different transport mechanisms for two opposite data-flow directions. One MCP server runs on the host as a stdio subprocess of Claude Code (delivering Telegram messages inward); a second MCP server runs in Docker over HTTP/SSE (receiving Claude Code tool calls outward). These two servers partially overlap in the tools they expose, so Claude Code can use whichever transport is most convenient for a given operation.

The design prioritises crash tolerance throughout. Every message delivery is guarded by a `pending_replies` pre-mark pattern to prevent duplicate sends on process restart. Lease-based session ownership (TTL columns, not advisory locks) auto-expires without requiring explicit release. Permission requests are polled at 500 ms intervals and auto-denied after 10 minutes. A five-loop supervisor daemon continuously monitors session heartbeats, stuck queues, stale voice messages, and editor locks, and triggers automatic recovery by inserting commands into a `admin_commands` queue that the host-side daemon drains — keeping the Dockerised bot entirely decoupled from host shell operations.

---

## System Components

| Component | Type | Runtime | Port | Responsibility |
|---|---|---|---|---|
| **grammy Bot** | Telegram handler layer | Docker (`helyx-bot`) | — | Routes all Telegram updates (text, voice, media, commands, callbacks) to DB or standalone Claude API |
| **MCP HTTP Server** | MCP + REST server | Docker (`helyx-bot`) | 3847 | Receives Claude Code tool calls (StreamableHTTP/SSE), serves dashboard REST API and static SPA assets, handles Telegram webhook |
| **PostgreSQL 16 + pgvector** | Relational store | Docker (`helyx-postgres`) | 5432 | All persistent state: sessions, message queue, memories, permissions, telemetry, skills |
| **stdio MCP Adapter** (`channel/`) | MCP stdio server | Host machine | stdio | Bridges Claude Code ↔ Telegram/DB; polls message queue; handles permission gating; drives status messages and TTS |
| **Admin Daemon** (`scripts/admin-daemon.ts`) | Command executor | Host machine | — | Drains `admin_commands` table; executes tmux/Docker shell ops; starts watchdog and supervisor |
| **Tmux Watchdog** (`scripts/tmux-watchdog.ts`) | Process monitor | Host machine | — | Captures Claude Code pane output every 5 s; detects stalls, editor locks, credential prompts, crashes; writes pane snapshots to DB |
| **Session Supervisor** (`scripts/supervisor.ts`) | Health monitor | Host machine | — | Five independent loops: heartbeat checks, stuck queue alerts, voice cleanup, status broadcast, idle auto-compact |
| **Dashboard SPA** (`dashboard/src/`) | React admin UI | Browser | — | Full control panel: sessions, memories, projects, permissions, logs, monitor, stats |
| **Telegram Mini App** (`dashboard/webapp/src/`) | React mini UI | Browser (Telegram) | — | Lightweight in-Telegram panel for git, permissions, timeline, sessions |
| **Claude Code CLI** | AI agent | Host (tmux panes) | — | Consumes both MCP transports; executes coding tasks; calls tools to communicate results |
| **Ollama** | Embedding service | Host machine | 11434 | Generates 768-dim `nomic-embed-text` embeddings for semantic memory search |
| **Cleanup Runner** (`cleanup/runner.ts`) | Maintenance job | Docker (`helyx-bot`) | — | Hourly deletion of delivered messages, stale logs, archived memories, orphan sessions |

---

## Deployment Split

```
┌──────────────────────────────────────────────────────────┐
│  Docker Compose                                           │
│                                                           │
│  ┌────────────────────────────────────────────────────┐  │
│  │  helyx-bot container  (bun main.ts)                │  │
│  │                                                    │  │
│  │  ├── grammy bot  (Telegram long-polling/webhook)  │  │
│  │  ├── MCP HTTP server  (:3847)                     │  │
│  │  │     ├─ POST /mcp   (StreamableHTTP + SSE)      │  │
│  │  │     ├─ GET|POST /api/*  (REST dashboard)       │  │
│  │  │     └─ static files  (dashboard SPA)           │  │
│  │  ├── SessionManager / SessionRouter               │  │
│  │  ├── NotificationBroadcaster  (SSE to browser)    │  │
│  │  └── Cleanup jobs  (hourly timer)                 │  │
│  └────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌────────────────────────────────────────────────────┐  │
│  │  helyx-postgres container                          │  │
│  │  PostgreSQL 16 + pgvector (port 5432)             │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
         │ DATABASE_URL          │ http://localhost:3847
         │                       │ (BOT_API_URL)
┌──────────────────────────────────────────────────────────┐
│  Host Machine                                             │
│                                                           │
│  systemd helyx.service                                    │
│  └── bun admin-daemon.ts                                 │
│        ├── tmux-watchdog.ts  (5 s poll loop)             │
│        └── supervisor.ts  (5 × setInterval loops)        │
│                                                           │
│  tmux session "bots"                                      │
│  └── window per project                                   │
│        └── run-cli.sh  (auto-restart loop)               │
│              └── claude … server:helyx-channel           │
│                    └── channel.ts  (stdio MCP server)    │
│                          ├─ polls message_queue          │
│                          ├─ drives status messages       │
│                          └─ handles TTS / permissions    │
│                                                           │
│  Ollama  (port 11434, nomic-embed-text)                  │
└──────────────────────────────────────────────────────────┘
```

**Why the split exists:**

- `StdioServerTransport` requires the MCP server to be a direct subprocess of Claude Code, communicating over inherited stdin/stdout file descriptors. Container boundaries break this connection entirely.
- TTS synthesis (kokoro-js, Piper binary) depends on native host libraries that are not included in the Docker image and would be impractical to ship inside it.
- `channel.ts` must call `/api/sessions/expect` on the MCP HTTP server before Claude Code connects (to pre-register the session). Running on the host eliminates any Docker scheduling delay that would cause a race condition at connect time.
- Admin operations (tmux commands, `docker restart`) require direct access to host shell resources — they cannot be executed from inside Docker without privileged socket mounts.

---

## The Two MCP Transports

This is the key architectural feature that distinguishes Helyx from a simpler bot-to-LLM proxy. Claude Code connects to **two separate MCP servers simultaneously**, each implemented with a different transport, serving opposite data-flow directions.

```
                        ┌─────────────────────┐
                        │   Claude Code CLI    │
                        │   (tmux pane, host)  │
                        └──────────┬───────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                     │
   Transport A (stdio)   Transport B (HTTP/SSE)          │
              │                    │                     │
   stdin/stdout pipes    POST http://localhost:3847/mcp  │
              │                    │                     │
              ▼                    ▼                     │
   ┌──────────────────┐  ┌─────────────────────┐        │
   │  channel.ts      │  │  mcp/server.ts       │        │
   │  StdioServer     │  │  StreamableHTTP      │        │
   │  Transport       │  │  ServerTransport     │        │
   │  (HOST)          │  │  (DOCKER :3847)      │        │
   └────────┬─────────┘  └──────────┬──────────┘        │
            │                        │                    │
            ▼                        ▼                    │
   Polls message_queue     Dispatches tool calls          │
   Sends MCP notifications  to bot/DB/Telegram            │
   into Claude Code         Serves dashboard REST         │
            │                        │                    │
            └────────────────────────┘                    │
                        PostgreSQL                        │
```

### Transport A — stdio (`channel/`)

Claude Code's `settings.json` registers `channel.ts` as an MCP server named `helyx-channel`, pointing to `bun /path/to/channel.ts`. When Claude Code starts, it spawns `channel.ts` as a subprocess and connects via stdin/stdout.

**Primary flow (inbound):** The Telegram message queue → Claude Code

1. `channel.ts` opens a dedicated PostgreSQL connection and issues `LISTEN message_queue_{sessionId}`.
2. When a new Telegram message is inserted into `message_queue`, a DB trigger fires `pg_notify('message_queue_{sessionId}', rowId)`.
3. The `MessageQueuePoller` wakes immediately, dequeues the row with `SELECT FOR UPDATE SKIP LOCKED`, and sends an MCP `notifications/claude/channel` notification over the stdio pipe into Claude Code.
4. Claude Code processes the user message and calls MCP tools on this same transport.

**Secondary flow (tool calls):** Claude Code → reply, remember, recall, permissions, TTS, polls

Tools exposed: `reply`, `remember`, `recall`, `forget`, `update_status`, `list_memories`, `search_project_context`, `scan_project_knowledge`, `react`, `edit_message`, `send_poll`, `skill_view`, `propose_skill`, `save_skill`, `list_agent_skills`, `curator_run`, `curator_status` (19 tools total).

Permission gating runs exclusively on this transport: when Claude Code is about to perform a destructive operation, it emits a `notifications/claude/channel/permission_request` notification. `PermissionHandler` intercepts it, checks auto-approve patterns, and if no match, sends an interactive Telegram message with `✅ Yes / ✅ Always / ❌ No` buttons and polls `permission_requests` at 500 ms until the user responds.

Security boundary: the process boundary itself. No authentication is needed — stdin/stdout is inherently private.

### Transport B — HTTP/SSE (`mcp/`)

Claude Code's `settings.json` also registers `http://localhost:3847/mcp` as an MCP server named `helyx`. Claude Code connects over HTTP using the `StreamableHTTPServerTransport` protocol, which uses HTTP POST for requests and an SSE stream for server-initiated events.

**Primary flow (outbound):** Claude Code tool calls → bot/DB/Telegram

Tools exposed: `remember`, `recall`, `forget`, `list_memories`, `reply`, `react`, `edit_message`, `list_sessions`, `session_info`, `set_session_name`, `scan_project_knowledge`, `search_project_context`, `skill_view`, `propose_skill`, `save_skill`, `list_agent_skills`, `curator_run`, `curator_status` (18 tools total).

The key session-linking tool is `set_session_name`, which Claude Code calls at startup. The `SessionManager.adoptOrRename()` method finds the `channel.ts` session for the same `project_path` and links both MCP transports to the same DB session record, so tool calls from either transport share the same session context and memory.

Security boundary: IP allowlist. Only loopback (`127.0.0.1`, `::1`) and Docker bridge CIDRs (`172.16.0.0/12`) are accepted. No JWT is required — the endpoint is not externally reachable.

### Transport Comparison

| Concern | Transport A — stdio (`channel/`) | Transport B — HTTP/SSE (`mcp/`) |
|---|---|---|
| Transport class | `StdioServerTransport` | `StreamableHTTPServerTransport` |
| Runtime | Host machine | Docker container |
| Primary purpose | Push Telegram messages into Claude Code | Receive tool calls from Claude Code |
| Permission gating | Yes — intercepts MCP notifications | No |
| TTS voice synthesis | Yes — runs on host with native libs | No |
| Status message management | Yes | No |
| Session naming / linking | No | Yes (`set_session_name`) |
| Dashboard REST API | No | Yes |
| Auth | Process boundary (no auth needed) | IP allowlist |

The tool sets overlap intentionally (both offer `remember`, `recall`, `reply`, etc.), so Claude Code can call either transport depending on context. The implementations produce equivalent effects but write slightly different telemetry.

---

## PostgreSQL as Message Bus

PostgreSQL is not merely the data store — it functions as the **primary message broker** between the Docker container and the host process. No direct network connection exists between the grammy bot and `channel.ts`; all coordination flows through the database.

### The `message_queue` Table + `LISTEN/NOTIFY`

When a user sends a Telegram message:

1. The grammy bot inserts a row into `message_queue(chat_id, session_id, content, attachments)`.
2. A PostgreSQL trigger fires automatically:
   ```sql
   -- Trigger installed at migration v2
   CREATE FUNCTION notify_message_queue() RETURNS trigger AS $$
   BEGIN
     PERFORM pg_notify(
       'message_queue_' || NEW.session_id::text,
       NEW.id::text
     );
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql;
   ```
3. `channel.ts` (host), which has an open `LISTEN message_queue_{sessionId}` connection, receives the notification and wakes immediately — typically within single-digit milliseconds.
4. A 500 ms polling fallback fires if the `LISTEN` connection is not yet established.

This pattern provides three properties simultaneously:

- **Durability**: rows survive process crashes; the bot and the channel can restart independently without losing messages.
- **Deduplication**: a `UNIQUE(chat_id, message_id)` index prevents duplicate inserts from bot retries, and `FOR UPDATE SKIP LOCKED` prevents duplicate delivery if two `channel.ts` instances coexist briefly during a bounce.
- **Deferral**: if Claude Code is mid-turn (tracked via `StatusManager.getBusyChats()`), the dequeue loop skips messages for that chat and waits for `pg_notify` to fire again after the current turn completes.

### `admin_commands` — Command Queue for Host Operations

A second queue table, `admin_commands`, extends the same pattern to cover host-side shell operations. When the user taps `/stop`, `/bounce`, or a project start/stop button in Telegram, the bot inserts a row into `admin_commands`. The `admin-daemon` polling loop (2 s interval, `FOR UPDATE SKIP LOCKED`) picks up the row and executes the corresponding tmux or Docker command on the host. This keeps the Docker container entirely decoupled from host shell access.

### Other Polling Surfaces

| Table | Poller | Interval | Purpose |
|---|---|---|---|
| `permission_requests` | `PermissionHandler` in `channel.ts` | 500 ms | Detect user's button response to a permission prompt |
| `active_status_messages` | `supervisor.ts` heartbeat loop | 60 s | Detect stale status messages (crashed channel) |
| `process_health` | `admin-daemon` | 30 s | Write Docker + daemon health state for `/monitor` |
| `message_queue` | `MessageQueuePoller` | 500 ms fallback | Safety net when `LISTEN` wakeup is delayed |

---

## Data Flow: Telegram Message → Claude Code → Response

### Inbound: User message → Claude Code

```
1.  User sends text (or voice, media) in Telegram DM or forum topic.

2.  grammy bot receives update (long-polling or webhook).
    └── accessMiddleware: check ALLOWED_USERS whitelist; drop silently if denied.

3.  Forum topic routing (if applicable):
    └── routeMessage(chatId, forumTopicId)
        ├── forum topic → JOIN projects+sessions ON forum_topic_id
        └── DM         → chat_sessions → active_session_id

4.  Route target resolution:
    ├── mode=standalone  → direct Anthropic API call (no channel.ts involved)
    ├── mode=disconnected → reply with "session not active" error
    └── mode=cli         → proceed to queue

5.  [Voice only] Whisper transcription (Groq → local fallback).
    └── Live status message: "🎤 transcribing…"

6.  INSERT INTO message_queue(chat_id, session_id, content, attachments)
    └── DB trigger: pg_notify('message_queue_{sessionId}', rowId)
    └── React 👀 on original Telegram message.

7.  channel.ts MessageQueuePoller (host) wakes from LISTEN.
    └── SELECT FOR UPDATE SKIP LOCKED (dedup guard).
    └── Skip if chat is in getBusyChats() — defer until current turn ends.

8.  SkillEvaluator scores message against goodai-base/rules.json.
    └── If score ≥ 4: prepend "[Skill Evaluator] skills: X · rules: Y" hint.

9.  MCP notification → Claude Code (over stdio):
    notifications/claude/channel { content, forceVoice, hint }
    └── React ⚡ on original message (upgrades 👀).

10. StatusManager.sendStatusMessage():
    └── Telegram: "⏳ Thinking… (0:00)"
    └── INSERT active_status_messages (survives bot restart).
    └── Start 1 s edit interval (spinner + elapsed time).
    └── Start 10 s pane snapshot refresh (tmux output in status).
    └── Arm 5-minute response guard timer.
```

### Outbound: Claude Code → user response

```
1.  Claude Code calls reply() MCP tool (over stdio to channel.ts).

2.  INSERT pending_replies (pre-mark as delivered — TOCTOU protection).

3.  Convert markdown → Telegram HTML; chunk at 4096 chars if needed.

4.  [Optional] TTS pipeline:
    └── normalizeForSpeech(): strip markdown + LLM rewrite.
    └── detectRussian(): select language.
    └── synthesize(): Piper / Yandex / Kokoro / Groq / OpenAI.
    └── sendTelegramVoice() — OGG audio file.

5.  sendTelegramMessage() → Telegram API.
    └── 429 rate limit: wait retry_after field; total 60 s budget.
    └── 5xx: 3 retries with 1/2/3 s backoff.

6.  Mark pending_replies.delivered_at = now().

7.  StatusManager.deleteStatusMessage():
    └── Edit status → "✅ 1m 23s · 📝 3 files · ↓ 4200 tokens".
    └── DELETE active_status_messages.
    └── pg_notify(message_queue_{sessionId}) — wake poller for deferred messages.

8.  [On session end] summarizeWork():
    └── Generate [DECISIONS]/[FILES]/[PROBLEMS]/[CONTEXT] structured summary.
    └── rememberSmart() → memories table with pgvector HNSW embedding.
    └── extractProjectKnowledge() → type='fact' memories (non-blocking).
```

---

## Permission Request Flow

Claude Code emits a permission notification before any destructive operation (file write, bash command, etc.). `channel.ts` intercepts it and gates execution on operator approval.

```
1.  Claude Code emits MCP notification:
    notifications/claude/channel/permission_request
    { toolName, input: { command | path | description } }

2.  PermissionHandler in channel/permissions.ts intercepts the notification.

3.  Check auto-approve patterns from settings.local.json (project + global).
    └── Match found → immediately notify behavior="allow"; skip to step 9.

4.  Check for duplicate in permission_requests table (Claude may retry).
    └── Duplicate → return cached response.

5.  Build preview:
    ├── Edit/Write → unified diff block.
    ├── Bash → full command text.
    └── Read/Grep → file path or pattern.

6.  Send to Telegram:
    ├── Code block message with the preview.
    └── Button message: "✅ Yes  |  ✅ Always  |  ❌ No"
    └── INSERT permission_requests(status='pending').

7.  Poll permission_requests.response every 500 ms (up to 10 minutes).
    └── Every 2 min: edit button message showing elapsed time.

8.  User taps a button in Telegram:
    └── bot/callbacks.ts handlePermissionCallback fires.
    └── UPDATE permission_requests status='approved' or 'rejected'.
    └── [Always] append pattern to settings.local.json (project + global).
    └── [Always] reload auto-approve rules in PermissionHandler.

9.  Polling detects the response (or 10-minute timeout auto-denies).
    └── Notify Claude Code: behavior="allow" or "deny".
    └── Claude Code proceeds with or aborts the tool call.
```

---

## Cross-Cutting Concerns

### Authentication

| Surface | Mechanism | Token | Expiry |
|---|---|---|---|
| Telegram bot | User whitelist (`ALLOWED_USERS` env) | Telegram user ID | Permanent |
| `/system` command | `isAdmin()` vs `TELEGRAM_CHAT_ID` | — | Per-request |
| Dashboard (main) | Telegram Login Widget → JWT HS256 `HttpOnly` cookie | `SameSite=Lax; Secure` | 7 days |
| Telegram Mini App | `initData` HMAC-SHA256 → JWT Bearer token | `Authorization: Bearer` header | — |
| MCP endpoint (`/mcp`) | IP allowlist (loopback + `172.16.0.0/12`) | — | Per-connection |
| CSRF | `Origin` vs `Host` comparison on non-GET requests | — | Per-request |
| JWT secret | `JWT_SECRET` env or `HMAC(sha256, "jwt:" + bot_token)` | — | — |

The Telegram Login Widget verification follows the official Telegram spec: the server computes `HMAC-SHA256(data_check_string, SHA256(bot_token))` with a 24-hour freshness window and a timing-safe comparison. The Mini App `initData` verification uses `HMAC-SHA256(data_check_string, HMAC-SHA256("WebAppData", bot_token))` with a 1-hour freshness window.

### Logging

- **Structured logging**: Pino v10, JSON output to stdout.
- **Request logs**: stored in `request_logs` table (session_id, level, stage, message); rotated after 7 days by the cleanup job.
- **LLM telemetry**: `api_request_stats` (provider, model, tokens, cost, duration per call); rotated after 30 days.
- **Voice telemetry**: `transcription_stats` (provider, audio duration, cost, status).
- **Aux LLM cost tracking**: `aux_llm_invocations` (skill curator/distiller invocations).
- **Supervisor incidents**: `supervisor_incidents` table with optional Ollama LLM diagnosis.

### Configuration

- **Validation**: Zod schemas in `config.ts` (Docker-side) and `ChannelEnvSchema` in `channel/index.ts` (host-side). Both fail fast on startup if required vars are missing.
- **Secrets**: environment variables only; `.env` file is loaded by `channel.ts` and `admin-daemon.ts` at startup, skipping keys already set in the shell environment.
- **Per-project config**: `~/.claude/projects/<encoded-path>/settings.local.json` stores per-project auto-approve patterns. The Docker container mounts the host `~/.claude/` directory via `HOST_CLAUDE_CONFIG`.
- **DB migrations**: `memory/db.ts` validates the migration registry for uniqueness and strictly ascending version order on every startup before applying pending migrations. Current schema version: 43.

### Error Recovery

| Failure scenario | Recovery strategy |
|---|---|
| Telegram 429 rate limit | Auto-retry with `retry_after` from response; total 60 s budget |
| Telegram 5xx / network error | 3 retries with 1/2/3 s backoff |
| Claude Code silent for 5 minutes | Response guard sends "hasn't responded" fallback message |
| Permission timeout (10 min) | Auto-deny; Claude Code receives `behavior="deny"` |
| Ollama unreachable | `embedSafe()` stores `NULL` embedding; data preserved, semantic search degraded |
| Bot restart with open status messages | `recoverStaleStatusMessages`: edits zombie messages to "⚠️ Bot restarted" |
| Bot restart with pending voice status | `recoverStaleVoiceStatusMessages`: edits to "⚠️ Bot restarted — voice not processed" |
| Pending replies not delivered | `deliverPendingReplies`: retries rows with `delivered_at IS NULL` and age > 30 s |
| `channel.ts` lease stolen by another instance | Current instance detects theft at heartbeat; self-terminates gracefully |
| Admin command stuck for 5 min | `admin-daemon` resets `processing` rows to `pending` on startup |
| Session heartbeat stale for 2 min | Supervisor queues a `proj_start` auto-recovery command; escalates if project keeps failing for > 30 min |

---

## Key Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Two MCP transports** | stdio on host + HTTP/SSE in Docker | stdio cannot cross container boundaries; HTTP/SSE can. TTS requires host native libraries. Both directions of Claude Code communication are needed simultaneously. |
| **PostgreSQL as message bus** | `message_queue` + `LISTEN/NOTIFY` trigger | Durable delivery across process restarts; deduplication via `UNIQUE(chat_id, message_id)`; `FOR UPDATE SKIP LOCKED` for safe concurrent delivery. |
| **Lease-based session ownership** | `lease_owner` + `lease_expires_at` TTL column (not `pg_advisory_lock`) | Auto-expires without explicit release on crash; supports intentional lease theft for bounce recovery; enables heartbeat-based liveness detection. |
| **Command queue for host operations** | `admin_commands` table polled by `admin-daemon` | The Docker bot cannot execute tmux or Docker commands directly. Decoupling via DB queue eliminates the need for privileged socket mounts and keeps the bot stateless with respect to host process management. |
| **No ORM** | Raw SQL via `postgres` tagged templates | Full SQL control; pgvector operators (`<=>` cosine distance, `&&` array overlap) have no ORM equivalents. |
| **Pending replies buffer** | Pre-mark `delivered_at` before Telegram send | TOCTOU protection: if the process dies after a successful Telegram send but before the DB update, the recovery job detects `delivered_at IS NOT NULL` and skips re-delivery. |
| **Soft deletes** | `archived_at` column on messages, permissions, memories | Enables cleanup jobs with configurable per-type TTLs without immediate data loss; allows `deliverPendingReplies` and other recovery paths to see recently deleted rows. |
| **LLM-driven memory reconciliation** | `rememberSmart`: embed → cosine search → LLM (ADD/UPDATE/DELETE/NOOP) | Prevents semantic duplicates without exact-string matching; uses Haiku for cost efficiency on internal ops. |
| **Forum topic routing** | One Telegram forum topic per project | Enables parallel multi-project operation with natural context grouping; eliminates session confusion when the user works on multiple codebases simultaneously. |
| **Response guard timer** | 5-minute fallback if `reply` is never called | Prevents indefinite user wait when Claude Code gets stuck or crashes without completing a turn. |
| **Auxiliary LLM separation** | `utils/aux-llm-client.ts` (DeepSeek/Ollama/OpenRouter) for internal ops | Keeps skill curation, distillation, and summarization costs separate from user-facing Claude Code session costs; allows cheaper models for high-frequency internal tasks. |
| **Skills approval gate** | Agent proposes → human approves → curator manages weekly | Prevents unsupervised skill accumulation; maintains quality; requires on-disk SKILL.md files because Claude Code's native skill loading reads from the filesystem. |
