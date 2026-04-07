# PRD: Claude Bot — Product Overview

## 1. Overview

Claude Bot is a Telegram bot for remotely controlling multiple Claude Code CLI instances. Users send tasks by voice or text, receive real-time progress updates, approve CLI tool permissions, and interact with persistent project memory — all from Telegram on any device.

## 2. Context

| Field | Value |
|-------|-------|
| **Product** | Claude Bot (multiclaude-tg-bot) |
| **Version** | v1.10.0 |
| **Module** | Entire product |
| **User Role** | Developer managing AI agents remotely |
| **Tech Stack** | Bun · TypeScript · grammY · MCP SDK · PostgreSQL 16 + pgvector · Ollama · React + Tailwind · Docker |

## 3. Problem Statement

### 3.1 Remote Claude Code control
Claude Code only runs in a terminal. Sending tasks from a phone requires SSH access and sitting at a computer.

**Solution:** A Telegram bot accepts messages and routes them to the correct CLI process via the MCP protocol.

### 3.2 Context loss between sessions
When Claude Code restarts, the entire conversation context is lost. There is no way to say "continue from where you left off."

**Solution:** Dual-layer memory — short-term (sliding window, PostgreSQL) and long-term (pgvector embeddings via Ollama). On session exit, an AI-generated structured summary is vectorized and stored in long-term memory.

### 3.3 Managing multiple projects
Developers often have 3–10 active projects. Switching between them means reconstructing context from scratch each time.

**Solution:** `/switch` displays a briefing from the last project_context summary and injects it as system context for the next message.

### 3.4 Permission approval without terminal access
Claude Code requests permission before writing files or running commands. Without a response, the process blocks.

**Solution:** Permission requests are forwarded to Telegram as inline buttons (Allow / Always / Deny) with file path and diff preview. The response is synced back to the terminal.

### 3.5 Memory accumulation and duplication
Frequent use of `/remember` accumulates stale and duplicate facts.

**Solution:** Smart Memory Reconciliation — before saving, vector search finds similar memories, and Claude Haiku decides: ADD / UPDATE / DELETE / NOOP.

### 3.6 Voice and image input to Claude Code
The CLI cannot accept voice messages or photos directly.

**Solution:** The bot transcribes voice via Groq (whisper-large-v3, ~200ms) and analyzes images via Claude API.

---

## 4. Goals

- Enable full management of multiple Claude Code sessions via Telegram
- Preserve project context across sessions with minimal information loss
- Minimize memory duplication via LLM-based deduplication
- Provide a web dashboard for monitoring stats, logs, and memory
- Simplify onboarding with a one-line installer and setup wizard

## 5. Non-Goals

- Not a replacement for Claude Code CLI (extends, not replaces)
- No multi-user support with namespace isolation (on roadmap)
- Does not directly manage files or code — transport and memory only
- Does not provide its own AI engine — uses external providers

---

## 6. Functional Requirements

### FR-1: MCP Server (HTTP, port 3847)
The bot runs an HTTP MCP server exposing tools: `remember`, `recall`, `forget`, `list_memories`, `reply`, `react`, `edit_message`, `list_sessions`, `session_info`, `set_session_name`, `search_project_context`. Claude Code connects as an MCP client.

### FR-2: Channel Adapter (stdio)
`channel.ts` — a stdio MCP adapter launched via `--channels "bun channel.ts"`. Registers/adopts a session in PostgreSQL, polls `message_queue` (500ms + LISTEN/NOTIFY), forwards messages via `notifications/claude/channel`.

### FR-3: Session Management
- **Remote sessions** (`source=remote`): one persistent per project, never deleted, status `active|inactive`
- **Local sessions** (`source=local`): temporary, one per CLI process, status `terminated` on exit
- **Projects table**: permanent registry, added via `/project_add`
- **Cleanup**: hourly stale/orphan session cleanup, TTL archival (default 30 days)

### FR-4: Dual-Layer Memory
- **Short-term**: sliding window of 20 messages, in-memory cache + PostgreSQL `messages`
- **Long-term**: `memories` table with `embedding vector(768)`, HNSW index, cosine similarity search
- **Vectorization**: Ollama (`nomic-embed-text`, 768 dims), graceful degradation if unavailable

