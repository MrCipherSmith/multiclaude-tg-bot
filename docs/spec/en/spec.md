# Helyx — Full Specification

**Specification Version:** 1.14.0  
**Last Updated:** April 9, 2026

---

## 1. Project Overview

**Helyx** is a Telegram bot that enables remote control of multiple Claude Code CLI instances. It bridges the gap between mobile/laptop interfaces and terminal-based AI agents by:

- **Accepting user messages via Telegram** (text, voice, images) and routing them to active Claude Code processes
- **Collecting and preserving context** across sessions using dual-layer memory (short-term sliding window + long-term pgvector embeddings)
- **Forwarding permission requests** for file edits and Bash commands back to Telegram for approval
- **Providing real-time monitoring** via a web dashboard and live CLI progress tracking
- **Supporting standalone mode** where the bot itself responds via LLM when no CLI session is active

**Core Value Proposition:** Developers can manage AI agents remotely from their phone while preserving full project context and automation capabilities.

**Target Users:** Developers running Claude Code on remote machines (servers, headless laptops) or in persistent tmux sessions.

**Key Technology Stack:**
- Runtime: **Bun** (TypeScript)
- Telegram: **grammY** framework
- MCP Protocol: **@modelcontextprotocol/sdk** (HTTP server + stdio adapter)
- Database: **PostgreSQL 16** with **pgvector** extension
- Embeddings: **Ollama** (nomic-embed-text, 768-dim vectors)
- LLM Providers: **Anthropic Claude**, **Google AI**, **OpenRouter**, **Ollama**
- Voice: **Groq** whisper-large-v3 (~200ms latency)
- Frontend: **React** + **Tailwind** dashboard + **Telegram Mini App** (WebApp)
- Infrastructure: **Docker Compose**

---

## 2. Architecture

### 2.1 System Layers

```
                          ┌──────────────────────────────────────┐
                          │      Host (Laptop/Server)             │
                          │                                        │
  ┌──────────────┐ stdio  │  ┌──────────────┐  ┌──────────────┐  │
  │ channel.ts   │◀──────▶│  │ Claude Code  │  │ Claude Code  │  │
  │ (stdio MCP   │  MCP   │  │   project-a  │  │   project-b  │  │
  │  adapter)    │        │  └──────────────┘  └──────────────┘  │
  └────────┬─────┘        │       ▲                    ▲           │
           │              │       ▼                    ▼           │
           │ polls        │  ┌──────────────────────────────┐     │
           └─────────────▶│  │   Project Files (git repos)  │     │
                          │  └──────────────────────────────┘     │
                          └──────────────────────────────────────┘
                                       ▲
                                       │ (HTTP MCP, local/Docker)
                                       │
                          ┌────────────▼──────────────────────────┐
                          │           Docker                       │
                          │                                        │
                          │  ┌─────────────────────────────────┐  │
                          │  │  Bot Server (main.ts) :3847     │  │
                          │  │                                 │  │
                          │  │  • Telegram Polling/Webhook     │  │
                          │  │  • HTTP MCP server              │  │
                          │  │  • Session management           │  │
                          │  │  • Memory reconciliation        │  │
                          │  │  • Dashboard API + static files │  │
                          │  └─────────────────────────────────┘  │
                          │                                        │
                          │  ┌─────────────────────────────────┐  │
                          │  │  PostgreSQL :5432               │  │
                          │  │  (pgvector extension)           │  │
                          │  │                                 │  │
                          │  │  • sessions                     │  │
                          │  │  • message_queue (polling)      │  │
                          │  │  • memories (embeddings)        │  │
                          │  │  • permission_requests          │  │
                          │  │  • api_request_stats            │  │
                          │  │  • transcription_stats          │  │
                          │  │  • request_logs                 │  │
                          │  └─────────────────────────────────┘  │
                          └────────────────────────────────────────┘
                                       ▲
                                       │ (vector embedding)
                          ┌────────────▼──────────────────┐
                          │  Ollama (host) :11434         │
                          │  nomic-embed-text (768 dims)  │
                          └───────────────────────────────┘
```

### 2.2 Core Components

