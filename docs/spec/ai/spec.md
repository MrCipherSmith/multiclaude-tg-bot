# Helyx — AI-Readable Machine Specification

**Version:** 1.14.0 | **Updated:** 2026-04-09

This document is optimized for AI agents (Claude instances) that need to understand the system to implement features, debug issues, or review PRs without reading all source files. Use dense, precise language. Verify against actual source if spec conflicts with code — code wins.

---

## ARCHITECTURE_LAYERS

```
LAYER 0 — Telegram
  grammY bot (polling or webhook)
  Entry: bot/bot.ts → bot/handlers.ts → bot/text-handler.ts
  Media: bot/media.ts (voice→Groq transcription; photo/doc→download+attachments JSONB in message_queue)
  Callbacks: bot/callbacks.ts (permission inline buttons)

LAYER 1 — Session Router
  sessions/router.ts → routeMessage(chatId) → { mode: "cli"|"standalone"|"disconnected", sessionId }
  Active session per chatId stored in chat_sessions table

LAYER 2 — Message Dispatch (CLI mode)
  Bot → message_queue (INSERT, incl. attachments JSONB) → channel.ts polls (500ms LISTEN/NOTIFY)
  channel.ts → MCP notifications/claude/channel {content, meta:{attachments?}} → Claude Code process

LAYER 3 — MCP Servers
  HTTP: mcp/server.ts (StreamableHTTPServerTransport) port=3847
    Tools registered: mcp/tools.ts:registerTools()
    Execution: executeTool(clientId, name, args)
  stdio: channel.ts (StdioServerTransport)
    Tools: subset of HTTP tools + update_status
    Sessions adopted/registered via set_session_name()

LAYER 4 — Memory
  Short-term: memory/short-term.ts (in-memory + messages table, window=20)
  Long-term: memory/long-term.ts (pgvector, nomic-embed-text 768-dim)
  Reconciliation: memory/reconcile.ts (Claude Haiku LLM decision)
  Embeddings: memory/embeddings.ts (Ollama, graceful fallback)
  Summarizer: memory/summarizer.ts (idle/overflow/exit triggers)

LAYER 5 — Persistence
  PostgreSQL 16 + pgvector
  Schema: memory/db.ts (migrations via schema_versions table)
  Docker: postgres service, internal networking, pgdata volume

LAYER 6 — Dashboard
  HTTP API: mcp/dashboard-api.ts (routes on same port 3847)
  SSE: mcp/notification-broadcaster.ts (GET /api/events)
  Frontend: dashboard/src/ (React + Tailwind, Vite build)
  WebApp: dashboard/webapp/src/ (Telegram Mini App, Vite build)
  Auth: dashboard/auth.ts (Bearer token, shared secret)
```

---

## COMPONENT_CONTRACTS

### `main.ts`
- **Input**: process.env (config.ts), DATABASE_URL
- **Output**: starts Telegram bot, HTTP server on PORT, runs migrations, sets cleanup timer
- **Invariants**: migrations run before bot starts; cleanup timer fires hourly; SIGTERM graceful shutdown

### `bot/bot.ts`
- **Input**: TELEGRAM_BOT_TOKEN, ALLOWED_USERS
- **Output**: grammY Bot instance with all commands and handlers registered
- **Invariants**: all message types handled; unknown commands → help text; ALLOWED_USERS enforced before all handlers

### `bot/text-handler.ts`
- **Input**: grammY context (ctx.message.text, chatId, userId)
- **Output**: Telegram reply (via ctx.reply or streamToTelegram)
- **Key function**: `handleTextMessage(ctx)` → `routeMessage` → CLI insert or standalone stream
- **Invariants**: always replies; CLI mode inserts to message_queue; response saved to messages table

### `channel.ts`
- **Input**: DATABASE_URL, TELEGRAM_BOT_TOKEN, PORT (stdio MCP transport)
- **Output**: stdio MCP server; polls/delivers messages; sends notifications to Claude Code
- **Key functions**:
  - `registerOrAdopt(name, projectPath)` → calls HTTP MCP `set_session_name` → returns sessionId
  - `pollMessageQueue(sessionId)` → SELECT from message_queue WHERE delivered=false
  - `deliverMessage(msg)` → MCP notification `notifications/claude/channel`
  - `summarizeWork(sessionId)` → POST /api/sessions/:id/summarize-work on exit
- **Invariants**: holds `pg_advisory_lock(sessionId)` while running; heartbeat every 5min; marks delivered=true before ack

### `mcp/server.ts`
- **Input**: HTTP requests on PORT/mcp, mcp-session-id header
- **Output**: MCP StreamableHTTP responses; registers tools via registerTools()
- **Invariants**: new session UUID on first request (no mcp-session-id); existing transport reused on reconnect; no transport → 404