### FR-5: Smart Memory Reconciliation
`rememberSmart()` — before insert:
1. Embed new content
2. Find top-K similar memories (same type + scope via `project_path` or `chat_id`)
3. If distance ≤ threshold (0.35): send list + new content to Claude Haiku
4. Execute decision: ADD / UPDATE id / DELETE id + ADD / NOOP
5. Fallback if Ollama or Claude API unavailable → plain `remember()`

### FR-6: Work Summary on Exit
On `channel.ts` shutdown, calls `/api/sessions/:id/summarize-work`. The summarizer:
- Takes the last N messages of the session
- Produces a structured summary: `[DECISIONS][FILES][PROBLEMS][PENDING][CONTEXT]`
- Saves as `type='project_context'` in `memories` (via `rememberSmart`)
- Archives messages: `archived_at = now()`

### FR-7: Session Switch Briefing
`/switch [id]` shows:
- Most recent `project_context` from memories for the project
- Last 5 messages of the session
- Injects context into system prompt of the next message

### FR-8: Standalone Mode
Without an active CLI session: the bot responds directly via LLM (Anthropic / Google AI / OpenRouter / Ollama). Streams responses with periodic message edits. Auto-summarization after 15 min idle.

### FR-9: Telegram UX
- Markdown → Telegram HTML rendering with syntax highlighting
- Voice messages: Groq whisper-large-v3 (~200ms), fallback to local Whisper
- Images: Claude API (CLI mode) / Anthropic API (standalone)
- Permission requests: inline buttons Allow / Always / Deny with diff preview
- Auto-approve: patterns in `settings.local.json` (e.g. `"Edit(*)"`) skip the Telegram approval step
- Live status: real-time CLI progress via tmux monitoring

### FR-10: Web Dashboard
React + Tailwind SPA, served on port 3847:
- **Overview**: uptime, DB status, active sessions, 24h tokens
- **Sessions**: session list with rename/delete
- **Stats**: tokens/requests by provider, project, operation, 30-day charts
- **Logs**: per-session logs with search
- **Memory**: hot context (top-10 recent), tag cloud with per-tag delete, Indexing... indicator

### FR-11: CLI Tool (`claude-bot`)
Installation, setup wizard, tmux session management, backup, monitoring. Commands: `setup`, `connect`, `up`, `down`, `ps`, `add`, `remove`, `backup`, `logs`, `status`.

---

## 7. Non-Functional Requirements

| NFR | Requirement |
|-----|-------------|
| NFR-1 | Message queue polling: latency ≤ 500ms (LISTEN/NOTIFY reduces to ~0ms) |
| NFR-2 | Smart reconciliation: full cycle ≤ 5 seconds |
| NFR-3 | Ollama embedding: ≤ 2 seconds with 2 retries and exponential backoff |
| NFR-4 | Dashboard API: response ≤ 500ms |
| NFR-5 | Graceful degradation: Ollama unavailable → remember() without vectors |
| NFR-6 | Session heartbeat: channel.ts updates last_active every 5 minutes |
| NFR-7 | Stale sessions are not deleted on bot startup (race condition protection) |
| NFR-8 | Docker-first: full stack starts with `docker compose up -d` |

---

## 8. Constraints

- **Single user**: `ALLOWED_USERS` is a Telegram ID whitelist, no roles
- **Single Ollama instance**: embeddings from one host only
- **PostgreSQL**: no sharding, vertical scaling only
- **grammY polling/webhook**: single bot instance — horizontal scaling requires webhook + load balancer
- **MCP protocol**: tested with Claude Code CLI only (spec-compliant, but no other clients tested)

---

## 9. Edge Cases

- **Ollama unavailable at remember()**: `embedSafe()` returns null, memory saved without vector (not searchable by similarity, but data preserved)
- **Claude API unavailable at reconcile**: falls back to `remember()` without deduplication
- **Bot restart**: startup cleanup skips markStale, channel.ts reconnects and updates last_active
- **SIGKILL on channel.ts**: session stays `active` in DB — heartbeat stops, markStale fires after 10 min
- **Two channel.ts for same project**: advisory lock prevents session race condition
- **Long CLI response**: chunked at 4096 chars with formatting preserved
- **Concurrent remember() calls**: `_indexingCount` counter correctly reflects `indexing: true` while any call is active

---

## 10. Roadmap

