# PRD: Session Management Redesign (AI-readable)

## Metadata
```yaml
feature: session-management-redesign
version: 1.1.0
date: 2026-04-07
status: approved
db_schema_version_current: 5
db_schema_version_target: 8
stack: [bun, grammy, postgresql, pgvector, ollama, mcp-stdio]
affected_modules:
  - sessions/manager.ts
  - memory/db.ts
  - memory/summarizer.ts
  - mcp/tools.ts
  - channel.ts
  - bot/commands/projects.ts
  - bot/commands/project-add.ts
  - bot/commands/session.ts   # switch briefing
  - bot/callbacks.ts          # switch briefing
next_iteration: dashboard-ui
```

## Domain Model

```
Project (permanent)
  id: serial PK
  name: text UNIQUE
  path: text UNIQUE
  tmux_session_name: text
  config: jsonb  -- extensible; future: per-task models
  created_at: timestamptz

Session (updated schema)
  source: 'remote' | 'local' | 'standalone'
  status: 'active' | 'inactive' | 'terminated'
  project_id: int FK projects(id) NULLABLE  -- null for standalone
  -- remote: status active|inactive, never deleted, unique per project
  -- local: status active|terminated, deleted after TTL
  -- standalone: id=0, unchanged

Message (updated schema)
  archived_at: timestamptz NULLABLE  -- set on session exit/summarize; deleted by TTL job

PermissionRequest (updated schema)
  archived_at: timestamptz NULLABLE  -- same TTL as messages

Memory (existing, usage extended)
  type: 'summary' | 'fact' | 'project_context'
  -- project_context: session work summary, session_id=NULL, project_path scoped
  -- summary: remote session idle/overflow summary, session_id set, project_path scoped
  session_id: nullable  -- NULL for project_context
  project_path: text
  embedding: vector(CONFIG.VECTOR_DIMENSIONS)
```

## Session Lifecycle State Machines

### Remote Session
```
[NOT_EXISTS] --/project_add--> [inactive]
[inactive]   --Start (bot|CLI)--> [active]
[active]     --channel.ts SIGTERM--> markDisconnected --> [inactive]
[active]     --channel.ts SIGKILL--> markStale (timeout) --> [inactive]
-- CONSTRAINT: DELETE never executed on remote session
-- CONSTRAINT: unique(project_id) WHERE source='remote'
```

### Local Session
```
[NOT_EXISTS] --claude starts, channel.ts registers--> [active]
[active]     --SIGINT|SIGTERM|stdin.close--> summarize-work --> [terminated]
[active]     --SIGKILL--> markStale --> [terminated]  // no summary
[terminated] --TTL cleanup job (30d)--> [deleted]
```

### In-Memory Switch Context Cache
```
Map<chatId, { summary: string, sessionId: number, loadedAt: Date }>
TTL: 60 minutes or until next switch
Persistence: none (lost on bot restart — acceptable)
```

## API Contracts

### POST /api/sessions/:id/summarize-work
```typescript
// Triggered by: channel.ts on exit (markDisconnected)
// Input: session_id from URL param
// Processing steps:
const messages = await sql`
  SELECT role, content, created_at FROM messages
  WHERE session_id = $id ORDER BY created_at ASC
`
const toolCalls = await sql`
  SELECT tool_name, description, response, created_at FROM permission_requests
  WHERE session_id = $id ORDER BY created_at ASC
`

if (messages.length < 4) return { ok: true, skipped: 'too_few_messages' }

const summary = await claudeAPI.complete(buildSummaryPrompt(messages, toolCalls))
const embedding = await ollama.embed(summary)  // nullable if unavailable

await sql.begin(async tx => {
  await tx`INSERT INTO memories (type, session_id, project_path, content, embedding, source, tags)
    VALUES ('project_context', NULL, $projectPath, $summary, $embedding, 'work_session', ARRAY['exit'])`

  await tx`UPDATE messages SET archived_at = now() WHERE session_id = $id`
  await tx`UPDATE permission_requests SET archived_at = now() WHERE session_id = $id`
  await tx`UPDATE sessions SET status = 'terminated' WHERE id = $id`
})

// Response
{ ok: true, memory_id: number } | { ok: false, error: string, skipped?: string }
```

### TTL Cleanup Job (cron or startup)
```typescript
// Delete archived records past TTL
const TTL_DAYS = CONFIG.ARCHIVE_TTL_DAYS ?? 30
await sql`DELETE FROM messages WHERE archived_at < now() - interval '${TTL_DAYS} days'`
await sql`DELETE FROM permission_requests WHERE archived_at < now() - interval '${TTL_DAYS} days'`
// Delete terminated local sessions past TTL (cascade via deleteSessionCascade)
const staleSessions = await sql`
  SELECT id FROM sessions
  WHERE source = 'local' AND status = 'terminated'
    AND last_active < now() - interval '${TTL_DAYS} days'