### `mcp/tools.ts`
- **Input**: clientId (transport UUID or "channel-{sessionId}"), toolName, args
- **Output**: MCP tool result (text or error)
- **Key function**: `executeTool(clientId, name, args)` → resolves sessionId via transports map → executes
- **Invariants**: clientId always resolved before tool execution; memory ops scoped by project_path (preferred) or sessionId

### `sessions/manager.ts`
- **Input**: DB operations (register, adopt, update, list, delete)
- **Output**: session records; status transitions
- **Key functions**:
  - `register(name, projectPath, source)` → INSERT INTO sessions
  - `adoptOrRename(clientId, name, projectPath)` → link transport to existing session or rename
  - `markActive(sessionId, clientId)` → UPDATE status='active'
  - `markInactive(sessionId)` → UPDATE status='inactive'
  - `markTerminated(sessionId)` → UPDATE status='terminated'
  - `cleanup()` → DELETE WHERE status IN ('disconnected', 'terminated') AND last_active < threshold
- **Invariants**: one remote session per project (unique constraint); local sessions auto-expire; chat_sessions.active_session_id always valid FK or null

### `sessions/router.ts`
- **Input**: chatId
- **Output**: `{ mode: "cli"|"standalone"|"disconnected", sessionId: number }`
- **Logic**: lookup chat_sessions → if active session + status='active' → "cli"; if active but status='inactive' → "disconnected"; no session → "standalone" (sessionId=0)

### `memory/long-term.ts`
- **Input**: content, type, tags, chatId, projectPath
- **Output**: memory record with embedding; reconciliation result
- **Key functions**:
  - `remember(content, type, tags, chatId, projectPath)` → INSERT INTO memories + embed
  - `rememberSmart(...)` → embed → similarity search → LLM reconcile decision → execute
  - `recall(query, limit, type, tags, chatId, projectPath)` → cosine similarity search via pgvector
  - `forget(id)` → DELETE FROM memories
- **Invariants**: embedding failure → save without embedding (no data loss); reconciliation failure → fallback to plain remember(); project_path scoping preferred over chatId

### `memory/summarizer.ts`
- **Input**: sessionId, chatId, messages
- **Output**: summary saved to memories as type='summary'; messages archived; project_context updated
- **Triggers**: idle (IDLE_TIMEOUT_MS=900000), overflow (2×SHORT_TERM_WINDOW), manual, on-exit
- **Work summary format**: `[DECISIONS]\n...\n[FILES]\n...\n[PROBLEMS]\n...\n[PENDING]\n...\n[CONTEXT]\n...`
- **Invariants**: archived messages set archived_at; never deletes immediately (TTL cleanup handles deletion)

### `bot/callbacks.ts`
- **Input**: grammY callback_query (permission inline button taps)
- **Output**: UPDATE permission_requests.response; bot edit_message; Claude Code unblocked
- **Decision format**: `allow:{sessionId}:{permId}`, `always:{sessionId}:{permId}`, `deny:{sessionId}:{permId}`
- **Invariants**: "always" responses cached in session cli_config.permissions; response written before editing Telegram message

---

## SESSION_INVARIANTS

```
SOURCE VALUES: 'remote' | 'local' | 'standalone'
STATUS VALUES: 'active' | 'inactive' | 'terminated' | 'disconnected'

Remote sessions:
  - Created only by /project_add command or API
  - One per project (UNIQUE constraint on project_id WHERE source='remote')
  - Never auto-deleted
  - client_id = 'remote-{project_id}' (before connection)
  - Status: inactive → active (on channel.ts connect) → inactive (on disconnect)

Local sessions:
  - Created by set_session_name when no remote session exists for path
  - Multiple allowed per project
  - Auto-deleted after ARCHIVE_TTL_DAYS (30d) from last_active
  - Status: active → terminated (on summarize-work call)
  - Messages archived on termination

Standalone session:
  - Pre-inserted at migration time with id=0
  - Never modified, never deleted
  - All standalone messages use session_id=0

Chat-to-session mapping:
  - chat_sessions.active_session_id = current session for chatId
  - Changed by: /switch, /add, /project_add, /standalone commands
  - NULL → standalone mode

Advisory lock:
  - channel.ts holds pg_advisory_lock(sessionId) while connected
  - Prevents two channel.ts from managing same session
  - Auto-released on connection drop
```

---

## MCP_TOOLS_REGISTRY

All tools available on both HTTP MCP server and channel.ts stdio adapter unless marked.

