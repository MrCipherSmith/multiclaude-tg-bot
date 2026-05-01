# Data Models

## Database Overview

Helyx uses **PostgreSQL 16** with the **pgvector** extension for similarity search on long-term memory embeddings. All schema changes are managed through a custom migration framework defined entirely in `memory/db.ts` — there is no separate ORM or migration tool. Every migration runs inside an explicit transaction, and a `schema_versions` table records which versions have been applied.

The current schema version is **v43**. Version numbers jump from v22 to v39 — the Skills Toolkit migrations were originally numbered v23–v27 but were renumbered v39–v43 during a rebase (commit `fe5380e`). This is intentional and documented.

The postgres.js library is used for all queries via tagged template literals. Raw SQL (`tx.unsafe()`) is restricted to DDL that requires dynamic interpolation (HNSW index creation, trigger DDL, dedup index with WHERE clauses).

---

## Schema by Domain

### Sessions & Routing

#### `sessions`

Created in v1; extended by v3, v4, v7, v12, v18.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `SERIAL` | PRIMARY KEY | Row 0 is the reserved standalone session |
| `name` | `TEXT` | nullable | Human-readable label |
| `project_path` | `TEXT` | nullable | Absolute filesystem path of the project |
| `client_id` | `TEXT` | UNIQUE NOT NULL | Opaque identifier sent by Claude Code client |
| `status` | `TEXT` | NOT NULL DEFAULT `'active'` | Vocabulary: `active`, `inactive`, `terminated` |
| `metadata` | `JSONB` | DEFAULT `'{}'` | Arbitrary session metadata |
| `connected_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |
| `last_active` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |
| `cli_type` | `TEXT` | NOT NULL DEFAULT `'claude'` | Added v3 |
| `cli_config` | `JSONB` | NOT NULL DEFAULT `'{}'` | Added v3; CLI-specific configuration |
| `project` | `TEXT` | nullable | Added v4; basename of project dir (e.g. `"helyx"`) |
| `source` | `TEXT` | NOT NULL DEFAULT `'standalone'` | Added v4; `remote` / `local` / `standalone` |
| `project_id` | `INT` | FK → `projects(id)` | Added v7; nullable |
| `lease_owner` | `VARCHAR(100)` | nullable | Added v12; identifies which process holds the session lease |
| `lease_expires_at` | `TIMESTAMPTZ` | nullable | Added v12 |
| `pane_snapshot` | `TEXT` | nullable | Added v18; last captured tmux pane content |
| `pane_snapshot_at` | `TIMESTAMPTZ` | nullable | Added v18; timestamp of last pane capture |

**Indexes:** `client_id` (UNIQUE), `cli_type`, `(project, source)`, `project_id`, `UNIQUE (project_id) WHERE source = 'remote'` (one remote session per project).

**Written by:** `bot.ts` on new Claude Code connection, session supervisor.
**Read by:** channel poller, status manager, bot commands, supervisor.

---

#### `chat_sessions`

Created in v1.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `chat_id` | `TEXT` | PRIMARY KEY | Telegram chat ID |
| `active_session_id` | `INT` | NOT NULL FK → `sessions(id)` DEFAULT 0 | Points to the currently active session for this chat |

**Written by:** bot routing logic when a user switches projects.
**Read by:** channel poller, message router.

---

#### `projects`

Created in v6; extended by v7, v13.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `SERIAL` | PRIMARY KEY | |
| `name` | `TEXT` | UNIQUE NOT NULL | Short project identifier |
| `path` | `TEXT` | UNIQUE NOT NULL | Absolute filesystem path |
| `tmux_session_name` | `TEXT` | NOT NULL | tmux session name used to attach to this project |
| `config` | `JSONB` | NOT NULL DEFAULT `'{}'` | Project-level config overrides |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |
| `forum_topic_id` | `INTEGER` | nullable | Added v13; Telegram forum thread ID for this project |

**Indexes:** `path`, `name`, `forum_topic_id WHERE NOT NULL`.

**Written by:** project registration commands.
**Read by:** session routing, status manager, forum-topic mapping.

---

#### `admin_commands`

Created in v5.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `BIGSERIAL` | PRIMARY KEY | |
| `command` | `TEXT` | NOT NULL | Command name (e.g. `proj_start`, `proj_stop`) |
| `payload` | `JSONB` | NOT NULL DEFAULT `'{}'` | Command arguments |
| `status` | `TEXT` | NOT NULL DEFAULT `'pending'` | `pending` / `done` / `error` |
| `result` | `TEXT` | nullable | Output or error message after execution |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |
| `executed_at` | `TIMESTAMPTZ` | nullable | |

**Index:** `(status, created_at)`.

**Written by:** Telegram bot command handlers.
**Read by:** admin-daemon polling loop.

---

#### `process_health`

Created in v17.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `name` | `TEXT` | PRIMARY KEY | Process name, e.g. `"admin-daemon"`, `"docker:helyx-bot-1"` |
| `status` | `TEXT` | NOT NULL | `healthy` / `degraded` / `down` |
| `detail` | `JSONB` | nullable | Structured details (uptime, error, etc.) |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |

**Written by:** admin-daemon heartbeat every 30 seconds.
**Read by:** `/monitor` bot command.

---

#### `supervisor_incidents`

Created in v21.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `BIGSERIAL` | PRIMARY KEY | |
| `incident_type` | `TEXT` | NOT NULL | Type of incident detected |
| `project` | `TEXT` | nullable | Project name |
| `session_id` | `BIGINT` | nullable | Associated session |
| `detected_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |
| `resolved_at` | `TIMESTAMPTZ` | nullable | |
| `action_taken` | `TEXT` | nullable | What the supervisor did |
| `result` | `TEXT` | nullable | Outcome |
| `llm_explanation` | `TEXT` | nullable | LLM-generated explanation of the incident |