| Component | File(s) | Purpose |
|-----------|---------|---------|
| **Main Server** | `main.ts` | Entry point; DB migrations, cleanup timer, graceful shutdown |
| **Telegram Bot** | `bot/bot.ts`, `bot/handlers.ts` | grammY setup, command registration, message routing |
| **HTTP MCP Server** | `mcp/server.ts`, `mcp/tools.ts` | MCP transport, tool definitions, tool execution logic |
| **Channel Adapter** | `channel.ts` | stdio MCP bridge; registers/adopts sessions; polls message_queue; forwards notifications |
| **Session Manager** | `sessions/manager.ts` | Session CRUD, state tracking (active/inactive/terminated/disconnected), auto-linking |
| **Session Router** | `sessions/router.ts` | Routes messages to CLI, standalone, or disconnected state |
| **CLI Adapter** | `adapters/claude.ts` | Inserts messages into message_queue for channel.ts to pick up |
| **Message Handler** | `bot/text-handler.ts` | Main text message → routing → Claude/standalone response → Telegram |
| **Media Handler** | `bot/media.ts` | Voice transcription, image analysis, document download |
| **Short-Term Memory** | `memory/short-term.ts` | In-memory sliding window (configurable, default 20 messages) |
| **Long-Term Memory** | `memory/long-term.ts` | pgvector embeddings, semantic search, smart reconciliation |
| **Summarizer** | `memory/summarizer.ts` | Auto-summarization on idle/overflow/exit; work session summaries |
| **Embeddings** | `memory/embeddings.ts` | Ollama integration with graceful fallback |
| **Database** | `memory/db.ts` | PostgreSQL connection, migration framework, schema |
| **Config** | `config.ts` | Environment variables, defaults |
| **Web Dashboard** | `dashboard/` | React SPA; Overview, Sessions, Stats, Logs, Memory pages |
| **Telegram Mini App** | `dashboard/webapp/` | Mobile WebApp (file browser, permission manager, session monitor) |
| **CLI Tool** | `cli.ts` | Setup wizard, project registration, tmux management |

### 2.3 Key Boundaries

1. **Transport Boundary**: Messages flow via either **stdio (channel.ts)** or **HTTP MCP** — never directly to Claude Code stdin
2. **Session Boundary**: Each session has a unique ID; messages/permissions/memories are scoped to session
3. **Project Boundary**: Memories and context can be shared across sessions in the same project via `project_path`
4. **Telegram Boundary**: Only `ALLOWED_USERS` can interact; messages chunked at 4096 chars; HTML formatting applied
5. **LLM Boundary**: Anthropic API, Google AI, OpenRouter, or local Ollama; configurable per provider

---

## 3. Core Features

### 3.1 Multi-Session MCP Server (HTTP)

Exposes an HTTP MCP server on port 3847 (configurable). Multiple Claude Code CLI instances connect as MCP clients. Each connection is a separate MCP session with a unique UUID.

**How it works:**
1. `mcp/server.ts` creates an HTTP server using `StreamableHTTPServerTransport`
2. On first connection, a unique `transportSessionId` is generated
3. Each transport is registered in memory (`transports` map)
4. Tools are registered via `registerTools()` which binds tool execution to `executeTool()`
5. Tool calls are executed in `mcp/tools.ts` with the client ID injected

**Key files:** `mcp/server.ts`, `mcp/tools.ts`, `mcp/bridge.ts`

---

### 3.2 Channel Adapter (stdio MCP Bridge)

A standalone TypeScript process (`channel.ts`) acts as a stdio MCP bridge. Launched by Claude Code with `--channels "bun channel.ts"`. Registers or adopts an existing session in the database, then polls `message_queue` for new messages and forwards them to Claude Code via MCP notifications.

**How it works:**
1. Connects to PostgreSQL and to the HTTP MCP server (localhost:3847)
2. Calls `set_session_name(project_path)` to register or adopt a session
3. Enters a polling loop (500ms): checks for new messages in the queue
4. For each message: sends via MCP notification `notifications/claude/channel`, marks as `delivered = true`
5. On shutdown: calls `/api/sessions/:id/summarize-work` to save work summary
6. Uses `pg_advisory_lock` to prevent two channel.ts processes from managing the same session

**Key files:** `channel.ts`, `mcp/pending-expects.ts`

---

### 3.3 Standalone Mode