`
for (const s of staleSessions) await deleteSessionCascade(s.id)
```

### Session Switch Briefing (in session.ts / callbacks.ts)
```typescript
async function handleSwitch(ctx, targetSessionId) {
  const session = await sessionManager.get(targetSessionId)

  // Load briefing from memories
  let briefing: string | null = null
  if (session.projectPath) {
    const [mem] = await sql`
      SELECT content FROM memories
      WHERE project_path = ${session.projectPath}
        AND type IN ('project_context', 'summary')
        AND embedding IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `
    briefing = mem?.content ?? null
  }

  // Perform switch
  await sessionManager.switchSession(ctx.chat.id, targetSessionId)

  // Send briefing before confirmation
  if (briefing) {
    const humanReadable = formatBriefingForTelegram(briefing)  // convert AI format to markdown
    await ctx.reply(`📋 *Context: ${session.project}*\n\n${humanReadable}`, { parse_mode: 'HTML' })
    // Cache for standalone context
    switchContextCache.set(String(ctx.chat.id), {
      summary: briefing,
      sessionId: targetSessionId,
      loadedAt: new Date()
    })
  }

  await ctx.reply(`Switched to ${sessionDisplayName(session)}.`)
}
```

### MCP Tool: search_project_context
```typescript
// Registration in mcp/tools.ts
{
  name: "search_project_context",
  description: "Semantic search over long-term project context and work summaries. Use when you need prior session knowledge about this project.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      project_path: { type: "string", description: "Defaults to current session project_path" },
      limit: { type: "number", default: 5, maximum: 20 }
    },
    required: ["query"]
  }
}

// Handler query:
const queryEmbedding = await ollama.embed(input.query)
const results = await sql`
  SELECT content, type, created_at,
         1 - (embedding <=> ${queryEmbedding}::vector) AS score
  FROM memories
  WHERE project_path = ${projectPath}
    AND type IN ('project_context', 'summary')
    AND embedding IS NOT NULL
  ORDER BY embedding <=> ${queryEmbedding}::vector
  LIMIT ${input.limit ?? 5}
`
return results.map(r => ({ content: r.content, type: r.type, score: r.score, date: r.created_at }))
```

### Bot Command: /search_context
```
/search_context <query>
-- resolve project_path from user's active session
-- same query as MCP tool
-- format top-5 as Telegram HTML message
-- show score as percentage
```

## Summary Prompt

```
SYSTEM:
You extract structured knowledge from a Claude Code work session for long-term AI-readable memory.
Output ONLY the sections below that have content. Use exact section headers. No preamble.
Max 2000 tokens. Omit obvious, routine, or trivial information.

OUTPUT FORMAT:
[DECISIONS]
<decision_label>: <rationale>

[FILES]
<relative/path>: <change_description> | <reason>

[PROBLEMS]
<problem_description>: <solution_applied>

[PENDING]
<task_or_known_issue>

[CONTEXT]
<non_obvious_constraint_or_fact_future_sessions_must_know>

USER:
## Dialogue (user↔assistant)
{messages: role + content, chronological}

## Tool Calls
{permission_requests: tool_name + description + response, chronological}
```

## Remote Session Memory Management

```typescript
// Triggers (existing summarizer.ts, extend with TTL marking)
triggers: {
  idle: CONFIG.IDLE_TIMEOUT_MS,        // existing touchIdleTimer
  overflow: SHORT_TERM_WINDOW * 2,     // existing checkOverflow
  manual: '/summarize command'          // existing forceSummarize
}

// On remote session summarize:
// 1. Summarize via summarizeConversation() (existing)
// 2. Save to memories (type='summary', session_id=session.id, project_path)
// 3. Mark old messages for archival (keep last SHORT_TERM_WINDOW for continuity):
await sql`
  UPDATE messages SET archived_at = now()
  WHERE session_id = $sessionId
    AND id NOT IN (
      SELECT id FROM messages WHERE session_id = $sessionId
      ORDER BY created_at DESC LIMIT ${SHORT_TERM_WINDOW}
    )
    AND archived_at IS NULL
`
// Session continues, not terminated
```

## DB Migrations Required

### Migration v6: projects table
```sql
CREATE TABLE projects (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  tmux_session_name TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_projects_path ON projects(path);
```