**Index:** `(detected_at DESC)`.

**Written by:** session supervisor on incident detection.
**Read by:** `/monitor` command (shows incident_count).

---

### Messages & Queue

#### `messages`

Created in v1; extended by v7.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `BIGSERIAL` | PRIMARY KEY | |
| `session_id` | `INT` | NOT NULL FK → `sessions(id)` DEFAULT 0 | |
| `chat_id` | `TEXT` | NOT NULL | Telegram chat ID |
| `role` | `TEXT` | NOT NULL | `user` / `assistant` |
| `content` | `TEXT` | NOT NULL | Message text |
| `metadata` | `JSONB` | DEFAULT `'{}'` | Tool calls, attachments, etc. |
| `project_path` | `TEXT` | nullable | Denormalized project path for cross-session history queries |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |
| `archived_at` | `TIMESTAMPTZ` | nullable | Added v7; soft-delete marker (set during summarization) |

**Indexes:** `(session_id, chat_id, created_at)`, `(project_path, chat_id, created_at)`, `archived_at WHERE NOT NULL`.

**Written by:** `short-term.ts → addMessage()`.
**Read by:** `short-term.ts → getContext()`, `getProjectHistory()`, summarizer.

---

#### `message_queue`

Created in v1; extended by v11, v19.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `BIGSERIAL` | PRIMARY KEY | |
| `session_id` | `INT` | NOT NULL FK → `sessions(id)` | |
| `chat_id` | `TEXT` | NOT NULL | Destination Telegram chat |
| `from_user` | `TEXT` | NOT NULL | Originating user identifier |
| `content` | `TEXT` | NOT NULL | Message body |
| `message_id` | `TEXT` | nullable | Telegram message ID being replied to |
| `delivered` | `BOOLEAN` | NOT NULL DEFAULT false | |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |
| `attachments` | `JSONB` | nullable | Added v11; file attachments |

**Indexes:** `(session_id, delivered, created_at)`, UNIQUE `(chat_id, message_id) WHERE message_id IS NOT NULL AND message_id NOT IN ('', 'tool')` (dedup, v19).

**Trigger (v2):** `notify_message_queue()` fires `pg_notify('message_queue_{session_id}', id::text)` on INSERT. The channel poller in `channel/poller.ts` uses `LISTEN` on this channel for instant delivery without polling.

**Written by:** Claude Code session output handler.
**Read by:** channel poller, delivery worker.

---

#### `request_logs`

Created in v1.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `BIGSERIAL` | PRIMARY KEY | |
| `session_id` | `INT` | FK → `sessions(id)` | nullable |
| `chat_id` | `TEXT` | NOT NULL | |
| `level` | `TEXT` | NOT NULL DEFAULT `'info'` | `info` / `warn` / `error` |
| `stage` | `TEXT` | NOT NULL | Named pipeline stage (e.g. `"routing"`, `"tool-call"`) |
| `message` | `TEXT` | NOT NULL | |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |

**Index:** `(session_id, created_at)`.