When no active CLI session is selected, the bot responds directly via LLM. Supports 4 providers: Anthropic, Google AI, OpenRouter, Ollama. Streams responses with periodic message edits. Auto-summarizes after 15 min of inactivity.

**How it works:**
1. `routeMessage()` in `sessions/router.ts` returns `{ mode: "standalone", sessionId: 0 }`
2. `bot/text-handler.ts` routes to standalone flow
3. Composes prompt with short-term context + long-term memory recall
4. Calls `streamToTelegram()` which streams LLM response with periodic edits

**Key files:** `sessions/router.ts`, `bot/text-handler.ts`, `bot/streaming.ts`, `claude/client.ts`

---

### 3.4 Voice & Photo Media

- **Voice**: Downloads OGG from Telegram → Groq whisper-large-v3 (~200ms) → text. Falls back to local Whisper container if Groq fails. Result prefixed with 🎤 and processed as normal text.
- **Photos**: Downloads JPEG → base64 encode → Claude for analysis (standalone+Anthropic). In CLI mode: images ≤5 MB included as base64 in `message_queue.attachments`; larger images forwarded as host file path.
- **Documents**: Downloaded to `downloads/`, host path included in queue content and `attachments` for Claude to read via `Read` tool.
- **Video / VideoNote / Audio**: Downloaded, host path stored in `attachments`.
- **Files shared**: `downloads/` directory mounted from host via Docker volume (`./downloads:/app/downloads`). `toHostPath()` maps container paths to host paths so Claude Code can access them directly.
- **Attachment forwarding**: `message_queue.attachments` (JSONB, migration v11) carries structured file metadata `{type, base64?, path, mime, name, caption}` to channel.ts, which includes it in `notifications/claude/channel` `meta.attachments`.

**Key files:** `bot/media.ts`, `utils/files.ts`, `utils/transcribe.ts`

---

### 3.5 Session Lifecycle

**Session Types:**

| Type | Source | Persistence | Status Values | Created By |
|------|--------|-------------|---------------|------------|
| **Remote** | `remote` | Persistent | `active` / `inactive` | `/project_add` command |
| **Local** | `local` | Temporary (30-day TTL) | `active` / `terminated` / `disconnected` | Claude Code via `set_session_name` |
| **Standalone** | `standalone` | N/A (session ID = 0) | Always `active` | Pre-inserted at migration |

**Remote Session Lifecycle:**
```
/project_add → INSERT (source='remote', status='inactive')
     ↓
Claude Code launched → set_session_name → ADOPT existing session
     ↓
status='active' (connected)
     ↓
Claude Code exits → channel.ts exits → status='inactive'
     ↓
Data persists; can restart at any time
```

**Local Session Lifecycle:**
```
Claude Code (no pre-registered project) → set_session_name
     ↓
register() → INSERT (source='local', status='active')
     ↓
messages accumulate, idle timer runs
     ↓
Claude Code exits → channel.ts calls /api/sessions/:id/summarize-work
     ↓
status='terminated', messages archived, work summary saved
     ↓
Auto-cleanup after 30-day TTL
```

**Key files:** `sessions/manager.ts`, `channel.ts`, `memory/summarizer.ts`

---

### 3.6 Memory System

**Short-Term Memory:**
- Sliding window of recent messages (default 20) in PostgreSQL `messages` table
- In-memory cache (`memory/short-term.ts`) for fast access
- Archived after summarization; deleted after 30-day TTL

**Long-Term Memory:**
- pgvector embeddings (768-dim, nomic-embed-text via Ollama)
- Types: `fact`, `summary`, `decision`, `note`, `project_context` (system)
- Scoped by `project_path` (shared across project sessions) or `session_id` (legacy)
- HNSW index for fast approximate nearest-neighbor queries

**Smart Reconciliation:**
When saving a memory via `rememberSmart()`:
1. **Embed** the new content via Ollama
2. **Search** for similar memories (same type + project scope, cosine similarity)
3. If closest distance ≤ 0.35, send top-K similar + new content to **Claude Haiku** for decision
4. **Execute decision**: `ADD` / `UPDATE id=X` / `DELETE id=X` / `NOOP`
5. **Fallback**: If Ollama or Claude unavailable → plain `remember()`, no data loss