```
remember
  params: content(str), type?(fact|summary|decision|note), tags?(str[]), source?(telegram|cli|api)
  behavior: embed via Ollama → smart reconcile (LLM) → INSERT memories
  scoping: project_path preferred, chatId fallback
  returns: text("Saved (#N)" | "Updated #N" | "Already known (#N)")

recall
  params: query(str), limit?(int, default 5), type?(str), tags?(str[])
  behavior: embed query → cosine similarity search → rank by distance
  scoping: project_path or chatId
  returns: formatted memory list with IDs, types, content

forget
  params: id(int)
  behavior: DELETE FROM memories WHERE id=id
  returns: text("Deleted memory #N")

list_memories
  params: type?(str), tags?(str[]), limit?(int, default 10), offset?(int)
  behavior: SELECT FROM memories with filters, ORDER BY created_at DESC
  returns: formatted list

reply
  params: text(str), chatId?(str), parse_mode?(HTML|Markdown|MarkdownV2)
  behavior: sends Telegram message; deletes active status message first
  returns: text("Message sent to {chatId}")
  note: chatId resolved from session if not provided

react
  params: chat_id(str|int), message_id(int), emoji(str)
  behavior: POST telegram/setMessageReaction
  returns: text("Reaction {emoji} set on message {message_id}")

edit_message
  params: chat_id(str|int), message_id(int), text(str), parse_mode?(str)
  behavior: POST telegram/editMessageText; falls back HTML → plain text
  returns: text("Message {message_id} edited")

list_sessions
  params: (none)
  behavior: SELECT all sessions with status, source, project, last_active
  returns: formatted table

session_info
  params: sessionId?(int)
  behavior: SELECT session details; uses caller's session if sessionId omitted
  returns: formatted session details

set_session_name
  params: name(str), projectPath?(str)
  behavior: adoptOrRename() → register or link transport to existing session
  returns: JSON { sessionId, name, status }
  note: called automatically by channel.ts on startup

search_project_context
  params: query(str), projectPath?(str), limit?(int, default 5)
  behavior: recall filtered to type IN ('project_context', 'summary')
  returns: formatted context list

update_status  [stdio only — channel adapter]
  params: status(str), chatId(str), diff?(str)
  behavior: edit or send Telegram status message; store message_id in session; send diff as separate message if provided
  note: status message auto-deleted when reply() is called
  returns: text("Status updated")
```

---

## MEMORY_CONTRACTS

```
EMBEDDING:
  model: nomic-embed-text (Ollama)
  dims: 768
  fallback: null vector → saved without embedding → not similarity-searchable
  index: HNSW on memories.embedding (cosine distance)

RECONCILIATION (rememberSmart):
  threshold: MEMORY_SIMILARITY_THRESHOLD (default 0.35)
  top_k: MEMORY_RECONCILE_TOP_K (default 5)
  llm: Claude Haiku (claude-haiku-4-5-20251001)
  decisions:
    ADD               → INSERT new memory
    UPDATE id=X       → UPDATE memories SET content=..., updated_at=now() WHERE id=X
    DELETE id=X       → DELETE FROM memories WHERE id=X + INSERT new memory
    NOOP              → no action (content already captured)
  parse failure → fallback to plain remember()

TYPES AND TTL:
  fact:            90 days
  summary:         60 days
  decision:        180 days
  note:            30 days
  project_context: 180 days
  (all configurable: MEMORY_TTL_{TYPE}_DAYS)

SCOPING RULES (priority order):
  1. project_path (cross-session, project-level) — preferred
  2. chatId (user-level, cross-session legacy)
  3. session_id (session-level, legacy)

CLEANUP:
  Runs hourly (setInterval in main.ts)
  Deletes WHERE archived_at < now() - ARCHIVE_TTL_DAYS (30d)
  Marks sessions stale WHERE last_active < now() - 15min AND status='active'

SEARCH:
  Uses <-> operator (pgvector cosine distance)
  ORDER BY embedding <-> $queryVector LIMIT $k
  search_project_context filters type IN ('project_context', 'summary')
  recall searches all types
```

---

## KEY_FILE_MAP