### Migration v7: archival TTL + session project_id
```sql
-- Soft-delete support for messages and permission_requests
ALTER TABLE messages ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX idx_messages_archived ON messages(archived_at) WHERE archived_at IS NOT NULL;

ALTER TABLE permission_requests ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX idx_permission_requests_archived ON permission_requests(archived_at) WHERE archived_at IS NOT NULL;

-- Link sessions to projects
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_id INT REFERENCES projects(id);
CREATE INDEX idx_sessions_project_id ON sessions(project_id);

-- Enforce one remote session per project
CREATE UNIQUE INDEX idx_sessions_project_remote
  ON sessions(project_id) WHERE source = 'remote';

-- Rename 'disconnected' -> context-appropriate statuses
-- remote disconnected -> 'inactive', local disconnected -> 'terminated'
UPDATE sessions SET status = 'inactive'   WHERE source = 'remote' AND status = 'disconnected';
UPDATE sessions SET status = 'terminated' WHERE source = 'local'  AND status = 'disconnected';
```

### Migration v8: memories index
```sql
CREATE INDEX IF NOT EXISTS idx_memories_type_project ON memories(type, project_path);
-- Existing HNSW index on embedding already serves semantic search
```

## Graceful Degradation

```
Ollama unavailable during summarization:
  → INSERT memories with embedding = NULL
  → Log: [summarizer] ollama unavailable, saved without embedding id=X
  → On startup: SELECT id FROM memories WHERE embedding IS NULL → retry embed

Claude API timeout during summarize-work:
  → Save concatenated raw messages as fallback (no structure)
  → Tag: ['exit', 'fallback_no_structure']
  → Still mark messages archived_at, still set status=terminated
  → Log: [summarizer] api timeout, fallback summary saved id=X

Bot unreachable when channel.ts calls summarize-work:
  → Log warning, exit normally
  → Context lost for this session (acceptable — SIGKILL equivalent)
```

## Observability

```
[summarizer] session #X: work summary saved id=Y, messages archived N rows
[summarizer] session #X: skipped (too few messages)
[summarizer] ollama unavailable, saved without embedding id=Y
[summarizer] api timeout, fallback summary saved id=Y
[summarizer] remote #X: idle summary id=Y, N messages archived
[switch] session #X → #Y: briefing loaded from memories id=Z
[switch] session #X → #Y: no briefing available
[search] project_context query="..." project=P → N results top_score=0.87
[ttl-cleanup] deleted N messages, M permission_requests, K sessions
```

## Acceptance Criteria (Gherkin - machine executable)

```gherkin
Feature: FR-1 Projects Table
  Scenario: create project
    Given projects table exists (migration v6 applied)
    When POST /api/projects {name:"claude-bot", path:"/home/user/bots/claude-bot"}
    Then SELECT * FROM projects WHERE name='claude-bot' RETURNS 1 row
    And row.tmux_session_name IS NOT NULL

Feature: FR-2 Remote Session Uniqueness
  Scenario: unique constraint
    Given sessions has remote session for project_id=1
    When INSERT sessions (source='remote', project_id=1) attempted
    Then UNIQUE CONSTRAINT violation raised on idx_sessions_project_remote

  Scenario: remote survives disconnect
    Given sessions WHERE id=X AND source='remote' AND status='active'
    When UPDATE sessions SET status='inactive' WHERE id=X  // via markDisconnected
    Then SELECT * FROM sessions WHERE id=X RETURNS 1 row with status='inactive'

Feature: FR-4 Work Summary on Exit
  Scenario: full flow
    Given session_id=42 source='local' status='active'
    And messages: 15 rows for session 42
    And permission_requests: 8 rows for session 42
    When POST /api/sessions/42/summarize-work
    Then SELECT FROM memories WHERE type='project_context' AND session_id IS NULL RETURNS new row
    And SELECT FROM messages WHERE session_id=42 AND archived_at IS NULL RETURNS 0 rows
    And SELECT FROM sessions WHERE id=42 RETURNS row with status='terminated'

  Scenario: skip empty session
    Given session_id=43 with 2 messages
    When POST /api/sessions/43/summarize-work
    Then response.skipped = 'too_few_messages'
    And memories unchanged

Feature: FR-7 Session Switch Briefing
  Scenario: briefing exists
    Given memories has row type='project_context' project_path='/proj'
    And target session has project_path='/proj'
    When user triggers switch to target session
    Then bot sends message containing memory content
    And switchContextCache.get(chatId) IS NOT NULL

  Scenario: briefing absent
    Given memories has no rows for target project_path
    When user triggers switch
    Then switch completes, no briefing message sent
    And switchContextCache.get(chatId) IS NULL

Feature: FR-8 Semantic Search
  Scenario: MCP tool ranked results
    Given 20 memories rows for project_path='/proj' with embeddings
    When search_project_context({query:"session arch", limit:5})
    Then response.length = 5
    And response[0].score >= response[1].score
    And response[*].type IN ('project_context','summary')

Feature: TTL Cleanup
  Scenario: archived messages deleted after TTL
    Given messages row with archived_at = now() - 31 days
    When TTL cleanup job runs with TTL_DAYS=30
    Then SELECT FROM messages WHERE id=X RETURNS 0 rows
```