**Auto-Summarization triggers:**
- Idle timeout: 15 min of no messages
- Overflow: messages exceed 2 × SHORT_TERM_WINDOW
- Manual: `/summarize` command
- On exit: channel.ts triggers work summary

**Work Summary Structure:**
```
[DECISIONS]
decision_label: rationale

[FILES]
relative/path: change | reason

[PROBLEMS]
problem: solution

[PENDING]
task or known issue

[CONTEXT]
non-obvious constraint or fact
```

**Memory TTL:**
- `fact`: 90 days | `summary`: 60 days | `decision`: 180 days | `note`: 30 days | `project_context`: 180 days
- All configurable via `MEMORY_TTL_*_DAYS` environment variables

**Key files:** `memory/short-term.ts`, `memory/long-term.ts`, `memory/embeddings.ts`, `memory/summarizer.ts`

---

### 3.7 Permission Forwarding

Claude Code requests permission before executing Bash, Edit, Write, etc. The bot shows inline buttons: **Allow**, **Always**, **Deny**, with syntax-highlighted diff.

**Flow:**
1. Claude Code calls MCP tool: `request_permission(tool_name, description, input_preview)`
2. Bot saves to `permission_requests` table with `response = null`
3. Sends Telegram message with inline buttons
4. User taps → Bot updates `permission_requests.response`
5. Claude Code polls/receives notification and continues

**Auto-Approve:** Configure patterns in `~/.claude/settings.local.json`:
```json
{
  "permissions": {
    "allow": ["Edit(*)", "Bash(git *)", "Bash(npm test)"]
  }
}
```

**Key files:** `bot/callbacks.ts`, `mcp/bridge.ts`

---

### 3.8 Web Dashboard

React SPA served on port 3847. Pages:

- **Overview**: Uptime, DB status, active sessions, 24h token usage chart, Ollama status
- **Sessions**: List with status badges, rename/delete, last activity, message count
- **Stats**: Token usage by provider/model, 30-day charts, cost estimation, error drill-down
- **Logs**: Per-session request logs, search by chat ID/stage/text
- **Memory**: Recent memories, tag cloud, indexing indicator, create/delete memories
- **Projects**: Registered projects, Start/Stop, Rename, Delete, view sessions

**Key files:** `dashboard/src/`, `mcp/dashboard-api.ts`

---

### 3.9 Telegram Mini App (WebApp)

Mobile-optimized WebApp launched from Telegram via "Dev Hub" button. Auto-themed to Telegram's light/dark mode.

Features:
- **File Browser**: Browse project directory tree, git status, git log, file diffs, syntax highlighting
- **Permission Manager**: List pending requests, quick Allow/Deny, preview diff
- **Session Monitor**: List active sessions, quick switch, view last messages

**Key files:** `dashboard/webapp/src/`

---

### 3.10 CLI Tool (`helyx` command)

| Command | Description |
|---------|-------------|
| `setup` | Interactive wizard (deployment, API keys, .env, migrations) |
| `docker-start` | `docker compose up -d` |
| `docker-stop` | `docker compose down` |
| `status` | Bot health (DB, Ollama, uptime, session count) |
| `logs` | Follow bot logs |
| `sessions` | List sessions from DB |
| `backup` | `pg_dump` backup |
| `cleanup` | Manual trigger of cleanup routine |
| `connect <path>` | Launch Claude with `--channels "bun channel.ts"` |
| `start <path>` | Alias for connect |
| `up [-a] [-s]` | Start all projects in tmux |
| `down` | Stop all tmux sessions |
| `ps` | List configured projects |
| `add <path>` | Register project (updates config + bot DB) |
| `remove <name>` | Unregister project |
| `mcp-register` | Add bot to Claude Code's MCP config |

**Setup Wizard Flow:**
1. Deployment type: Docker or Manual
2. Telegram bot token (from @BotFather)
3. Telegram user ID (from @userinfobot)
4. LLM provider (Anthropic, Google AI, OpenRouter, Ollama)
5. API keys for chosen provider
6. Groq API key (optional, for voice)
7. PostgreSQL password, port, downloads directory
8. Creates `.env`, runs `bun install`, starts Docker, runs migrations

**Key files:** `cli.ts`

---

## 4. Telegram Commands