**Written by:** request pipeline logging points.
**Read by:** debug/diagnostic tooling.

---

#### `pending_replies`

Created in v14.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `SERIAL` | PRIMARY KEY | |
| `session_id` | `INTEGER` | nullable | |
| `chat_id` | `TEXT` | NOT NULL | |
| `thread_id` | `INTEGER` | nullable | Forum thread ID |
| `text` | `TEXT` | NOT NULL | Reply body |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |
| `delivered_at` | `TIMESTAMPTZ` | nullable | Set when successfully delivered to Telegram |

**Index:** `created_at WHERE delivered_at IS NULL`.

**Purpose:** Delivery buffer — outgoing replies survive temporary bot or Telegram downtime.

---

#### `active_status_messages`

Created in v14.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `key` | `TEXT` | PRIMARY KEY | Composite key identifying the status message |
| `chat_id` | `TEXT` | NOT NULL | |
| `thread_id` | `INTEGER` | nullable | |
| `message_id` | `INTEGER` | NOT NULL | Telegram message ID to edit |
| `started_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |
| `project_name` | `TEXT` | NOT NULL | |
| `session_id` | `INTEGER` | nullable | |

**Index:** `updated_at`.

**Purpose:** Tracks live "thinking…" status messages in Telegram so the bot can edit or delete them after restart.

---

#### `poll_sessions`

Created in v15.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `SERIAL` | PRIMARY KEY | |
| `session_id` | `INT` | NOT NULL FK → `sessions(id)` | |
| `chat_id` | `TEXT` | NOT NULL | |
| `title` | `TEXT` | nullable | |
| `questions` | `JSONB` | NOT NULL | Array of poll question objects |
| `telegram_poll_ids` | `JSONB` | NOT NULL DEFAULT `'[]'` | Telegram poll message IDs |
| `answers` | `JSONB` | NOT NULL DEFAULT `'{}'` | Accumulated user responses |
| `submit_message_id` | `INT` | nullable | |
| `status` | `TEXT` | NOT NULL DEFAULT `'pending'` | `pending` / `completed` / `cancelled` |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | |

**Index:** `(chat_id, status)`.

---

#### `voice_status_messages`

Created in v20.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `BIGSERIAL` | PRIMARY KEY | |
| `chat_id` | `TEXT` | NOT NULL | |
| `thread_id` | `INT` | nullable | |
| `message_id` | `BIGINT` | NOT NULL | Telegram message ID |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |

**Purpose:** Tracks in-flight voice download/transcription status messages. Inserted when voice handling starts, deleted on completion. On startup, orphaned rows are edited to a "bot restarted" warning message.

---

### Memory

#### `memories`

Created in v1; extended by v8 (composite index), v9 (TTL column).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `BIGSERIAL` | PRIMARY KEY | |
| `source` | `TEXT` | NOT NULL | `telegram` / `cli` / `api` |
| `session_id` | `INT` | FK → `sessions(id)` | nullable |
| `chat_id` | `TEXT` | nullable | |
| `type` | `TEXT` | NOT NULL | `fact` / `summary` / `decision` / `note` / `project_context` |
| `content` | `TEXT` | NOT NULL | Memory text |
| `tags` | `TEXT[]` | DEFAULT `'{}'` | Free-form tags; searched with `&&` (overlap) or `@>` (containment) |
| `project_path` | `TEXT` | nullable | Scopes the memory to a project |
| `embedding` | `vector(768)` | nullable | pgvector embedding; NULL when Ollama is unreachable at write time |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | Updated on smart-reconcile merge |
| `archived_at` | `TIMESTAMPTZ` | nullable | Added v9; soft-delete / TTL marker |

**Indexes:**
- `idx_memories_source` — B-tree on `source`
- `idx_memories_tags` — GIN on `tags` (array overlap queries)
- `idx_memories_session` — B-tree on `session_id`
- `idx_memories_project_path` — B-tree on `project_path`
- `idx_memories_embedding` — HNSW on `embedding vector_cosine_ops` (cosine similarity ANN search)
- `idx_memories_type_project` — B-tree on `(type, project_path)` (added v8)
- `idx_memories_archived_at` — partial B-tree on `archived_at WHERE NOT NULL` (added v9)

**Written by:** `long-term.ts → remember()`, `rememberSmart()`, summarizer (facts, summaries, project_context).
**Read by:** `long-term.ts → recall()`, `listMemories()`, `hasProjectKnowledge()`.

---

#### `messages` (short-term context)

See [Messages & Queue → messages](#messages) above. The short-term module (`short-term.ts`) reads from this table via `getContext()` and maintains an in-memory LRU cache (bounded at `SHORT_TERM_WINDOW * 2` messages per session/chat pair, default 40). Rows are soft-archived (`archived_at = now()`) after summarization, keeping only the last `SHORT_TERM_WINDOW` rows (default 20) live.

---

### Skills Toolkit

All Skills Toolkit tables were added in migrations v39–v43 and include `down` rollback blocks.

#### `skill_preprocess_log`

Migration v39.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `BIGSERIAL` | PRIMARY KEY | |
| `skill_name` | `TEXT` | NOT NULL | Name of the skill that was preprocessed |
| `started_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |
| `duration_ms` | `INTEGER` | NOT NULL | |
| `shell_count` | `INTEGER` | NOT NULL DEFAULT 0 | Number of shell commands extracted |
| `errors_count` | `INTEGER` | NOT NULL DEFAULT 0 | |
| `first_error` | `TEXT` | nullable | First error message if any |

