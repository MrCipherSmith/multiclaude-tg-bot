# AI-READABLE PRD: Claude Bot — Product Overview
# Format: Structured for AI agent consumption (task-implementer, code-architect, feature-analyzer)
# Version: v1.10.0 | Date: 2026-04-07 | Schema: prd-ai-v1

---

## IDENTITY

```yaml
product: claude-bot
repo: MrCipherSmith/multiclaude-tg-bot
version: "1.10.0"
db_schema_version: 8
runtime: bun
language: typescript
deployment: docker-compose
entry_point: main.ts
port: 3847
```

---

## CORE PURPOSE

Single Telegram bot controlling N Claude Code CLI instances via MCP protocol.
Each CLI project ↔ one named session in PostgreSQL.
Messages flow: Telegram → bot → message_queue → channel.ts → Claude CLI → reply() → Telegram.

---

## ARCHITECTURE LAYERS

```
LAYER 1: TRANSPORT
  - Telegram (grammY): polling or webhook
  - MCP HTTP server (port 3847): Claude Code connects here
  - channel.ts (stdio): per-session adapter, runs on host

LAYER 2: ROUTING
  - sessions/router.ts → mode: standalone | cli | disconnected
  - adapters/ClaudeAdapter: inserts into message_queue
  - channel.ts polls message_queue (500ms + LISTEN/NOTIFY pg_notify)

LAYER 3: SESSIONS
  - sessions/manager.ts: CRUD, activeClients map, markStale, heartbeat
  - sessions/delete.ts: cascade delete
  - projects table: permanent registry (never deleted)
  - sessions table: remote (persistent) | local (per-process) | standalone

LAYER 4: MEMORY
  - memory/short-term.ts: in-memory + messages table, 20-message window
  - memory/long-term.ts: memories table with vector(768), HNSW index
  - memory/embeddings.ts: Ollama POST /api/embed (nomic-embed-text, 768d)
  - memory/summarizer.ts: work summary on session exit

LAYER 5: AI
  - Standalone: Anthropic | Google AI | OpenRouter | Ollama (configurable)
  - Smart reconciliation: claude-haiku-4-5-20251001 for ADD/UPDATE/DELETE/NOOP
  - Voice: Groq whisper-large-v3
  - Images: Claude API (CLI mode) | Anthropic API (standalone)

LAYER 6: OBSERVABILITY
  - mcp/dashboard-api.ts: REST API for React SPA
  - dashboard/: React + Tailwind + Vite SPA
  - /health endpoint
  - request_logs, api_request_stats, transcription_stats tables
```

---

## DATABASE SCHEMA (v8)

```sql
-- Permanent project registry
projects (id, name, path TEXT UNIQUE, tmux_session_name, config JSONB, created_at)

-- Sessions: remote (1 per project) | local (N per project) | standalone (id=0)
sessions (
  id SERIAL PRIMARY KEY,
  project_id INT REFERENCES projects(id),
  source TEXT CHECK(source IN ('remote','local','standalone')),
  status TEXT CHECK(status IN ('active','inactive','terminated')),
  name TEXT, project TEXT, project_path TEXT,
  client_id TEXT UNIQUE,
  cli_type TEXT, cli_config JSONB,
  metadata JSONB,
  connected_at TIMESTAMPTZ, last_active TIMESTAMPTZ,
  UNIQUE (project_id) WHERE source = 'remote'  -- one remote per project
)

-- Long-term semantic memory
memories (
  id SERIAL PRIMARY KEY,
  source TEXT, session_id INT REFERENCES sessions(id),
  project_path TEXT, chat_id TEXT,
  type TEXT CHECK(type IN ('fact','summary','decision','note','project_context')),
  content TEXT, tags TEXT[],
  embedding vector(768),  -- cosine similarity, HNSW index
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
)

-- Incoming Telegram messages for channel.ts polling
message_queue (id, session_id INT, chat_id TEXT, from_user TEXT, content TEXT, message_id INT, created_at TIMESTAMPTZ, delivered BOOL)

-- Conversation history
messages (id, session_id INT, chat_id TEXT, role TEXT, content TEXT, created_at TIMESTAMPTZ, archived_at TIMESTAMPTZ)

-- Permission requests from Claude CLI
permission_requests (id, session_id INT, request_id TEXT, tool_name TEXT, input_preview TEXT, status TEXT, created_at TIMESTAMPTZ, archived_at TIMESTAMPTZ)

-- Per-chat active session mapping
chat_sessions (id, chat_id TEXT UNIQUE, active_session_id INT REFERENCES sessions(id))

-- Stats tables (TTL 7-30 days)
api_request_stats (id, session_id INT, provider TEXT, model TEXT, operation TEXT, input_tokens INT, output_tokens INT, duration_ms INT, error TEXT, created_at TIMESTAMPTZ)
request_logs (id, session_id INT, chat_id TEXT, level TEXT, stage TEXT, message TEXT, created_at TIMESTAMPTZ)
transcription_stats (id, session_id INT, provider TEXT, duration_ms INT, created_at TIMESTAMPTZ)
```