| Command | Category | Description |
|---------|----------|-------------|
| `/start` | Sessions | Welcome message and quick help |
| `/help` | Sessions | Show available commands |
| `/sessions` | Sessions | List all sessions (🟢 active / ⚪ inactive / 💀 terminated) |
| `/switch [id]` | Sessions | Switch session with context briefing |
| `/standalone` | Sessions | Switch to standalone mode |
| `/session` | Sessions | Show current session info |
| `/rename <id> <name>` | Sessions | Rename a session |
| `/remove <id>` | Sessions | Delete session and all data |
| `/cleanup` | Sessions | Remove terminated and orphaned sessions |
| `/projects` | Projects | List projects with Start/Stop buttons |
| `/project_add` | Projects | Register new project; creates remote session |
| `/remote_control` | Projects | Tmux bots status with Kill/Start/Refresh |
| `/add` | Sessions | Register project as Claude Code session |
| `/model` | Config | Select Claude model (opus/sonnet/haiku) |
| `/remember [text]` | Memory | Save to long-term memory (smart reconciliation) |
| `/recall [query]` | Memory | Semantic search through memory |
| `/memories` | Memory | List recent memories with type/tag filters |
| `/forget [id]` | Memory | Delete a memory |
| `/summarize` | Memory | Force conversation summarization |
| `/clear` | Memory | Clear current session context (short-term) |
| `/stats` | Monitoring | API usage, tokens, transcriptions |
| `/logs [id]` | Monitoring | Request logs for session |
| `/status` | Monitoring | Bot health: DB, Ollama, session counts |
| `/pending` | Monitoring | Pending CLI permission requests |
| `/tools` | Knowledge | List available MCP tools |
| `/skills` | Knowledge | Skills catalog from `~/.claude/skills/` |
| `/commands` | Knowledge | Custom commands from `~/.claude/commands/` |
| `/hooks` | Knowledge | Configured Hookify rules |
| `/rules` | Knowledge | Coding rules from knowledge base |

---

## 5. MCP Tools

| Tool | Transport | Parameters | Description |
|------|-----------|------------|-------------|
| `remember` | HTTP + stdio | `content`, `type` (fact/summary/decision/note), `tags`, `source` | Save to long-term memory with smart reconciliation |
| `recall` | HTTP + stdio | `query`, `limit?`, `type?`, `tags?` | Semantic search through memories |
| `forget` | HTTP + stdio | `id` | Delete a memory by ID |
| `list_memories` | HTTP + stdio | `type?`, `tags?`, `limit?`, `offset?` | List memories with filters |
| `reply` | HTTP + stdio | `chat_id`, `text`, `parse_mode?` | Send message to Telegram chat |
| `react` | HTTP + stdio | `chat_id`, `message_id`, `emoji` | Set emoji reaction on Telegram message |
| `edit_message` | HTTP + stdio | `chat_id`, `message_id`, `text`, `parse_mode?` | Edit a previously sent bot message |
| `list_sessions` | HTTP + stdio | (none) | List all sessions with status |
| `session_info` | HTTP + stdio | `session_id` | Get detailed session info |
| `set_session_name` | HTTP + stdio | `name`, `project_path?` | Register or adopt session at CLI startup |
| `search_project_context` | HTTP + stdio | `query`, `project_path?`, `limit?` | Semantic search over project context + work summaries |
| `update_status` | stdio only | `status`, `chatId`, `diff?` | Update live status message in Telegram (auto-deleted on `reply`) |

---

## 6. Configuration