**Index:** `started_at DESC`.

**Written by:** skill preprocessing pipeline.
**Read by:** Skills Toolkit diagnostics.

---

#### `agent_created_skills`

Migration v40.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `BIGSERIAL` | PRIMARY KEY | |
| `name` | `TEXT` | UNIQUE NOT NULL | Skill identifier |
| `description` | `TEXT` | NOT NULL | What the skill does |
| `body` | `TEXT` | NOT NULL | Skill definition / prompt body |
| `status` | `TEXT` | NOT NULL DEFAULT `'proposed'` | `proposed` / `approved` / `rejected` |
| `source_session_id` | `BIGINT` | nullable | Session that proposed the skill |
| `source_chat_id` | `TEXT` | nullable | Chat that proposed the skill |
| `tags` | `TEXT[]` | DEFAULT `ARRAY[]::TEXT[]` | |
| `related_skills` | `TEXT[]` | DEFAULT `ARRAY[]::TEXT[]` | Names of related or superseded skills |
| `use_count` | `INTEGER` | NOT NULL DEFAULT 0 | Incremented each time the skill is invoked |
| `last_used_at` | `TIMESTAMPTZ` | nullable | |
| `pinned` | `BOOLEAN` | NOT NULL DEFAULT false | Prevents curator from archiving |
| `proposed_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |
| `approved_at` | `TIMESTAMPTZ` | nullable | |
| `rejected_at` | `TIMESTAMPTZ` | nullable | |
| `archived_at` | `TIMESTAMPTZ` | nullable | Soft-delete |

**Indexes:** `name`, `(status, last_used_at DESC)`, `source_session_id`.

**Written by:** `propose_skill` MCP tool, curator.
**Read by:** `list_agent_skills`, `skill_view`, `save_skill` MCP tools, curator.

---

#### `aux_llm_invocations`

Migration v41.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `BIGSERIAL` | PRIMARY KEY | |
| `purpose` | `TEXT` | NOT NULL | Why the LLM was called (e.g. `"reconcile"`, `"summarize"`) |
| `provider` | `TEXT` | NOT NULL | `anthropic` / `ollama` |
| `model` | `TEXT` | NOT NULL | Model name |
| `tokens_in` | `INTEGER` | NOT NULL | |
| `tokens_out` | `INTEGER` | NOT NULL | |
| `cost_usd` | `NUMERIC(10,6)` | nullable | |
| `duration_ms` | `INTEGER` | NOT NULL | |
| `status` | `TEXT` | NOT NULL | `ok` / `error` |
| `error_message` | `TEXT` | nullable | |
| `related_id` | `BIGINT` | nullable | FK-by-convention to related entity (e.g. a skill ID) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |

**Indexes:** `created_at DESC`, `purpose`.

**Written by:** any auxiliary LLM call (memory reconciliation, summarization, curator).
**Read by:** cost tracking, diagnostics.

---

#### `agent_skill_use_log`

> **Note:** Referenced in the analysis artifact as part of the Skills Toolkit domain. The table is not present in the v39–v43 migration blocks in `db.ts` — it may be tracked via `agent_created_skills.use_count` and `last_used_at` instead of a separate log table.

---

#### `curator_runs`

Migration v42.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `BIGSERIAL` | PRIMARY KEY | |
| `started_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |
| `finished_at` | `TIMESTAMPTZ` | nullable | |
| `duration_ms` | `INTEGER` | nullable | |
| `status` | `TEXT` | NOT NULL | `running` / `done` / `error` |
| `skills_examined` | `INTEGER` | NOT NULL DEFAULT 0 | |
| `skills_pinned` | `INTEGER` | NOT NULL DEFAULT 0 | |
| `skills_archived` | `INTEGER` | NOT NULL DEFAULT 0 | |
| `skills_proposed_consolidate` | `INTEGER` | NOT NULL DEFAULT 0 | |
| `skills_proposed_patch` | `INTEGER` | NOT NULL DEFAULT 0 | |
| `aux_llm_cost_usd` | `NUMERIC(10,6)` | nullable | Total LLM cost for this run |
| `error_message` | `TEXT` | nullable | |
| `summary` | `TEXT` | nullable | Human-readable run summary |

