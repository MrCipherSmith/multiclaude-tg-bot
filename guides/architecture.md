# Internal Architecture

This guide covers the implementation-level architecture of Helyx — how modules are organized, how data flows, and the design decisions behind key subsystems.

For the user-facing feature overview, see [README](../README.md). For usage workflows, see [Usage Scenarios](usage-scenarios.md).

---

## Module Map

```
helyx/
├── main.ts                  # Entrypoint — starts bot + HTTP server + timers
├── config.ts                # Zod-validated env vars (all process.env reads go here)
├── logger.ts                # Pino loggers: logger (stdout) + channelLogger (stderr)
│
├── bot/                     # Telegram bot layer
│   ├── bot.ts               # grammY setup, command registration
│   ├── handlers.ts          # Message routing, pending input queue
│   ├── text-handler.ts      # Main message handler (CLI/standalone routing)
│   ├── callbacks.ts         # Inline keyboard callbacks (permissions, sessions, projects)
│   ├── media.ts             # Photo, document, voice, video handlers
│   ├── streaming.ts         # LLM streaming → Telegram message edits
│   ├── access.ts            # ALLOWED_USERS guard (required at startup)
│   └── commands/            # One file per /command
│       ├── session.ts       # /sessions, /switch, /rename, /remove, /cleanup
│       ├── projects.ts      # /projects + proj: callbacks
│       ├── project-add.ts   # /project_add
│       ├── memory.ts        # /remember, /recall, /memories, /forget
│       ├── admin.ts         # /status, /stats, /logs, /tools, /skills, /rules
│       ├── model.ts         # /model + set_model: callbacks
│       ├── remote-control.ts # /remote_control + rc: callbacks
│       └── memory-export.ts # /memory_export, /memory_import
│
├── channel/                 # stdio MCP channel adapter (one instance per Claude CLI)
│   ├── index.ts             # Entrypoint — parse args, init all modules, read stdin
│   ├── session.ts           # Session registration (local/remote), stale detection
│   ├── permissions.ts       # Permission request forwarding to Telegram
│   ├── tools.ts             # MCP tool registry and CallTool dispatch
│   ├── status.ts            # Live status message lifecycle
│   ├── poller.ts            # message_queue polling loop
│   └── telegram.ts          # HTML formatting helpers
│
├── services/                # Domain service layer (typed wrappers over SQL)
│   ├── session-service.ts   # SessionService — CRUD + rename
│   ├── project-service.ts   # ProjectService — create (atomic), start, stop
│   ├── permission-service.ts # PermissionService — state machine transitions
│   └── memory-service.ts    # MemoryService — reconcile, save, recall, forget
│
├── sessions/                # Session lifecycle and routing
│   ├── manager.ts           # SessionManager — in-memory registry, DB sync
│   ├── router.ts            # routeMessage() → { mode: "cli"|"standalone"|"disconnected" }
│   └── delete.ts            # deleteSessionCascade() — removes all related rows
│
├── memory/                  # Memory and knowledge subsystems
│   ├── db.ts                # postgres.js connection pool + migration runner
│   ├── short-term.ts        # Sliding window cache (last 20 messages per session)
│   ├── long-term.ts         # pgvector semantic search (recall, save, forget)
│   ├── summarizer.ts        # Idle-timeout summarization → long-term memory
│   ├── reconciler.ts        # Smart deduplication — LLM decides ADD/UPDATE/DELETE/NOOP
│   ├── project-scanner.ts   # Project knowledge scan (README, entry points → facts)
│   └── cleanup.ts           # Hourly cleanup jobs; CLEANUP_DRY_RUN=true for inspection
│
├── mcp/
│   ├── server.ts            # HTTP MCP server (Express + MCP SDK)
│   ├── tools.ts             # Tool registry — remember, recall, reply, update_status, …
│   └── dashboard-api.ts     # REST API for web dashboard + Telegram Mini App
│
├── claude/                  # LLM client abstraction
│   ├── client.ts            # Multi-provider client (Anthropic/Google/OpenRouter/Ollama)
│   └── prompt.ts            # Prompt composition (short-term + long-term context)
│
├── adapters/                # Message delivery adapters
│   ├── index.ts             # Adapter registry
│   └── claude-adapter.ts    # ClaudeAdapter — inserts into message_queue
│
├── utils/
│   ├── files.ts             # File download + host path mapping (CONFIG.DOWNLOADS_DIR)
│   ├── transcribe.ts        # Voice transcription (Groq / local Whisper)
│   ├── stats.ts             # Append-only request log helper
│   └── tools-reader.ts      # Read skills/commands from ~/.claude
│
├── tests/
│   ├── unit/                # Pure unit tests (no DB, no network)
│   │   ├── session-lifecycle.test.ts
│   │   ├── permission-flow.test.ts
│   │   └── memory-reconciliation.test.ts
│   └── e2e/                 # Playwright integration tests
│
└── dashboard/
    └── webapp/              # React + Tailwind + Vite (Telegram Mini App + web dashboard)
```