### 6.1 Environment Variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | — | **YES** | Bot token from @BotFather |
| `ALLOWED_USERS` | `""` | NO | Comma-separated Telegram user IDs; empty = open (warning logged) |
| `ANTHROPIC_API_KEY` | `""` | For Anthropic | Claude API key |
| `CLAUDE_MODEL` | `claude-sonnet-4-20250514` | NO | Claude model for standalone mode |
| `MAX_TOKENS` | `8192` | NO | Max tokens per Claude response |
| `GOOGLE_AI_API_KEY` | `""` | For Google AI | Google AI API key |
| `GOOGLE_AI_MODEL` | `gemma-4-31b-it` | NO | Google AI model |
| `OPENROUTER_API_KEY` | `""` | For OpenRouter | OpenRouter API key |
| `OPENROUTER_MODEL` | `qwen/qwen3-235b-a22b:free` | NO | OpenRouter model |
| `OLLAMA_URL` | `http://localhost:11434` | NO | Ollama server URL (embeddings + chat) |
| `OLLAMA_CHAT_MODEL` | `qwen3:8b` | NO | Ollama model for standalone chat |
| `EMBEDDING_MODEL` | `nomic-embed-text` | NO | Ollama embedding model |
| `DATABASE_URL` | — | **YES** | PostgreSQL connection string |
| `PORT` | `3847` | NO | Bot server port |
| `TELEGRAM_TRANSPORT` | `polling` | NO | `polling` or `webhook` |
| `TELEGRAM_WEBHOOK_URL` | `""` | For webhook | Full webhook URL |
| `SHORT_TERM_WINDOW` | `20` | NO | Recent messages in short-term cache |
| `IDLE_TIMEOUT_MS` | `900000` | NO | Idle timeout for auto-summarization (ms) |
| `ARCHIVE_TTL_DAYS` | `30` | NO | TTL for archived messages before deletion |
| `MEMORY_SIMILARITY_THRESHOLD` | `0.35` | NO | Cosine distance threshold for reconciliation |
| `MEMORY_RECONCILE_TOP_K` | `5` | NO | Similar memories to fetch for reconciliation |
| `MEMORY_TTL_FACT_DAYS` | `90` | NO | Fact memory TTL |
| `MEMORY_TTL_SUMMARY_DAYS` | `60` | NO | Summary memory TTL |
| `MEMORY_TTL_DECISION_DAYS` | `180` | NO | Decision memory TTL |
| `MEMORY_TTL_NOTE_DAYS` | `30` | NO | Note memory TTL |
| `MEMORY_TTL_PROJECT_CONTEXT_DAYS` | `180` | NO | Project context memory TTL |
| `GROQ_API_KEY` | `""` | NO | Groq API key for voice transcription |
| `DOWNLOADS_DIR` | `./downloads` | NO | Directory for downloaded files |

---

## 7. Database Schema

### Core Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `sessions` | Session registry | `id`, `name`, `project`, `source`, `project_path`, `project_id`, `client_id`, `status`, `cli_config`, `connected_at`, `last_active` |
| `chat_sessions` | User → active session mapping | `chat_id` (PK), `active_session_id` (FK) |
| `messages` | Short-term and archived messages | `id`, `session_id`, `chat_id`, `role`, `content`, `project_path`, `created_at`, `archived_at` |
| `memories` | Long-term semantic memory | `id`, `session_id`, `chat_id`, `type`, `content`, `tags`, `project_path`, `embedding` (vector 768), `created_at`, `archived_at` |
| `message_queue` | Pending messages for channel.ts | `id`, `session_id`, `chat_id`, `content`, `message_id`, `delivered`, `created_at`, `attachments` (JSONB) |
| `permission_requests` | CLI permission requests | `id`, `session_id`, `chat_id`, `tool_name`, `description`, `response`, `message_id`, `created_at`, `archived_at` |
| `projects` | Persistent project registry | `id`, `name`, `path`, `created_at` |
| `api_request_stats` | API call metrics | `id`, `session_id`, `provider`, `model`, `operation`, `duration_ms`, `status`, `input_tokens`, `output_tokens`, `created_at` |
| `transcription_stats` | Voice transcription metrics | `id`, `session_id`, `provider`, `duration_ms`, `audio_duration_sec`, `status`, `created_at` |
| `request_logs` | Structured request logs | `id`, `session_id`, `chat_id`, `level`, `stage`, `message`, `created_at` |
| `schema_versions` | Migration tracking | `version` (PK), `name`, `applied_at` |

### Key Indexes

- `idx_memories_embedding` — HNSW for fast vector similarity search
- `idx_memories_tags` — GIN for tag filtering
- `idx_memories_project_path` — project-scoped memory queries
- `idx_queue_session` — message queue polling

---

## 8. Deployment

### Docker Setup (Recommended)