**Index:** `started_at DESC`.

**Written by:** curator job.
**Read by:** `curator_status` MCP tool, Telegram curator report.

---

#### `curator_pending_actions`

Migration v43.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `BIGSERIAL` | PRIMARY KEY | |
| `run_id` | `BIGINT` | NOT NULL FK → `curator_runs(id)` ON DELETE CASCADE | |
| `skill_name` | `TEXT` | NOT NULL | |
| `action` | `TEXT` | NOT NULL | `consolidate` / `patch` |
| `reason` | `TEXT` | nullable | Why this action was proposed |
| `status` | `TEXT` | NOT NULL DEFAULT `'pending'` | `pending` / `approved` / `skipped` |
| `telegram_chat_id` | `TEXT` | nullable | Where the approval prompt was sent |
| `telegram_message_id` | `BIGINT` | nullable | Telegram message ID of the approval prompt |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |
| `decided_at` | `TIMESTAMPTZ` | nullable | When the user approved or skipped |

**Index:** `(status, created_at DESC)`.

**Purpose:** Human-approval queue for risky curator actions (consolidate, patch). Rows expire implicitly after 24 hours — `getPendingCuratorActions()` filters by `created_at > now() - interval '24 hours'`.

**Written by:** curator job after generating risky proposals.
**Read by:** Telegram inline button handler (`[Approve]` / `[Skip]`).

---

### Stats

#### `api_request_stats`

Created in v1.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `BIGSERIAL` | PRIMARY KEY | |
| `session_id` | `INT` | FK → `sessions(id)` | nullable |
| `chat_id` | `TEXT` | nullable | |
| `provider` | `TEXT` | NOT NULL | `anthropic` / `ollama` |
| `model` | `TEXT` | NOT NULL | |
| `operation` | `TEXT` | NOT NULL | Named operation (e.g. `"generate"`, `"embed"`) |
| `duration_ms` | `INT` | NOT NULL | |
| `status` | `TEXT` | NOT NULL | `ok` / `error` |
| `input_tokens` | `INT` | nullable | |
| `output_tokens` | `INT` | nullable | |
| `total_tokens` | `INT` | nullable | |
| `error_message` | `TEXT` | nullable | |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |

**Indexes:** `created_at`, `session_id`.

**Written by:** LLM call wrappers.
**Read by:** `/stats` bot command, cost dashboards.

---

#### `transcription_stats`

Created in v1.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `BIGSERIAL` | PRIMARY KEY | |
| `session_id` | `INT` | FK → `sessions(id)` | nullable |
| `chat_id` | `TEXT` | nullable | |
| `provider` | `TEXT` | NOT NULL | Transcription provider (e.g. `"whisper"`) |
| `duration_ms` | `INT` | NOT NULL | Processing time |
| `audio_duration_sec` | `INT` | nullable | Length of the audio clip |
| `status` | `TEXT` | NOT NULL | `ok` / `error` |
| `error_message` | `TEXT` | nullable | |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |

**Index:** `created_at`.

**Written by:** voice handler on transcription completion.
**Read by:** `/stats` bot command.

---

### Config

#### `bot_config`

Created in v13.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `key` | `TEXT` | PRIMARY KEY | Config key |
| `value` | `TEXT` | NOT NULL | Config value (always TEXT; callers parse as needed) |
| `updated_at` | `TIMESTAMPTZ` | DEFAULT now() | |

**Seeded rows:** `forum_chat_id` (empty string when not configured).

**Written by:** bot admin commands, setup flow.
**Read by:** forum-topic routing, status manager.

---

### Permissions

