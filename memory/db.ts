import postgres from "postgres";
import { CONFIG } from "../config.ts";

export const sql = postgres(CONFIG.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

// --- Migration framework ---

interface Migration {
  version: number;
  name: string;
  up: (tx: postgres.TransactionSql) => Promise<void>;
  // Optional rollback. Not invoked automatically — exists so `git revert` of a
  // schema-changing PR can be paired with a manual rollback step. Migrations
  // without `down` are forward-only.
  down?: (tx: postgres.TransactionSql) => Promise<void>;
}

async function ensureVersionTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

async function getCurrentVersion(): Promise<number> {
  const [row] = await sql`SELECT max(version)::int as v FROM schema_versions`;
  return row?.v ?? 0;
}

async function applyMigration(m: Migration): Promise<void> {
  await sql.begin(async (tx) => {
    await m.up(tx);
    await tx`INSERT INTO schema_versions (version, name) VALUES (${m.version}, ${m.name})`;
  });
  console.log(`[db] migration ${m.version}: ${m.name}`);
}

// --- Migrations ---

const migrations: Migration[] = [
  {
    version: 1,
    name: "baseline schema",
    up: async (tx) => {
      await tx`CREATE EXTENSION IF NOT EXISTS vector`;

      await tx`
        CREATE TABLE IF NOT EXISTS sessions (
          id SERIAL PRIMARY KEY,
          name TEXT,
          project_path TEXT,
          client_id TEXT UNIQUE NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          metadata JSONB DEFAULT '{}',
          connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_active TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;

      await tx`
        INSERT INTO sessions (id, name, project_path, client_id, status)
        VALUES (0, 'standalone', NULL, '__standalone__', 'active')
        ON CONFLICT (id) DO NOTHING
      `;

      await tx`SELECT setval('sessions_id_seq', GREATEST((SELECT MAX(id) FROM sessions), 1))`;

      await tx`
        CREATE TABLE IF NOT EXISTS chat_sessions (
          chat_id TEXT PRIMARY KEY,
          active_session_id INT NOT NULL REFERENCES sessions(id) DEFAULT 0
        )
      `;

      await tx`
        CREATE TABLE IF NOT EXISTS messages (
          id BIGSERIAL PRIMARY KEY,
          session_id INT NOT NULL REFERENCES sessions(id) DEFAULT 0,
          chat_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata JSONB DEFAULT '{}',
          project_path TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_messages_session_chat ON messages(session_id, chat_id, created_at)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_messages_project_path ON messages(project_path, chat_id, created_at)`;

      await tx.unsafe(`
        CREATE TABLE IF NOT EXISTS memories (
          id BIGSERIAL PRIMARY KEY,
          source TEXT NOT NULL,
          session_id INT REFERENCES sessions(id),
          chat_id TEXT,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT[] DEFAULT '{}',
          project_path TEXT,
          embedding vector(${CONFIG.VECTOR_DIMENSIONS}),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await tx`CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING gin(tags)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_memories_project_path ON memories(project_path)`;
      // HNSW index for fast approximate nearest-neighbor search on embeddings.
      // Default pgvector HNSW params: m=16 (max connections per node), ef_construction=64 (build-time search width).
      // Increase m and ef_construction for higher recall at the cost of build time and memory.
      // At query time, SET hnsw.ef_search (default 40) to trade speed for accuracy.
      await tx`CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories USING hnsw (embedding vector_cosine_ops)`;

      await tx`
        CREATE TABLE IF NOT EXISTS message_queue (
          id BIGSERIAL PRIMARY KEY,
          session_id INT NOT NULL REFERENCES sessions(id),
          chat_id TEXT NOT NULL,
          from_user TEXT NOT NULL,
          content TEXT NOT NULL,
          message_id TEXT,
          delivered BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_queue_session ON message_queue(session_id, delivered, created_at)`;

      await tx`
        CREATE TABLE IF NOT EXISTS permission_requests (
          id TEXT PRIMARY KEY,
          session_id INT NOT NULL,
          chat_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          description TEXT NOT NULL,
          response TEXT,
          message_id INT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;

      await tx`
        CREATE TABLE IF NOT EXISTS api_request_stats (
          id BIGSERIAL PRIMARY KEY,
          session_id INT REFERENCES sessions(id),
          chat_id TEXT,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          operation TEXT NOT NULL,
          duration_ms INT NOT NULL,
          status TEXT NOT NULL,
          input_tokens INT,
          output_tokens INT,
          total_tokens INT,
          error_message TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_api_stats_created ON api_request_stats(created_at)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_api_stats_session ON api_request_stats(session_id)`;

      await tx`
        CREATE TABLE IF NOT EXISTS transcription_stats (
          id BIGSERIAL PRIMARY KEY,
          session_id INT REFERENCES sessions(id),
          chat_id TEXT,
          provider TEXT NOT NULL,
          duration_ms INT NOT NULL,
          audio_duration_sec INT,
          status TEXT NOT NULL,
          error_message TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_transcription_stats_created ON transcription_stats(created_at)`;

      await tx`
        CREATE TABLE IF NOT EXISTS request_logs (
          id BIGSERIAL PRIMARY KEY,
          session_id INT REFERENCES sessions(id),
          chat_id TEXT NOT NULL,
          level TEXT NOT NULL DEFAULT 'info',
          stage TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_request_logs_session_created ON request_logs(session_id, created_at)`;
    },
  },
  {
    version: 2,
    name: "message_queue NOTIFY trigger",
    up: async (tx) => {
      // Trigger sends NOTIFY with session_id as channel name
      // channel.ts listens on `message_queue_{session_id}` for instant wake
      await tx.unsafe(`
        CREATE OR REPLACE FUNCTION notify_message_queue() RETURNS trigger AS $$
        BEGIN
          PERFORM pg_notify('message_queue_' || NEW.session_id, NEW.id::text);
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await tx.unsafe(`
        DROP TRIGGER IF EXISTS message_queue_notify ON message_queue;
        CREATE TRIGGER message_queue_notify
          AFTER INSERT ON message_queue
          FOR EACH ROW EXECUTE FUNCTION notify_message_queue();
      `);
    },
  },
  {
    version: 3,
    name: "add cli_type and cli_config to sessions",
    up: async (tx) => {
      await tx`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cli_type TEXT NOT NULL DEFAULT 'claude'`;
      await tx`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cli_config JSONB NOT NULL DEFAULT '{}'`;
      await tx`UPDATE sessions SET cli_type = 'claude' WHERE cli_type IS NULL OR cli_type = ''`;
      await tx`CREATE INDEX IF NOT EXISTS idx_sessions_cli_type ON sessions(cli_type)`;
    },
  },
  {
    version: 4,
    name: "add project and source columns to sessions",
    up: async (tx) => {
      // project: basename of the project dir (e.g. "keryx")
      // source: "remote" | "local" | "standalone"
      await tx`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project TEXT`;
      await tx`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'standalone'`;

      // Backfill: standalone session
      await tx`UPDATE sessions SET project = NULL, source = 'standalone' WHERE id = 0`;

      // Backfill existing named sessions from project_path
      await tx`
        UPDATE sessions
        SET project = regexp_replace(project_path, '^.+/', ''),
            source = CASE
              WHEN name LIKE '% · remote%' THEN 'remote'
              WHEN name LIKE '% · local%'  THEN 'local'
              ELSE 'local'
            END
        WHERE id != 0 AND project_path IS NOT NULL AND project IS NULL
      `;

      await tx`CREATE INDEX IF NOT EXISTS idx_sessions_project_source ON sessions(project, source)`;
    },
  },
  {
    version: 5,
    name: "admin_commands table",
    up: async (tx) => {
      await tx`
        CREATE TABLE IF NOT EXISTS admin_commands (
          id BIGSERIAL PRIMARY KEY,
          command TEXT NOT NULL,
          payload JSONB NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'pending',
          result TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          executed_at TIMESTAMPTZ
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_admin_commands_status ON admin_commands(status, created_at)`;
    },
  },
  {
    version: 6,
    name: "projects table",
    up: async (tx) => {
      await tx`
        CREATE TABLE IF NOT EXISTS projects (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          path TEXT NOT NULL UNIQUE,
          tmux_session_name TEXT NOT NULL,
          config JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name)`;
    },
  },
  {
    version: 7,
    name: "archival TTL + session project_id + status vocab",
    up: async (tx) => {
      // Soft-delete columns for archival
      await tx`ALTER TABLE messages ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`;
      await tx`CREATE INDEX IF NOT EXISTS idx_messages_archived ON messages(archived_at) WHERE archived_at IS NOT NULL`;

      await tx`ALTER TABLE permission_requests ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`;
      await tx`CREATE INDEX IF NOT EXISTS idx_permission_requests_archived ON permission_requests(archived_at) WHERE archived_at IS NOT NULL`;

      // Link sessions to projects
      await tx`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_id INT REFERENCES projects(id)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id)`;

      // Enforce one remote session per project
      await tx`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_project_remote ON sessions(project_id) WHERE source = 'remote'`;

      // Migrate old 'disconnected' status to new vocabulary:
      // remote sessions: inactive, local sessions: terminated
      await tx`UPDATE sessions SET status = 'inactive'   WHERE source = 'remote' AND status = 'disconnected'`;
      await tx`UPDATE sessions SET status = 'terminated' WHERE source = 'local'  AND status = 'disconnected'`;
    },
  },
  {
    version: 8,
    name: "memories type index",
    up: async (tx) => {
      await tx`CREATE INDEX IF NOT EXISTS idx_memories_type_project ON memories(type, project_path)`;
    },
  },
  {
    version: 9,
    name: "memories archived_at for TTL",
    up: async (tx) => {
      await tx`ALTER TABLE memories ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`;
      await tx`CREATE INDEX IF NOT EXISTS idx_memories_archived_at ON memories(archived_at) WHERE archived_at IS NOT NULL`;
    },
  },
  {
    version: 10,
    name: "permission_requests status column",
    up: async (tx) => {
      await tx`ALTER TABLE permission_requests ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`;
      // Backfill from existing response column
      await tx`UPDATE permission_requests SET status = 'approved' WHERE response = 'allow'`;
      await tx`UPDATE permission_requests SET status = 'rejected' WHERE response = 'deny'`;
      // Rows with no response older than 10 minutes are expired
      await tx`UPDATE permission_requests SET status = 'expired' WHERE response IS NULL AND created_at < NOW() - INTERVAL '10 minutes'`;
      await tx`CREATE INDEX IF NOT EXISTS idx_permissions_status ON permission_requests(status)`;
    },
  },
  {
    version: 11,
    name: "message_queue attachments column",
    up: async (tx) => {
      await tx`ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS attachments JSONB`;
    },
  },
  {
    version: 12,
    name: "session lease columns",
    up: async (tx) => {
      await tx`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lease_owner VARCHAR(100)`;
      await tx`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`;
    },
  },
  {
    version: 13,
    name: "forum topics support",
    up: async (tx) => {
      // Per-project forum topic (thread) ID
      await tx`ALTER TABLE projects ADD COLUMN IF NOT EXISTS forum_topic_id INTEGER`;
      await tx`CREATE INDEX IF NOT EXISTS idx_projects_forum_topic ON projects(forum_topic_id) WHERE forum_topic_id IS NOT NULL`;

      // Global bot config: stores forum_chat_id and other runtime settings
      await tx`
        CREATE TABLE IF NOT EXISTS bot_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      // Seed the forum_chat_id key (empty = not configured)
      await tx`INSERT INTO bot_config (key, value) VALUES ('forum_chat_id', '') ON CONFLICT DO NOTHING`;
    },
  },
  {
    version: 14,
    name: "active_status_messages and pending_replies",
    up: async (tx) => {
      // Tracks live Telegram status messages so the bot can recover them after restart
      await tx`
        CREATE TABLE IF NOT EXISTS active_status_messages (
          key TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          thread_id INTEGER,
          message_id INTEGER NOT NULL,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          project_name TEXT NOT NULL,
          session_id INTEGER
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_active_status_updated ON active_status_messages(updated_at)`;

      // Buffers outgoing replies so they survive temporary bot/Telegram downtime
      await tx`
        CREATE TABLE IF NOT EXISTS pending_replies (
          id SERIAL PRIMARY KEY,
          session_id INTEGER,
          chat_id TEXT NOT NULL,
          thread_id INTEGER,
          text TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          delivered_at TIMESTAMPTZ
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_pending_replies_undelivered ON pending_replies(created_at) WHERE delivered_at IS NULL`;
    },
  },
  {
    version: 15,
    name: "poll_sessions table",
    up: async (tx) => {
      await tx`
        CREATE TABLE IF NOT EXISTS poll_sessions (
          id SERIAL PRIMARY KEY,
          session_id INT NOT NULL REFERENCES sessions(id),
          chat_id TEXT NOT NULL,
          title TEXT,
          questions JSONB NOT NULL,
          telegram_poll_ids JSONB NOT NULL DEFAULT '[]',
          answers JSONB NOT NULL DEFAULT '{}',
          submit_message_id INT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ DEFAULT now()
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_poll_sessions_chat ON poll_sessions(chat_id, status)`;
    },
  },
  {
    version: 16,
    name: "permission_requests tmux_target column",
    up: async (tx) => {
      // Nullable: only set for tmux-intercepted permissions (external MCP tools in terminal)
      await tx`ALTER TABLE permission_requests ADD COLUMN IF NOT EXISTS tmux_target TEXT`;
    },
  },
  {
    version: 17,
    name: "process_health table",
    up: async (tx) => {
      // Written by admin-daemon every 30 s; read by /monitor bot command.
      // name examples: "admin-daemon", "docker:helyx-bot-1", "docker:helyx-postgres-1"
      await tx`
        CREATE TABLE IF NOT EXISTS process_health (
          name       TEXT PRIMARY KEY,
          status     TEXT NOT NULL,
          detail     JSONB,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
    },
  },
  {
    version: 18,
    name: "pane snapshot for live status",
    up: async (tx) => {
      // Written by tmux-watchdog every 5 s; read by StatusManager to show live pane activity.
      await tx`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pane_snapshot TEXT`;
      await tx`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pane_snapshot_at TIMESTAMPTZ`;
    },
  },
  {
    version: 19,
    name: "message_queue deduplication index",
    up: async (tx) => {
      // Prevents duplicate delivery when the bot restarts mid-poll (grammY re-delivers
      // unacknowledged Telegram updates, causing the same message to be inserted twice).
      // Excludes empty string and 'tool' (used for synthetic tool-command queue entries).
      await tx.unsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_msgid_dedup
        ON message_queue(chat_id, message_id)
        WHERE message_id IS NOT NULL AND message_id != '' AND message_id != 'tool'
      `);
    },
  },
  {
    version: 20,
    name: "voice_status_messages table",
    up: async (tx) => {
      // Tracks in-flight voice download/transcription status messages.
      // Inserted when handleVoice starts; deleted when done.
      // On startup, recoverStaleVoiceStatusMessages edits orphans to "⚠️ Бот перезапущен".
      await tx`
        CREATE TABLE IF NOT EXISTS voice_status_messages (
          id          BIGSERIAL PRIMARY KEY,
          chat_id     TEXT NOT NULL,
          thread_id   INT,
          message_id  BIGINT NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
    },
  },
  {
    version: 21,
    name: "supervisor_incidents table",
    up: async (tx) => {
      // Audit log for all incidents detected and handled by the session supervisor.
      // supervisor.ts writes here; /monitor reads incident_count for display.
      await tx`
        CREATE TABLE IF NOT EXISTS supervisor_incidents (
          id               BIGSERIAL PRIMARY KEY,
          incident_type    TEXT NOT NULL,
          project          TEXT,
          session_id       BIGINT,
          detected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          resolved_at      TIMESTAMPTZ,
          action_taken     TEXT,
          result           TEXT,
          llm_explanation  TEXT
        )
      `;
      await tx.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_supervisor_incidents_detected
        ON supervisor_incidents(detected_at DESC)
      `);
    },
  },
  {
    version: 22,
    name: "v1.32.1: parse-back JSONB columns corrupted by stripped ::jsonb cast",
    up: async (tx) => {
      // postgres.js v3 silently strips trailing `::jsonb` casts on parameter
      // placeholders, so writes via `${JSON.stringify(x)}::jsonb` bind the
      // value as TEXT — postgres then stores it as a JSONB **scalar string**
      // containing the stringified JSON, instead of parsing it as a JSONB
      // object. Eight call sites in v1.32.0 were affected (sessions.metadata,
      // sessions.cli_config, and admin_commands.payload across multiple
      // command emitters).
      //
      // Symptoms in DB pre-fix:
      //   jsonb_typeof(payload) = 'string'    -- wrong, should be 'object'
      //   payload::text = '"{\"foo\":\"bar\"}"'  -- doubly-quoted scalar
      //
      // Read paths were defended at the JS layer (`normalizeCLIConfig`,
      // `typeof === "string" ? JSON.parse : raw` in admin-daemon), so the
      // app didn't crash. But SQL-level filters using `payload->>'key'`
      // returned NULL on these rows, causing silent bugs:
      // `services/project-service.ts` idempotency check
      // `(payload->>'project_id')::int = ${id}` never matched, so duplicate
      // proj_start commands could pile up unnoticed.
      //
      // This migration is idempotent: re-running finds no rows whose
      // `jsonb_typeof` is still 'string' for these columns. The 1MB
      // upper bound prevents accidental processing of pathologically
      // bloated rows (none expected in v1.32.0 schema, but cheap defense).
      //
      // The three UPDATEs are written explicitly (not generated via a
      // loop with string interpolation) for two reasons:
      //   1. Avoid the `tx.unsafe()` + identifier-interpolation pattern
      //      — even with a constant table list it normalizes a footgun
      //      that future contributors may copy into untrusted contexts.
      //   2. The v1.32.0 `admin_commands` table (created in migration
      //      v5) does NOT have an `updated_at` column. A loop-driven
      //      version would either need a per-table flag (and the wrong
      //      flag value would silently hit a missing column) or assume
      //      a uniform schema across all three tables. Hardcoded SQL
      //      makes the schema-per-table contract obvious.
      await tx`
        UPDATE sessions
        SET metadata = (metadata#>>'{}')::jsonb
        WHERE jsonb_typeof(metadata) = 'string'
          AND length(metadata::text) BETWEEN 4 AND 1048576
          AND (metadata::text LIKE '"{%' OR metadata::text LIKE '"[%')
      `;
      await tx`
        UPDATE sessions
        SET cli_config = (cli_config#>>'{}')::jsonb
        WHERE jsonb_typeof(cli_config) = 'string'
          AND length(cli_config::text) BETWEEN 4 AND 1048576
          AND (cli_config::text LIKE '"{%' OR cli_config::text LIKE '"[%')
      `;
      await tx`
        UPDATE admin_commands
        SET payload = (payload#>>'{}')::jsonb
        WHERE jsonb_typeof(payload) = 'string'
          AND length(payload::text) BETWEEN 4 AND 1048576
          AND (payload::text LIKE '"{%' OR payload::text LIKE '"[%')
      `;
    },
  },
  {
    // Hermes Skills Toolkit Phase A migration. PRD numbering convention is
    // v39..v42 — local registry is sequential, so the numbers diverge but the
    // schemas match. CREATE statements are IF NOT EXISTS and each migration
    // has a `down` block, so `git revert` of the PR drops the table cleanly
    // per acceptance criteria.
    version: 23,
    name: "hermes: skill_preprocess_log table",
    up: async (tx) => {
      await tx`
        CREATE TABLE IF NOT EXISTS skill_preprocess_log (
          id BIGSERIAL PRIMARY KEY,
          skill_name TEXT NOT NULL,
          started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          duration_ms INTEGER NOT NULL,
          shell_count INTEGER NOT NULL DEFAULT 0,
          errors_count INTEGER NOT NULL DEFAULT 0,
          first_error TEXT
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS skill_preprocess_log_started_at_idx ON skill_preprocess_log (started_at DESC)`;
    },
    down: async (tx) => {
      await tx`DROP TABLE IF EXISTS skill_preprocess_log`;
    },
  },
  {
    version: 24,
    name: "hermes: agent_created_skills table",
    up: async (tx) => {
      await tx`
        CREATE TABLE IF NOT EXISTS agent_created_skills (
          id BIGSERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL,
          body TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'proposed',
          source_session_id BIGINT,
          source_chat_id TEXT,
          tags TEXT[] DEFAULT ARRAY[]::TEXT[],
          related_skills TEXT[] DEFAULT ARRAY[]::TEXT[],
          use_count INTEGER NOT NULL DEFAULT 0,
          last_used_at TIMESTAMPTZ,
          pinned BOOLEAN NOT NULL DEFAULT false,
          proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          approved_at TIMESTAMPTZ,
          rejected_at TIMESTAMPTZ,
          archived_at TIMESTAMPTZ
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS agent_created_skills_name_idx ON agent_created_skills (name)`;
      await tx`CREATE INDEX IF NOT EXISTS agent_created_skills_status_last_used_idx ON agent_created_skills (status, last_used_at DESC)`;
      await tx`CREATE INDEX IF NOT EXISTS agent_created_skills_session_idx ON agent_created_skills (source_session_id)`;
    },
    down: async (tx) => {
      await tx`DROP TABLE IF EXISTS agent_created_skills`;
    },
  },
  {
    version: 25,
    name: "hermes: aux_llm_invocations table",
    up: async (tx) => {
      await tx`
        CREATE TABLE IF NOT EXISTS aux_llm_invocations (
          id BIGSERIAL PRIMARY KEY,
          purpose TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          tokens_in INTEGER NOT NULL,
          tokens_out INTEGER NOT NULL,
          cost_usd NUMERIC(10, 6),
          duration_ms INTEGER NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          related_id BIGINT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS aux_llm_invocations_created_at_idx ON aux_llm_invocations (created_at DESC)`;
      await tx`CREATE INDEX IF NOT EXISTS aux_llm_invocations_purpose_idx ON aux_llm_invocations (purpose)`;
    },
    down: async (tx) => {
      await tx`DROP TABLE IF EXISTS aux_llm_invocations`;
    },
  },
  {
    version: 26,
    name: "hermes: curator_runs table",
    up: async (tx) => {
      await tx`
        CREATE TABLE IF NOT EXISTS curator_runs (
          id BIGSERIAL PRIMARY KEY,
          started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          finished_at TIMESTAMPTZ,
          duration_ms INTEGER,
          status TEXT NOT NULL,
          skills_examined INTEGER NOT NULL DEFAULT 0,
          skills_pinned INTEGER NOT NULL DEFAULT 0,
          skills_archived INTEGER NOT NULL DEFAULT 0,
          skills_proposed_consolidate INTEGER NOT NULL DEFAULT 0,
          skills_proposed_patch INTEGER NOT NULL DEFAULT 0,
          aux_llm_cost_usd NUMERIC(10, 6),
          error_message TEXT,
          summary TEXT
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS curator_runs_started_at_idx ON curator_runs (started_at DESC)`;
    },
    down: async (tx) => {
      await tx`DROP TABLE IF EXISTS curator_runs`;
    },
  },
  {
    version: 27,
    name: "hermes: curator_pending_actions table — human-approval queue (FR-B-6)",
    up: async (tx) => {
      // Phase B's risky actions (consolidate, patch) are queued here pending
      // user [Approve]/[Skip] in Telegram. Rows expire 24h after creation —
      // see `getPendingCuratorActions` in utils/curator.ts.
      await tx`
        CREATE TABLE IF NOT EXISTS curator_pending_actions (
          id BIGSERIAL PRIMARY KEY,
          run_id BIGINT NOT NULL REFERENCES curator_runs(id) ON DELETE CASCADE,
          skill_name TEXT NOT NULL,
          action TEXT NOT NULL,
          reason TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          telegram_chat_id TEXT,
          telegram_message_id BIGINT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          decided_at TIMESTAMPTZ
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS curator_pending_actions_status_idx ON curator_pending_actions (status, created_at DESC)`;
    },
    down: async (tx) => {
      await tx`DROP TABLE IF EXISTS curator_pending_actions`;
    },
  },
];

// --- Public API ---

/**
 * Validate the migrations registry. Catches mistakes that would otherwise
 * cause confusing runtime behavior: duplicate version numbers (only one
 * gets recorded in schema_versions, the other never runs), non-monotonic
 * ordering (a v22 placed after v25 still runs in array order, but the
 * version-comparison logic in `pending = filter(version > current)`
 * relies on max-version semantics — a v22 added back to the bottom of
 * the array would be skipped on any DB whose schema_versions already has
 * a higher version applied).
 *
 * Throws on the first violation rather than logging — migrations are
 * critical-path on startup; failing loud beats failing quietly.
 *
 * Cheap: O(N) scan over a 22-element array, runs once per process start.
 */
// Exported for unit tests so the synthetic-bad-input cases call the real
// implementation rather than a re-implementation that can drift from it.
// Default-arg form preserves the production call site `validateMigrationRegistry()`.
export function validateMigrationRegistry(input: ReadonlyArray<{ version: number }> = migrations): void {
  const versions = input.map((m) => m.version);
  // Sanity FIRST: integer + positive. The dedup and monotonicity checks
  // below assume integer inputs (Set.has uses SameValueZero, which is
  // fine for NaN, but the `<=` comparison in the monotonicity loop
  // silently mis-orders fractional / non-finite values). Catching
  // type validity up front means later checks only see well-formed input.
  for (const v of versions) {
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`[db] invalid migration version: v${v}. Must be a positive integer.`);
    }
  }
  // Duplicate detection
  const seen = new Set<number>();
  for (const v of versions) {
    if (seen.has(v)) {
      throw new Error(`[db] duplicate migration version: v${v}. Each migration must use a unique version number.`);
    }
    seen.add(v);
  }
  // Monotonic ordering — strict ascending in array
  for (let i = 1; i < versions.length; i++) {
    if (versions[i]! <= versions[i - 1]!) {
      throw new Error(
        `[db] non-monotonic migration order at index ${i}: v${versions[i]} follows v${versions[i - 1]}. ` +
          `Migrations must be ordered strictly ascending by version.`,
      );
    }
  }
}

export async function migrate() {
  validateMigrationRegistry();
  await ensureVersionTable();
  const current = await getCurrentVersion();

  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) {
    console.log(`[db] schema up to date (v${current})`);
    return;
  }

  console.log(`[db] applying ${pending.length} migration(s) from v${current} to v${pending[pending.length - 1].version}...`);
  for (const m of pending) {
    await applyMigration(m);
  }
  console.log("[db] migrations complete");
}

// Run migrations directly if this file is executed
if (import.meta.main) {
  await migrate();
  await sql.end();
  console.log("[db] done");
}