```bash
# Clone
git clone https://github.com/MrCipherSmith/multiclaude-tg-bot.git ~/bots/helyx
cd ~/bots/helyx

# Configure
cp .env.example .env
# Edit .env: TELEGRAM_BOT_TOKEN, ALLOWED_USERS, ANTHROPIC_API_KEY, POSTGRES_PASSWORD

# Start
docker compose up -d

# Verify
curl http://localhost:3847/health
```

**Services:**
- `bot`: Bun application, port 3847
- `postgres`: PostgreSQL 16 with pgvector, internal networking

**Volumes:**
- `pgdata`: PostgreSQL data persistence
- `./downloads`: Shared file downloads
- `${HOME}/.claude`: Read-only mount of Claude Code config

**Ollama** must run on the host (not in Docker). Bot connects via `http://host.docker.internal:11434`:
```bash
ollama pull nomic-embed-text
ollama serve
```

### Manual Setup

```bash
bun install
bun memory/db.ts   # run migrations
bun main.ts        # start bot
```

### Operations

```bash
# Backup
docker exec helyx-postgres-1 pg_dump -U helyx helyx > backup.sql

# Update
git pull origin main && bun install
docker compose down && docker compose up -d

# Monitoring
docker logs -f helyx-bot-1
# or via bot: /status, /stats
```

---

## 9. Message Flow Diagrams

### CLI Mode

```
User (Telegram)
    │ sends message
    ▼
Bot (main.ts)
    ├─ validates user (ALLOWED_USERS)
    ├─ routes via sessions/router.ts → CLI mode
    ├─ inserts into message_queue
    └─ sends "Thinking..." status

channel.ts (host)
    ├─ polls message_queue (500ms)
    ├─ picks up message
    └─ sends: MCP notifications/claude/channel

Claude Code
    ├─ processes message, runs tools
    ├─ requests permissions (if needed)
    │     └─ Bot shows Telegram buttons → user taps → Claude continues
    └─ calls MCP tool: reply(text)

Bot (mcp/tools.ts)
    ├─ formats Markdown → HTML
    ├─ chunks at 4096 chars
    └─ sends to Telegram chat
```

### Standalone Mode

```
User (Telegram)
    │ sends message
    ▼
Bot (main.ts)
    ├─ routes → standalone mode
    ├─ composes prompt (short-term + long-term recall)
    └─ calls streamToTelegram()

LLM Provider
    ├─ streams response
    ├─ Bot updates message periodically
    └─ final response saved to messages table

Idle Timer (15 min)
    ├─ summarizes conversation
    ├─ saves to long-term memory (pgvector)
    └─ archives old messages
```

---

## 10. Implementation Notes

1. **Advisory Lock**: `pg_advisory_lock(session_id)` held by channel.ts while connected — prevents two instances from managing the same session.

2. **Heartbeat**: channel.ts updates `last_active` every 5 minutes to prevent stale session detection during long tasks.

3. **Session Adoption**: `adoptOrRename()` — if a remote session exists for the project path, adopt it (update client_id) rather than creating a new local session.

4. **Message Chunking**: Telegram max = 4096 chars. `chunkText()` splits responses preserving HTML formatting.

5. **Ollama Graceful Degradation**: If unavailable, `embedSafe()` returns null. Memory is saved without embedding — data preserved, not searchable by similarity.

6. **Reconciliation Parse**: Claude Haiku output must match exact format: `ADD` | `UPDATE id=X content="..."` | `DELETE id=X` | `NOOP`. Falls back to `remember()` if parse fails.

7. **Startup Race**: Cleanup timer's `markStale()` is skipped on startup to allow channel.ts to reconnect and update `last_active` before being marked stale.

8. **Project Scoping**: Memories are scoped by `project_path` (preferred) or `session_id` (legacy). `search_project_context` filters for `project_context` + `summary` types only.

---

## 11. How to Keep This Spec Updated

Before committing a significant change, verify:
- [ ] All commands listed in Section 4
- [ ] All MCP tools listed in Section 5
- [ ] All env vars in Section 6.1
- [ ] Database changes reflected in Section 7
- [ ] Architecture diagram still accurate

Commit with: `docs: update specification`

**Related docs:**
- `docs/spec/ai/spec.md` — Machine-readable spec for AI agents
- `docs/ROADMAP.md` — Feature status tracking
- `guides/` — Detailed guides per topic