#### `permission_requests`

Created in v1; extended by v7, v10, v16.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `TEXT` | PRIMARY KEY | Tool call ID from Claude Code |
| `session_id` | `INT` | NOT NULL | (no FK constraint in v1; session-scoped) |
| `chat_id` | `TEXT` | NOT NULL | |
| `tool_name` | `TEXT` | NOT NULL | Name of the tool requiring permission |
| `description` | `TEXT` | NOT NULL | Human-readable description of the action |
| `response` | `TEXT` | nullable | `allow` / `deny` |
| `message_id` | `INT` | nullable | Telegram message ID of the approval prompt |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | |
| `archived_at` | `TIMESTAMPTZ` | nullable | Added v7; soft-delete |
| `status` | `TEXT` | NOT NULL DEFAULT `'pending'` | Added v10; `pending` / `approved` / `rejected` / `expired` |
| `tmux_target` | `TEXT` | nullable | Added v16; tmux pane target for terminal-intercepted permissions |

**Indexes:** `archived_at WHERE NOT NULL`, `status`.

**Written by:** Claude Code permission hook, Telegram inline button handler.
**Read by:** summarizer (included in work-session summary), permission gating middleware.

**Auto-approve patterns:** The permission system supports auto-approve rules configured outside the database (in settings/config files). The `permission_requests` table only records the gate events; auto-approve decisions do not insert rows.

---

## Running Migrations

### Bootstrap

On every process start, `migrate()` in `memory/db.ts` is called. It:

1. Creates `schema_versions (version INT PK, name TEXT, applied_at TIMESTAMPTZ)` if it does not exist.
2. Queries `SELECT max(version)` to find the current schema version (returns 0 on an empty database).
3. Runs `validateMigrationRegistry()` — checks that all versions are positive integers, unique, and strictly ascending in array order. Throws on first violation.
4. Filters `migrations` to those with `version > current` and applies each in array order.
5. Each migration runs inside a transaction: the `up()` function executes its DDL, then a row is inserted into `schema_versions` atomically.

### Adding a migration

1. Append a new entry to the `migrations` array in `memory/db.ts`.
2. Assign the next sequential version number (currently: next would be **v44**).
3. Write the `up` function. Use `tx` (typed template literal) for normal DML/DDL; use `tx.unsafe()` only when dynamic interpolation is required.
4. Optionally add a `down` function for reversible changes.
5. Restart the process — `migrate()` will pick up and apply the new migration.

### Version number gap

Versions v23–v38 do not exist. The Skills Toolkit migrations were renumbered from v23–v27 to v39–v43 during a rebase. This is safe because migration selection uses `version > max(applied_version)`, not a contiguous range check.

### Rollback

There is no automatic rollback runner. The `down` functions (present on v39–v43) are intended to be called manually when reverting a PR with `git revert`. No tooling automates this step.

---

## pgvector Indexes

| Table | Column | Dimensions | Index Type | Distance Metric | Usage |
|---|---|---|---|---|---|
| `memories` | `embedding` | 768 | HNSW | Cosine (`vector_cosine_ops`) | `recall()`, `rememberSmart()` similarity search |

### Configuration

- **Model:** `nomic-embed-text` (configurable via `EMBEDDING_MODEL` env var)
- **Dimensions:** 768 (hardcoded in `config.ts` as `VECTOR_DIMENSIONS`)
- **Backend:** Ollama HTTP API at `OLLAMA_URL/api/embed`
- **HNSW parameters:** defaults — `m=16` (max connections per node), `ef_construction=64` (build-time search width). Increase both for higher recall at the cost of build time and memory. Query-time accuracy is controlled by `SET hnsw.ef_search` (PostgreSQL default: 40).
- **Distance operator:** `<=>` (cosine distance). Lower value = more similar.

### Similarity search pattern

```sql
SELECT *, embedding <=> $vec AS distance
FROM memories
WHERE archived_at IS NULL
  [AND project_path = $path]
  [AND type = $type]
  [AND tags && $tags]
ORDER BY embedding <=> $vec
LIMIT $limit
```

### Null embeddings

`embedSafe()` returns `null` instead of throwing when Ollama is unreachable. Rows written during an Ollama outage have `embedding = NULL` and are silently excluded from similarity searches (the `ORDER BY embedding <=> $vec` expression returns NULL for these rows, which PostgreSQL sorts last). They remain queryable by exact filters (`type`, `tags`, `project_path`).
