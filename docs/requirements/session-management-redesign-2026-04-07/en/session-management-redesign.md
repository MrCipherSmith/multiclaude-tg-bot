# PRD: Session Management Redesign

## 1. Overview

Redesign of the session system: persistent projects, two session types (remote/local) with distinct lifecycles, automatic AI-optimized work-context summarization on exit, vectorized long-term storage, semantic search, and contextual briefing on session switch.

## 2. Context

- **Product:** claude-bot — Telegram bot managing Claude Code sessions
- **Module:** sessions, memory, mcp/tools, bot/commands
- **Tech Stack:** Bun, grammY, PostgreSQL, pgvector, Ollama (nomic-embed-text), MCP stdio
- **Current DB schema version:** v5

## 3. Problem Statement

Sessions are semi-ephemeral with no clear remote/local distinction. No projects table. Work context is lost on exit. On session switch, users have no briefing — context recovery is manual. No semantic search over accumulated project knowledge.

## 4. Goals

- Introduce `projects` table as a permanent project registry
- Separate remote sessions (persistent, one per project) from local sessions (temporary, multiple)
- On session exit: generate AI-optimized structured summary, vectorize, store in long-term memory
- Manage remote session short-term memory with periodic summarization
- On session switch: show user a briefing from target session's summary; hold in short-term cache
- Provide semantic search via MCP tool and bot command

## 5. Non-Goals (current iteration)

- Changing channel.ts → Claude Code connection (MCP stdio stays)
- Per-task model configuration (future; only `config` jsonb structure introduced now)
- Automatic tmux session creation (stays via admin-daemon)

## 5a. Planned Next Iteration

- Dashboard UI for session and project management (status overview, summary history, context search)

## 6. Functional Requirements

### FR-1: Projects Table
Create table `projects`: `id`, `name`, `path` (unique), `tmux_session_name`, `config` (jsonb, extensible), `created_at`. `/project_add` command saves to this table.

### FR-2: Remote Session
One per project (`source='remote'`, `status='active'|'inactive'`). Created on first project start. Never deleted — status only. Started from Telegram (`/projects` → Start) or terminal (`claude-bot start --project <name>`). Connection = attach to `bots` tmux session.

### FR-3: Local Session
Multiple per project (`source='local'`). Created when Claude Code starts in terminal. Lives while Claude process is alive. On exit: `status='terminated'`. Record kept N days for audit, then deleted by TTL cleanup.

### FR-4: Summary on Session Exit
On exit (SIGINT/SIGTERM/stdin.close), `channel.ts` calls `/api/sessions/:id/summarize-work`. Endpoint:
1. Collects `messages` (dialogue) and `permission_requests` (tool calls) for the session
2. Sends to Claude API with AI-optimized prompt (FR-5)
3. Vectorizes via Ollama
4. Saves to `memories` (`type='project_context'`, `session_id=NULL`, `project_path=X`)
5. Marks `messages` for archival (`archived_at=now()`, deleted after configurable TTL, default 30 days)
6. Marks `permission_requests` for archival (same TTL)
7. Sets `sessions.status='terminated'`

### FR-5: Summary Format and Prompt
Output format: **AI-optimized structured text** — machine-parseable sections with clear labels, designed for reliable downstream transformation into human-readable markdown. Priority: information density and precision, not readability.

Prompt extracts (sections omitted if no relevant content):
```
[DECISIONS]
<decision>: <rationale>
...

[FILES]
<path>: <what_changed> | <why>
...

[PROBLEMS]
<problem>: <solution>
...

[PENDING]
<task_or_issue>
...

[CONTEXT]
<non_obvious_fact>
...
```

Rules: no preamble, no restating the obvious, max 2000 tokens.

### FR-6: Remote Session Memory Management
Remote session accumulates `messages` (bounded window). Summarization triggers:
- Idle timeout (configurable, default `CONFIG.IDLE_TIMEOUT_MS`)
- Manual `/summarize` bot command
- Overflow (`messages > SHORT_TERM_WINDOW * 2`)

After summarization: summary saved to `memories` (`type='summary'`, `project_path`), old messages marked for archival (TTL). Session continues running.

### FR-7: Session Switch Briefing
On session switch (`/switch`, inline button):
1. Bot queries latest summary from `memories` for target session's `project_path` (type `project_context` or `summary`)
2. Sends it to user in chat as briefing before confirming switch
3. Stores it in **in-memory cache** (`Map<chatId, SwitchContext>`) — lives until next switch or 60 min timeout
4. On user's next message in standalone mode: cache used as system context
5. On next switch: cache for this `chatId` is cleared and overwritten