---

## Service Layer

`services/` provides the contract between bot commands and the database. Each service owns one domain; commands call services instead of writing SQL directly.

### SessionService

```typescript
sessionService.rename(id, name)   // UPDATE sessions SET name = ...
sessionService.get(id)            // SELECT * FROM sessions WHERE id = ?
```

### ProjectService

`create(name, path)` is the key atomic operation:

```typescript
// 1. INSERT INTO projects (name, path)
// 2. INSERT INTO sessions (project_id, source='remote', status='inactive')
// Returns null if path already exists (unique constraint)
projectService.create(name, path)

projectService.start(id)    // creates tmux window + marks session active
projectService.stop(id)     // kills tmux window + marks session inactive
```

### PermissionService

State machine:

```
pending ──→ approved  (terminal)
        ──→ rejected  (terminal)
        ──→ expired   (terminal)
```

`transition(requestId, newStatus)` reads current status first. If status is not `pending`, it throws — the caller (callbacks.ts) catches this and replies "Already handled". This prevents double-approvals from Telegram's at-least-once callback delivery.

### MemoryService

Wraps `reconciler.ts` — the LLM-based deduplication layer. Calling `remember()` triggers a vector search for similar memories, then asks Claude Haiku to decide:

- `ADD` — new fact, insert
- `NOOP id=N` — duplicate, skip
- `UPDATE id=N content="..."` — supersedes existing memory
- `DELETE id=N` — existing memory is wrong/stale, remove

---

## Channel Adapter

Each Claude CLI process spawns `channel/index.ts` as an MCP stdio server. Multiple instances run simultaneously (one per project).

**Startup sequence:**
1. `index.ts` parses env vars (`TELEGRAM_BOT_TOKEN`, `DATABASE_URL`, `CHANNEL_SOURCE`)
2. `session.ts` registers or reuses a session in the DB
3. `poller.ts` starts polling `message_queue` every 500ms
4. `tools.ts` registers MCP tools: `reply`, `update_status`, `remember`, etc.
5. `permissions.ts` watches for new permission requests and forwards them to Telegram
6. Reads JSON-RPC from stdin until EOF (Claude CLI closes pipe on exit)
7. On exit: `session.ts` runs work summary (for `local` source), marks session inactive

**Source modes** (set via `CHANNEL_SOURCE` env):

| `CHANNEL_SOURCE` | Session type | On exit |
|---|---|---|
| `remote` | Persistent (`source=remote`) | Marked inactive, preserved |
| `local` | Temporary (`source=local`) | Work summary generated, archived |
| _(unset)_ | No DB registration | No polling, no session |

---

## Config & Validation

All env reads go through `config.ts`:

```typescript
import { CONFIG } from "./config.ts";
const url = CONFIG.OLLAMA_URL;  // validated string, never undefined
```