---

## MCP TOOLS CONTRACT

### HTTP Server (main bot process, port 3847)

```typescript
// Memory tools
remember(content: string, type: "fact"|"summary"|"decision"|"note"|"project_context", tags?: string[], source?: "telegram"|"cli"|"api"): { id: number }
recall(query: string, limit?: number, type?: string, tags?: string[]): Memory[]
forget(id: number): { ok: boolean }
list_memories(type?: string, tags?: string[], limit?: number, offset?: number): Memory[]

// Telegram tools
reply(chat_id: string, text: string, parse_mode?: "HTML"|"Markdown"): { ok: boolean, chunks: number }
react(chat_id: string, message_id: number, emoji: string): { ok: boolean }
edit_message(chat_id: string, message_id: number, text: string): { ok: boolean }

// Session tools
list_sessions(): Session[]
session_info(session_id: number): Session
set_session_name(name: string, project_path?: string): Session

// Search
search_project_context(query: string, project_path?: string, limit?: number): Memory[]
```

### Channel Adapter (stdio, channel.ts)
Same tools as HTTP server. Also exposes:
```typescript
update_status(chat_id: string, text: string): { message_id: number }
```

---

## KEY FUNCTIONS & FILES

```
main.ts
  startCleanupTimer()
    - runs hourly: TTL cleanup, markStale (skip on startup), orphan cleanup
    - startup: skipMarkStale=true (race condition protection)

sessions/manager.ts
  register(clientId, name?, projectPath?) → Session
  adoptOrRename(clientId, name, projectPath?) → Session  // set_session_name flow
  disconnect(clientId) → void  // ephemeral: DELETE | named: status=terminated/inactive
  markStale(maxAgeSeconds=600) → count  // checks activeClients map
  touchActivity(sessionId) → void  // called on every MCP tool call
  cleanup() → count  // deletes disconnected/terminated local sessions

channel.ts
  resolveSession() → sets sessionId (register or adoptOrRename)
  pollMessages() → LISTEN/NOTIFY + 500ms fallback loop
  heartbeat → setInterval 5min → UPDATE sessions SET last_active=now()
  shutdown → clearInterval(heartbeat), markDisconnected, sql.end()

memory/long-term.ts
  remember(memory) → Memory  // plain insert with embedSafe()
  rememberSmart(memory) → ReconcileResult  // LLM dedup
    1. embedSafe(content)
    2. SELECT similar WHERE distance ≤ MEMORY_SIMILARITY_THRESHOLD (0.35)
    3. if similar exists: reconcileWithExisting() → claude-haiku-4-5-20251001
    4. execute: ADD | UPDATE id | DELETE id + ADD | NOOP
    5. fallback: remember() on any error
  recall(query, options) → Memory[]  // cosine similarity ORDER BY embedding <=> query
  isIndexing() → boolean  // _indexingCount > 0

memory/summarizer.ts
  summarizeWork(sessionId) → void
    - SELECT last N messages WHERE session_id = X AND archived_at IS NULL
    - LLM call → structured [DECISIONS][FILES][PROBLEMS][PENDING][CONTEXT]
    - rememberSmart({type: 'project_context', projectPath, ...})
    - UPDATE messages SET archived_at=now() WHERE session_id = X

mcp/dashboard-api.ts
  GET /api/overview → {uptime, db, transport, sessions, tokens24h, recentSessions}
  GET /api/sessions → Session[]
  GET /api/sessions/:id → SessionDetail
  GET /api/sessions/:id/messages → {messages, total}
  DELETE /api/sessions/:id → void
  PATCH /api/sessions/:id → Session (rename)
  GET /api/memories → {memories, total, hotContext, indexing}
    hotContext = SELECT TOP 10 ORDER BY created_at DESC (no filters)
    indexing = isIndexing()
  GET /api/memories/tags → {tag, count}[]
  DELETE /api/memories/:id → void
  DELETE /api/memories/tag/:tag → {deleted: number}
  GET /api/stats → full stats
  GET /api/stats/daily → DailyStats[]
  GET /api/logs → {logs, total}
  GET /health → {status, db, uptime, sessions}
```