### Implemented ✅
- Multi-session MCP server
- Channel Adapter (stdio bridge)
- Dual-layer memory (short-term + pgvector)
- Smart Memory Reconciliation (LLM deduplication)
- Persistent projects + remote/local session lifecycle
- Work summary on exit + session switch briefing
- Semantic search (`search_project_context`)
- Permission forwarding with inline buttons
- Voice transcription (Groq) + image analysis
- Standalone mode (4 providers)
- Web Dashboard (Overview, Sessions, Stats, Logs, Memory)
- Skills / Commands / Hooks integration
- Session heartbeat + startup cleanup fix
- Visual Memory Map (hot context + tag cloud)
- Embeddings indexing indicator

### Planned ⬜
- **Dashboard project management** — create/start/stop projects from web UI (currently Telegram only)
- **Multi-user** — isolated sessions and memory per Telegram user
- **Inline mode** — respond in any Telegram chat via `@bot query`
- **Webhook scaling** — horizontal scaling via webhook + load balancer
- **Memory TTL per type** — different retention periods per memory type (fact vs summary)
- **Dashboard browser notifications** — push notifications for session state changes

---

## 11. Acceptance Criteria (Gherkin)

```gherkin
Feature: Remote Claude Code control via Telegram

  Scenario: Send task to active CLI session
    Given user is connected to the Telegram bot
    And there is an active local session for project "my-app"
    When user sends the message "add tests for AuthService"
    Then bot shows status "Thinking..."
    And channel.ts picks up the message from message_queue
    And Claude Code CLI receives notifications/claude/channel
    And Claude Code replies via MCP tool reply()
    And bot delivers HTML-formatted response to Telegram

  Scenario: Permission request from CLI
    Given Claude Code is attempting a Bash command
    And the command is not in the auto-approve list
    When channel.ts receives a permission_request notification
    Then bot sends a message with inline buttons Allow / Always / Deny
    And shows command preview or file diff
    When user taps "Allow"
    Then permission_request is updated in DB
    And Claude Code receives confirmation and continues

  Scenario: Smart Memory Reconciliation
    Given project memory contains fact "using PostgreSQL 15"
    When user calls /remember "upgraded to PostgreSQL 16"
    Then rememberSmart() finds similar fact with distance ≤ 0.35
    And sends both to Claude Haiku for a decision
    And Haiku responds UPDATE id=X content="using PostgreSQL 16"
    And existing record is updated in DB
    And bot replies "Updated #X"

  Scenario: Work Summary on session exit
    Given active local session for project "my-app"
    When channel.ts receives SIGTERM or stdin.close
    Then /api/sessions/:id/summarize-work is called
    And summarizer generates structured summary [DECISIONS][FILES][PROBLEMS][PENDING][CONTEXT]
    And saves it as type='project_context' via rememberSmart()
    And archives session messages (archived_at = now())

  Scenario: Session switch with briefing
    Given user is in session "project-a"
    And "project-b" has a saved project_context
    When user calls /switch to session "project-b"
    Then bot shows the last project_context summary
    And shows last 5 messages of the session
    And the next user message receives system context from the summary

  Scenario: Graceful degradation — Ollama unavailable
    Given Ollama is unavailable (connection refused)
    When user calls /remember "new fact"
    Then embedSafe() returns null without throwing
    And fact is saved to DB without embedding vector
    And bot replies "Saved (#N)" without errors

  Scenario: Heartbeat protects long-running session
    Given active local session exists in DB
    And Claude Code is running a long autonomous task (>10 min with no MCP tool calls)
    Then channel.ts updates last_active in DB every 5 minutes
    And cleanup timer does not mark the session as stale
```

---

## 12. Verification

### Manual Testing
- `claude-bot connect . --tmux` → session appears in `/sessions`
- Send message → Claude Code receives it, replies via `reply`
- Voice message → transcription → CLI response
- `/remember "fact"` → repeat `/remember "same fact"` → reply "Already known"
- `/switch` → shows briefing with project context

### Automated Checks
- `GET /health` → `{"status":"ok"}`
- `GET /api/overview` → `{sessions, tokens24h, indexing}`
- `GET /api/memories/tags` → array `{tag, count}`
- Docker: `docker compose ps` → all containers running

### Observability
- Bot logs: `docker logs claude-bot-bot-1 -f`
- Dashboard: `http://localhost:3847`
- `/status` in Telegram → DB, Ollama, sessions
- `/stats` → tokens, cost by provider