`config.ts` uses Zod:
```typescript
const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_USERS: z.string().optional(),
  ALLOW_ALL_USERS: z.coerce.boolean().default(false),
  DATABASE_URL: z.string(),
  // ...
});
export const CONFIG = schema.parse(process.env);
```

If `ALLOWED_USERS` is not set and `ALLOW_ALL_USERS` is not `true`, `access.ts` blocks all messages at startup. This is a deliberate security default — new deployments must explicitly configure access.

---

## Structured Logging

Two loggers are exported from `logger.ts`:

```typescript
export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
// Writes to stdout — used by main bot process

export const channelLogger = pino(
  { level: process.env.LOG_LEVEL ?? "info" },
  pino.destination(2)  // fd 2 = stderr
);
// Used by channel/ modules — stderr keeps MCP stdio (stdout) clean
```

Log with structured fields, never string interpolation:

```typescript
// Good
logger.info({ sessionId, chatId, messageCount: messages.length }, "summarizing");

// Bad
console.log(`Summarizing session ${sessionId} with ${messages.length} messages`);
```

---

## Permission Forwarding Flow

```
Claude CLI runs tool (Bash/Edit/…)
  ↓
MCP permission_request intercepted
  ↓
channel/permissions.ts → INSERT INTO permission_requests (status='pending')
  ↓
Telegram inline keyboard: [Allow] [Always] [Deny]
  ↓
User taps button → bot/callbacks.ts
  ↓
PermissionService.transition(id, 'approved'|'rejected')
  ↓
channel/permissions.ts polls → reads status → sends JSON-RPC response to Claude
  ↓
Claude CLI continues (if approved) or aborts tool (if rejected)
```

"Always" also writes `ToolName(*)` pattern to `settings.local.json` so future requests are auto-approved without Telegram.

---

## Memory Architecture

```
User message or session exit
  ↓
reconciler.ts:
  1. Generate embedding (Ollama nomic-embed-text, 768 dims)
  2. Vector search for k=5 similar existing memories
  3. If similarity > threshold (0.35): ask Claude Haiku → ADD/NOOP/UPDATE/DELETE
  4. Apply decision
  ↓
memories table (pgvector):
  - content, type (fact/note/decision/summary/project_context)
  - embedding (vector 768)
  - project_path (project-scoped)
  - expires_at (per-type TTL)
```

TTL defaults by type:

| Type | Default TTL |
|---|---|
| `fact` | 90 days |
| `note` | 30 days |
| `decision` | 180 days |
| `summary` | 60 days |
| `project_context` | 180 days |

---

## Unit Tests

Pure function tests — no DB, no network, no Telegram:

```bash
bun test tests/unit/    # ~24ms, 43 tests
```

What's tested:
- **session-lifecycle**: state transitions (active→inactive→terminated), `sessionDisplayName`, disconnect behavior per source type
- **permission-flow**: valid/invalid transitions, terminal state blocking, auto-approve pattern matching
- **memory-reconciliation**: `parseReconcileDecision()` — ADD, NOOP, UPDATE, DELETE parsing and edge cases

The tested functions are extracted as pure utilities; the tests import them directly without mocking the database.

---

## Dashboard API

`mcp/dashboard-api.ts` exposes a REST API on the same port as the MCP server (`3847`):

```
GET  /api/overview              Sessions summary + stats
GET  /api/sessions              List sessions
GET  /api/sessions/active       User's active session (by JWT Telegram ID)
GET  /api/sessions/:id/timeline Messages + memories merged chronologically
GET  /api/projects              List projects
POST /api/projects              Create project
POST /api/projects/:id/start    Start project (creates tmux session)
POST /api/projects/:id/stop     Stop project
GET  /api/permissions/stats     Allow/deny breakdown by tool
GET  /api/events                SSE stream for live session state updates
```

Auth: Telegram WebApp `initData` HMAC validation for Mini App; JWT cookie for dashboard.