Edge case: if `messages` are already archived (TTL expired), summary is still available from `memories` — this is exactly why `session_id=NULL` on project_context records.

### FR-8: Semantic Search
**MCP tool** `search_project_context(query, project_path?)` — available to Claude Code. Cosine similarity search on `memories WHERE type IN ('project_context', 'summary')`, returns top-K with scores.

**Bot command** `/search_context <query>` — searches active session's project context, outputs to chat.

### FR-9: Session Display in Bot
`/sessions` and `/projects` show remote sessions with status icons (🟢 active / ⚪ inactive). Local sessions shown under project while active.

## 7. Non-Functional Requirements

- **NFR-1:** Summary must complete within 30s (Claude API timeout on exit)
- **NFR-2:** Ollama vectorization — non-blocking to main bot thread
- **NFR-3:** `messages` and `permission_requests` archival TTL — configurable (default 30 days)
- **NFR-4:** Semantic search latency < 500ms for up to 10K memory records
- **NFR-5:** DB migrations — backward compatible, no downtime
- **NFR-6:** Switch briefing cache — not persisted; lost on bot restart (acceptable)

## 8. Constraints

- pgvector installed; embedding dimensions fixed by `CONFIG.VECTOR_DIMENSIONS`
- Ollama: graceful degradation — save text without vector, retry on next startup
- `channel.ts` reads env directly (no `CONFIG` access)
- One remote session per project — unique DB index

## 9. Edge Cases

- **Remote + Local simultaneously:** independent, no conflict
- **Ollama unavailable on exit:** save without embedding, retry on startup
- **SIGKILL:** `markStale()` sets terminated, no summary — context lost
- **Switch to session with no summary in memories:** no briefing shown, cache not populated
- **Switch to session with archived messages:** summary from `memories` (works normally)
- **Empty session (0 messages):** no summary, no TTL marking

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Persistent Projects
  Scenario: Add new project
    Given bot is running and DB is accessible
    When user calls /project_add claude-bot /home/user/bots/claude-bot
    Then projects table has record with correct name and path
    And tmux_session_name is auto-generated

Feature: Remote Session Lifecycle
  Scenario: Start remote session
    Given project exists, remote session is inactive
    When user taps Start in /projects
    Then admin_commands receives proj_start
    And session status = 'active'

  Scenario: Remote session survives disconnect
    Given remote session is active
    When channel.ts exits (SIGTERM)
    Then sessions record NOT deleted
    And status = 'inactive'

Feature: Session Summary on Exit
  Scenario: Successful work summary
    Given local session with 10+ messages and 5+ tool calls
    When Claude Code exits
    Then memories has record type='project_context', session_id=NULL
    And messages.archived_at IS NOT NULL for session
    And sessions.status = 'terminated'

  Scenario: Ollama unavailable
    Given local session ending, Ollama unreachable
    Then memories record has embedding=NULL
    And process exits cleanly

Feature: Session Switch Briefing
  Scenario: Switch with existing summary
    Given memories has project_context for project 'claude-bot'
    When user switches to that project's session
    Then bot sends summary as briefing message in chat
    And SwitchContext cache populated for chatId

  Scenario: Switch with no summary
    Given memories has no records for target project
    When user switches to session
    Then switch completes without briefing

Feature: Semantic Search
  Scenario: MCP tool
    Given 20 memories records for project
    When search_project_context("session architecture", limit=5)
    Then 5 results returned, sorted by similarity descending

  Scenario: Bot command
    Given user switched to project session
    When /search_context how does summarization work
    Then bot returns relevant fragments from project context
```

## 11. Verification

### Testing
- Unit: summary prompt — validate `[DECISIONS]`, `[FILES]` etc. section structure
- Integration: local session cycle (start → messages → exit → memories → TTL marks)
- Integration: session switch → briefing → cache → next switch → cache cleared
- Manual: remote session via `/projects`, status verification

### Observability
- `[summarizer] session #X: summary saved id=Y, messages ttl-marked N rows`
- `[summarizer] ollama unavailable, saved without embedding id=Y`
- `[switch] session #X: briefing loaded from memories id=Y`
- `[switch] session #X: no briefing available`
- `/status` shows `memories` counts by type

### Migrations
- **v6:** `projects` table
- **v7:** `archived_at` on `messages` and `permission_requests`; `project_id FK` on `sessions`; unique index remote-per-project
- **v8:** index `memories(type, project_path)`; statuses `terminated` / `inactive`