```
Entry points:
  main.ts                 → server startup, migration, cleanup timer
  channel.ts              → stdio MCP adapter for Claude Code sessions
  cli.ts                  → helyx CLI commands (setup, add, start, etc.)
  dashboard/src/main.tsx  → React dashboard (built to dashboard/dist/)
  dashboard/webapp/src/main.tsx → Telegram Mini App (built to dashboard/webapp/dist/)

Bot logic:
  bot/bot.ts              → grammY Bot instance, middleware, command registration
  bot/handlers.ts         → top-level handler registration (text, voice, photo, callbacks)
  bot/text-handler.ts     → handleTextMessage() → route → reply
  bot/callbacks.ts        → handlePermissionCallback() → update DB → unblock Claude
  bot/media.ts            → handleVoice(), handlePhoto(), handleDocument()
  bot/streaming.ts        → streamToTelegram() for standalone mode LLM streaming

MCP layer:
  mcp/server.ts           → HTTP MCP server (StreamableHTTPServerTransport)
  mcp/tools.ts            → registerTools(), executeTool(), all tool implementations
  mcp/bridge.ts           → permission request forwarding to Telegram
  mcp/pending-expects.ts  → tracks in-flight permission requests
  mcp/dashboard-api.ts    → REST API routes (/api/*)
  mcp/notification-broadcaster.ts → SSE client management, broadcast()

Sessions:
  sessions/manager.ts     → SessionManager class, all DB operations on sessions
  sessions/router.ts      → routeMessage(chatId) → { mode, sessionId }
  adapters/claude.ts      → ClaudeAdapter: inserts to message_queue for CLI delivery

Memory:
  memory/db.ts            → DB connection, runMigrations(), migration SQL
  memory/long-term.ts     → remember(), rememberSmart(), recall(), forget()
  memory/short-term.ts    → ShortTermMemory class, getContext(), addMessage()
  memory/embeddings.ts    → embed(), embedSafe(), embedBatch()
  memory/summarizer.ts    → summarize(), summarizeWork(), scheduleIdle()
  memory/reconcile.ts     → reconcileMemory() → LLM decision → execute

Config:
  config.ts               → all env var defaults, typed Config object
  db/schema.ts            → TypeScript schema types (not Drizzle; custom migration system)

Infrastructure:
  docker-compose.yml      → bot + postgres services, volumes, env
  .env.example            → template for all required env vars
```

---

## BREAKING_CHANGE_RISKS

```
1. PORT change (default 3847)
   Risk: HTTP MCP server URL changes → all connected Claude Code instances lose connection
   Files: config.ts, docker-compose.yml, ~/.claude/mcp config on host
   Detection: channel.ts fails set_session_name on startup

2. schema_versions migration mismatch
   Risk: running old bot code against new schema (or vice versa) → SQL errors
   Files: memory/db.ts (runMigrations)
   Rule: never roll back migrations; always add new migrations for schema changes

3. message_queue table structure change
   Risk: channel.ts polling breaks → messages pile up, never delivered
   Critical columns: session_id, content, delivered, message_id, chat_id

4. pg_advisory_lock semantics change
   Risk: two channel.ts processes manage same session → message duplication
   Files: channel.ts (lock acquisition at startup)

5. memories.embedding dimension change (currently 768)
   Risk: existing embeddings become incompatible → similarity search returns garbage
   Mitigation: new model = full re-embedding of all memories required

6. permission_requests.response polling protocol
   Risk: changing response format breaks Claude Code's wait loop
   Current format: 'allowed' | 'denied' stored in response column

7. Docker volume mounts change
   Risk: ${HOME}/.claude, ./downloads, tmux-projects.json paths hardcoded in places
   Warning: ./downloads must be pre-created by user (mkdir -p) or Docker creates as root:root

8. set_session_name tool signature change
   Risk: channel.ts calls this at startup; any param rename breaks existing channel.ts binaries

9. Telegram message chunking at 4096 chars
   Risk: exceeding limit → Telegram 400 error → reply fails → Claude Code tool call hangs
   Files: bot/text-handler.ts (chunkText utility)

10. ALLOWED_USERS empty string
    Risk: bot is open to all Telegram users (warning logged but not blocked)
    Files: bot/bot.ts (allowedUsers middleware)
```

---

## HOW_TO_UPDATE

```
Triggers for updating this spec:
  - New MCP tool added → update MCP_TOOLS_REGISTRY
  - Session status/source type added → update SESSION_INVARIANTS
  - New env var → update config.ts; add to KEY_FILE_MAP if new file
  - Schema migration → update MEMORY_CONTRACTS or add BREAKING_CHANGE_RISKS entry
  - New entry file (new process type) → update ARCHITECTURE_LAYERS
  - Function signature change on key component → update COMPONENT_CONTRACTS

Update process:
  1. Read the relevant source file(s)
  2. Update the section(s) affected
  3. Commit: "docs: update AI spec — {what changed}"
  4. Reference the PR that introduced the code change

Verification checklist:
  [ ] MCP_TOOLS_REGISTRY matches mcp/tools.ts:registerTools() + channel.ts ListToolsRequestSchema
  [ ] COMPONENT_CONTRACTS key functions match actual function names in source
  [ ] SESSION_INVARIANTS status values match sessions/manager.ts constants
  [ ] MEMORY_CONTRACTS thresholds match config.ts defaults
  [ ] KEY_FILE_MAP file paths resolve in git (not renamed/deleted)
  [ ] BREAKING_CHANGE_RISKS covers any new shared state or protocol

Cross-reference:
  - docs/spec/en/spec.md — human-readable version of this spec
  - docs/ROADMAP.md — feature status tracking
  - guides/mcp-tools.md — MCP tool reference with usage examples
```