---

## CONFIGURATION (config.ts)

```typescript
{
  // Required
  TELEGRAM_BOT_TOKEN: string
  ALLOWED_USERS: string[]  // comma-separated user IDs
  DATABASE_URL: string
  OLLAMA_URL: string  // default: "http://localhost:11434"

  // Optional — LLM providers
  ANTHROPIC_API_KEY?: string
  CLAUDE_MODEL: string  // default: "claude-sonnet-4-20250514"
  GOOGLE_AI_API_KEY?: string
  GOOGLE_AI_MODEL: string  // default: "gemma-4-31b-it"
  OPENROUTER_API_KEY?: string
  OPENROUTER_MODEL: string  // default: "qwen/qwen3-235b-a22b:free"
  OLLAMA_CHAT_MODEL: string  // default: "qwen3:8b"
  GROQ_API_KEY?: string

  // Embedding
  EMBEDDING_MODEL: string  // default: "nomic-embed-text"
  VECTOR_DIMENSIONS: number  // default: 768

  // Memory reconciliation
  MEMORY_SIMILARITY_THRESHOLD: number  // default: 0.35 (cosine distance)
  MEMORY_RECONCILE_TOP_K: number  // default: 5

  // Session
  SHORT_TERM_WINDOW: number  // default: 20 messages
  IDLE_TIMEOUT_MS: number  // default: 900000 (15 min)
  ARCHIVE_TTL_DAYS: number  // default: 30

  // Transport
  TELEGRAM_TRANSPORT: "polling" | "webhook"
  TELEGRAM_WEBHOOK_URL?: string

  // Server
  PORT: number  // default: 3847
  JWT_SECRET: string  // default: derived from bot token
  SECURE_COOKIES: boolean  // default: auto-detect
}
```

---

## ACCEPTANCE CRITERIA (Gherkin — AI-optimized)

```gherkin
Feature: MCP session routing

  Scenario: Message delivery via message_queue
    Given sessions.status = 'active' AND sessions.source = 'local' for session_id = X
    And channel.ts holds advisory lock for session_id = X
    When INSERT INTO message_queue (session_id=X, content="task") occurs
    Then pg_notify fires on channel 'message_queue_X'
    And channel.ts wakeResolve() triggers immediate poll
    And UPDATE message_queue SET delivered=true WHERE session_id=X AND delivered=false
    And mcp.notification({method: "notifications/claude/channel"}) called with content

  Scenario: Session stale protection on bot restart
    Given sessions.status = 'active' AND sessions.last_active < now() - interval '10 min'
    And bot process just started (activeClients map is empty)
    When startCleanupTimer() fires with skipMarkStale=true
    Then markStale() is NOT called
    And session remains status = 'active'

  Scenario: Smart reconciliation — UPDATE path
    Given memories table has {id=5, type='fact', project_path='/proj', content='PostgreSQL 15', embedding=E1}
    And cosine_distance(E1, embed('PostgreSQL 16')) < 0.35
    When rememberSmart({type:'fact', projectPath:'/proj', content:'PostgreSQL 16'}) called
    Then reconcileWithExisting() called with similar=[{id:5, content:'PostgreSQL 15'}]
    And claude-haiku returns "UPDATE id=5 content=\"PostgreSQL 16\""
    And UPDATE memories SET content='PostgreSQL 16', embedding=embed('PostgreSQL 16'), updated_at=now() WHERE id=5
    And returns {action:'updated', id:5, content:'PostgreSQL 16'}

  Scenario: Smart reconciliation — fallback on Ollama error
    Given Ollama /api/embed returns connection error
    When rememberSmart({content:'new fact'}) called
    Then embedSafe() returns null
    And remember(memory) called directly (no LLM reconciliation)
    And INSERT INTO memories WITHOUT embedding vector
    And returns {action:'added', id:N, content:'new fact'}

  Scenario: Work summary on graceful shutdown
    Given channel.ts receives SIGTERM
    And sessionId = 7 with 15 unarchived messages
    When shutdown() called
    Then clearInterval(heartbeatTimer)
    Then POST /api/sessions/7/summarize-work called
    Then SELECT messages WHERE session_id=7 AND archived_at IS NULL
    Then LLM generates summary with [DECISIONS][FILES][PROBLEMS][PENDING][CONTEXT]
    Then rememberSmart({type:'project_context', projectPath, content:summary}) called
    Then UPDATE messages SET archived_at=now() WHERE session_id=7 AND archived_at IS NULL
    Then sql.end() called
    Then process.exit(0)

  Scenario: Dashboard memory indexing indicator
    Given isIndexing() returns true (embedSafe() in progress)
    When GET /api/memories called
    Then response includes {indexing: true, hotContext: Memory[10]}
    And Memories.tsx renders pulsing "Indexing..." badge

  Scenario: Tag-based memory deletion
    Given memories table has 3 rows with tags containing 'stale-project'
    When DELETE /api/memories/tag/stale-project called
    Then DELETE FROM memories WHERE 'stale-project' = ANY(tags)
    And returns {deleted: 3}

  Scenario: Session heartbeat prevents stale marking
    Given channel.ts started and sessionId = 12
    And 5 minutes have passed with no MCP tool calls
    When heartbeatTimer fires
    Then UPDATE sessions SET last_active=now() WHERE id=12
    And markStale(600) will NOT mark session as stale because last_active is fresh
```

---

## ROADMAP — OPEN ITEMS

```yaml
planned:
  - id: DASH-001
    title: "Dashboard project management UI"
    description: "Create/start/stop projects from web dashboard (currently Telegram-only)"
    files_likely_affected:
      - dashboard/src/pages/Projects.tsx (new)
      - mcp/dashboard-api.ts (new /api/projects endpoints)
      - sessions/manager.ts (new startProject / stopProject methods)
    blocked_by: []

  - id: MULTI-001
    title: "Multi-user support"
    description: "Isolated sessions and memory namespaces per Telegram user"
    files_likely_affected:
      - sessions/manager.ts (add user_id FK)
      - memory/long-term.ts (scope queries by user_id)
      - bot/access.ts (user registry)
      - memory/db.ts (migration v9: user_id columns)
    blocked_by: []

  - id: TG-001
    title: "Inline mode"
    description: "Respond in any Telegram chat via @bot query"
    files_likely_affected:
      - bot/bot.ts (inline_query handler)
      - bot/handlers.ts
    blocked_by: [MULTI-001]

  - id: INFRA-001
    title: "Webhook horizontal scaling"
    description: "Support multiple bot instances via webhook + load balancer"
    notes: "Currently polling works with single instance. Advisory locks protect message_queue."
    blocked_by: []

  - id: MEM-001
    title: "Per-type memory TTL"
    description: "Different retention: fact=90d, summary=30d, project_context=180d"
    files_likely_affected:
      - config.ts (new MEMORY_TTL_* vars)
      - main.ts (cleanup timer per-type DELETE)
    blocked_by: []

  - id: DASH-002
    title: "Dashboard browser push notifications"
    description: "WebSocket or SSE for session state changes in browser"
    files_likely_affected:
      - mcp/dashboard-api.ts (SSE endpoint /api/events)
      - dashboard/src/ (useEventSource hook)
    blocked_by: []
```

---

## KNOWN CONSTRAINTS FOR IMPLEMENTERS

```yaml
constraints:
  - advisory_locks:
      scope: "session adoption in channel.ts"
      key: "session_id (bigint)"
      retry: "5 attempts, 1s delay"
      release: "on shutdown only"

  - message_format:
      telegram_limit: 4096 chars per message
      chunking: "utils/chunk.ts splits by paragraph/code-block boundary"
      parse_mode: "HTML (not MarkdownV2 — grammY renders via markdownToTelegramHtml)"

  - embedding_nullability:
      rule: "embedding column is nullable. Memories without vectors are saved but not searchable via cosine similarity."
      check: "WHERE embedding IS NOT NULL before vector ops"

  - reconcile_scope:
      rule: "rememberSmart() scopes similarity search by (type + project_path) OR (type + chat_id). Cross-project dedup does NOT happen."

  - session_id_zero:
      rule: "id=0 is the special standalone session (no CLI). Never delete. Never include in cleanup."
      check: "WHERE id != 0 in all cleanup queries"

  - activeClients_map:
      rule: "In-memory only. Lost on bot restart. markStale() checks this map — skip on startup."
      file: "sessions/manager.ts:30"

  - dashboard_auth:
      method: "Telegram Login Widget → JWT (derived from bot token)"
      cookie: "secure HttpOnly, CSRF check via Origin header"
```
