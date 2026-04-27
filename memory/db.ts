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
    name: "add model_providers, model_profiles, and sessions.model_profile_id",
    up: async (tx) => {
      // Phase 3 scaffolding — DB-driven LLM provider routing layer.
      // Additive only: existing env-var-driven provider detection in claude/client.ts
      // remains the fallback when sessions.model_profile_id IS NULL.

      // --- model_providers: registry of LLM provider configurations ---
      await tx`
        CREATE TABLE IF NOT EXISTS model_providers (
          id            SERIAL PRIMARY KEY,
          name          TEXT NOT NULL UNIQUE,
          provider_type TEXT NOT NULL,
          base_url      TEXT,
          api_key_env   TEXT,
          default_model TEXT,
          enabled       BOOLEAN NOT NULL DEFAULT true,
          metadata      JSONB NOT NULL DEFAULT '{}',
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_model_providers_type ON model_providers(provider_type)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_model_providers_enabled ON model_providers(enabled)`;

      // --- model_profiles: named role/configuration combinations ---
      await tx`
        CREATE TABLE IF NOT EXISTS model_profiles (
          id            SERIAL PRIMARY KEY,
          name          TEXT NOT NULL UNIQUE,
          provider_id   INTEGER NOT NULL REFERENCES model_providers(id) ON DELETE RESTRICT,
          model         TEXT NOT NULL,
          max_tokens    INTEGER,
          temperature   REAL,
          system_prompt TEXT,
          metadata      JSONB NOT NULL DEFAULT '{}',
          enabled       BOOLEAN NOT NULL DEFAULT true,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_model_profiles_provider ON model_profiles(provider_id)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_model_profiles_enabled ON model_profiles(enabled)`;

      // --- Bootstrap rows mirroring current env-var-driven providers ---
      // These are placeholders; users edit them later via /providers command.
      // ON CONFLICT (name) DO NOTHING keeps the migration idempotent.
      await tx`
        INSERT INTO model_providers (name, provider_type, base_url, api_key_env, default_model)
        VALUES
          ('Anthropic',  'anthropic',     NULL,                                                       'ANTHROPIC_API_KEY',  'claude-sonnet-4-6'),
          ('OpenRouter', 'openai',        'https://openrouter.ai/api/v1',                             'OPENROUTER_API_KEY', 'qwen/qwen3-235b-a22b:free'),
          ('Google AI',  'google-ai',     'https://generativelanguage.googleapis.com/v1beta/openai',  'GOOGLE_AI_API_KEY',  'gemma-4-31b-it'),
          ('Ollama',     'ollama',        'http://localhost:11434',                                   NULL,                  'qwen3:8b'),
          ('DeepSeek',   'custom-openai', 'https://api.deepseek.com',                                 'DEEPSEEK_API_KEY',    'deepseek-chat')
        ON CONFLICT (name) DO NOTHING
      `;

      // Default profile linked to Anthropic. The runtime LLM client will fall back
      // to env-var detection when no profile is set on the session.
      await tx`
        INSERT INTO model_profiles (name, provider_id, model)
        SELECT 'default', id, COALESCE(default_model, 'claude-sonnet-4-6')
        FROM model_providers
        WHERE name = 'Anthropic'
        ON CONFLICT (name) DO NOTHING
      `;

      // --- Link sessions to a model profile (nullable for backward compat) ---
      await tx`
        ALTER TABLE sessions
        ADD COLUMN IF NOT EXISTS model_profile_id INTEGER
        REFERENCES model_profiles(id) ON DELETE SET NULL
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_sessions_model_profile ON sessions(model_profile_id)`;
    },
  },
  {
    version: 23,
    name: "agent_definitions, agent_instances, agent_tasks, agent_events + projects.default_agent_instance_id + bootstrap",
    up: async (tx) => {
      // Phase 4 Wave 1 — Agent runtime tables.
      // Additive only: no NOT NULL on existing columns, no DROP, no RENAME.
      // After migration, existing tmux windows continue to run unchanged.
      // The agent_instance rows are observers (desired_state='stopped', actual_state='new'),
      // not controllers, until someone explicitly calls setDesiredState.

      // --- agent_definitions: TEMPLATE for an agent type ---
      await tx`
        CREATE TABLE IF NOT EXISTS agent_definitions (
          id               SERIAL PRIMARY KEY,
          name             TEXT NOT NULL UNIQUE,
          description      TEXT,
          runtime_type     TEXT NOT NULL,
          runtime_driver   TEXT NOT NULL DEFAULT 'tmux',
          model_profile_id INTEGER REFERENCES model_profiles(id) ON DELETE SET NULL,
          system_prompt    TEXT,
          capabilities     JSONB NOT NULL DEFAULT '[]'::jsonb,
          config           JSONB NOT NULL DEFAULT '{}'::jsonb,
          enabled          BOOLEAN NOT NULL DEFAULT true,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_agent_definitions_runtime_type ON agent_definitions(runtime_type)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_agent_definitions_enabled ON agent_definitions(enabled)`;

      // --- agent_instances: RUNTIME instance, with desired/actual state ---
      // See R1 in analysis-report.md: this state machine is INTENTIONALLY separate from
      // sessions/state-machine.ts. A running agent_instance may have zero or one active session.
      await tx.unsafe(`
        CREATE TABLE IF NOT EXISTS agent_instances (
          id               SERIAL PRIMARY KEY,
          definition_id    INTEGER NOT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT,
          project_id       INTEGER REFERENCES projects(id) ON DELETE CASCADE,
          name             TEXT NOT NULL,
          desired_state    TEXT NOT NULL DEFAULT 'stopped'
            CHECK (desired_state IN ('running','stopped','paused')),
          actual_state     TEXT NOT NULL DEFAULT 'new'
            CHECK (actual_state IN ('new','starting','running','idle','busy','waiting_approval','stuck','stopping','stopped','failed')),
          runtime_handle   JSONB NOT NULL DEFAULT '{}'::jsonb,
          last_snapshot    TEXT,
          last_snapshot_at TIMESTAMPTZ,
          last_health_at   TIMESTAMPTZ,
          restart_count    INTEGER NOT NULL DEFAULT 0,
          last_restart_at  TIMESTAMPTZ,
          session_id       INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (project_id, name)
        )
      `);
      await tx`CREATE INDEX IF NOT EXISTS idx_agent_instances_desired ON agent_instances(desired_state)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_agent_instances_actual ON agent_instances(actual_state)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_agent_instances_project ON agent_instances(project_id)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_agent_instances_session ON agent_instances(session_id)`;

      // --- agent_tasks: work units assigned to an agent ---
      await tx.unsafe(`
        CREATE TABLE IF NOT EXISTS agent_tasks (
          id                SERIAL PRIMARY KEY,
          agent_instance_id INTEGER REFERENCES agent_instances(id) ON DELETE SET NULL,
          parent_task_id    INTEGER REFERENCES agent_tasks(id) ON DELETE SET NULL,
          title             TEXT NOT NULL,
          description       TEXT,
          status            TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','in_progress','blocked','review','done','cancelled','failed')),
          payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
          result            JSONB,
          priority          INTEGER NOT NULL DEFAULT 0,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          started_at        TIMESTAMPTZ,
          completed_at      TIMESTAMPTZ,
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await tx`CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent ON agent_tasks(agent_instance_id)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_agent_tasks_parent ON agent_tasks(parent_task_id)`;

      // --- agent_events: audit trail of state transitions and actions ---
      await tx`
        CREATE TABLE IF NOT EXISTS agent_events (
          id                SERIAL PRIMARY KEY,
          agent_instance_id INTEGER REFERENCES agent_instances(id) ON DELETE CASCADE,
          task_id           INTEGER REFERENCES agent_tasks(id) ON DELETE SET NULL,
          event_type        TEXT NOT NULL,
          from_state        TEXT,
          to_state          TEXT,
          message           TEXT,
          metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent_instance_id)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_agent_events_task ON agent_events(task_id)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_agent_events_type ON agent_events(event_type)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_agent_events_created ON agent_events(created_at)`;

      // --- projects.default_agent_instance_id: backlink to bootstrapped instance ---
      await tx`
        ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS default_agent_instance_id INTEGER
        REFERENCES agent_instances(id) ON DELETE SET NULL
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_projects_default_agent ON projects(default_agent_instance_id)`;

      // --- Bootstrap: default claude-code agent definition ---
      await tx`
        INSERT INTO agent_definitions (name, description, runtime_type, runtime_driver, model_profile_id)
        SELECT 'claude-code-default',
               'Default Claude Code agent — one per project',
               'claude-code',
               'tmux',
               (SELECT id FROM model_profiles WHERE name = 'default' LIMIT 1)
        ON CONFLICT (name) DO NOTHING
      `;

      // --- Bootstrap: one agent_instance per project ---
      // See R4 in analysis-report.md: runtime_handle uses tmux_session_name as the window name,
      // matching what admin-daemon.ts shell calls do today (tmux session "bots", window = project name).
      await tx`
        INSERT INTO agent_instances (definition_id, project_id, name, desired_state, actual_state, runtime_handle)
        SELECT
          (SELECT id FROM agent_definitions WHERE name = 'claude-code-default' LIMIT 1) AS definition_id,
          p.id   AS project_id,
          p.name AS name,
          'stopped' AS desired_state,
          'new'     AS actual_state,
          jsonb_build_object(
            'driver',      'tmux',
            'tmuxSession', 'bots',
            'tmuxWindow',  p.tmux_session_name
          ) AS runtime_handle
        FROM projects p
        WHERE NOT EXISTS (
          SELECT 1 FROM agent_instances ai
          WHERE ai.project_id = p.id AND ai.name = p.name
        )
      `;

      // --- Backlink: set projects.default_agent_instance_id to the bootstrapped instance ---
      await tx`
        UPDATE projects p
        SET default_agent_instance_id = ai.id
        FROM agent_instances ai
        WHERE ai.project_id = p.id
          AND ai.name = p.name
          AND p.default_agent_instance_id IS NULL
      `;
    },
  },
  {
    version: 24,
    name: "phase6: register codex-cli, opencode, deepseek-cli runtimes",
    up: async (tx) => {
      // Phase 6 Wave 1 — register three new agent runtime types as templates.
      // Idempotent: ON CONFLICT (name) DO NOTHING for both model_profiles and agent_definitions.

      // --- DeepSeek model_profile (so deepseek-cli-default can reference it) ---
      await tx`
        INSERT INTO model_profiles (name, provider_id, model)
        SELECT 'deepseek-default', pr.id, COALESCE(pr.default_model, 'deepseek-chat')
        FROM model_providers pr
        WHERE pr.name = 'DeepSeek'
        ON CONFLICT (name) DO NOTHING
      `;

      // --- codex-cli-default ---
      await tx`
        INSERT INTO agent_definitions (name, description, runtime_type, runtime_driver, model_profile_id, capabilities, config)
        VALUES (
          'codex-cli-default',
          'OpenAI Codex CLI agent (npx @openai/codex)',
          'codex-cli',
          'tmux',
          NULL,
          '["code","review"]'::jsonb,
          '{"launcher":"npx -y @openai/codex"}'::jsonb
        )
        ON CONFLICT (name) DO NOTHING
      `;

      // --- opencode-default ---
      await tx`
        INSERT INTO agent_definitions (name, description, runtime_type, runtime_driver, model_profile_id, capabilities, config)
        VALUES (
          'opencode-default',
          'opencode agent (open-source AI CLI)',
          'opencode',
          'tmux',
          NULL,
          '["code","review"]'::jsonb,
          '{"launcher":"opencode"}'::jsonb
        )
        ON CONFLICT (name) DO NOTHING
      `;

      // --- deepseek-cli-default ---
      await tx`
        INSERT INTO agent_definitions (name, description, runtime_type, runtime_driver, model_profile_id, capabilities, config)
        VALUES (
          'deepseek-cli-default',
          'DeepSeek REPL wrapper — calls DeepSeek API via Helyx llm client',
          'deepseek-cli',
          'tmux',
          (SELECT id FROM model_profiles WHERE name = 'deepseek-default' LIMIT 1),
          '["code","review","plan"]'::jsonb,
          '{"launcher":"bun /home/altsay/bots/helyx/scripts/deepseek-repl.ts","provider":"deepseek"}'::jsonb
        )
        ON CONFLICT (name) DO NOTHING
      `;
    },
  },
  {
    version: 25,
    name: "phase6 followup: portable launcher path in deepseek-cli-default config",
    up: async (tx) => {
      // Migration v24 stored an absolute path /home/altsay/bots/helyx/... for the
      // deepseek-cli-default launcher. The path is bypassed by run-cli.sh today
      // (which resolves $HELYX_DIR dynamically) but would break if Phase 7 reads
      // agent_definition.config.launcher to launch directly. Replace with a
      // relative path; consumers can resolve it against the helyx repo root.
      await tx`
        UPDATE agent_definitions
        SET config = jsonb_set(config, '{launcher}', '"bun scripts/deepseek-repl.ts"')
        WHERE name = 'deepseek-cli-default'
          AND config->>'launcher' = 'bun /home/altsay/bots/helyx/scripts/deepseek-repl.ts'
      `;
    },
  },
  {
    version: 26,
    name: "tech debt: add admin_commands.updated_at — fixes long-standing recovery query error",
    up: async (tx) => {
      // The stuck-command recovery query in scripts/admin-daemon.ts (line ~47) has
      // been writing to admin_commands.updated_at since before the refactor, but
      // the column never existed. Every daemon start logged a 42703 (column does
      // not exist) error. Add the column with a sensible default and an index on
      // (status, updated_at) matching the recovery filter.
      await tx`ALTER TABLE admin_commands ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`;
      // Backfill existing rows: prefer executed_at when set, else created_at
      await tx`
        UPDATE admin_commands
        SET updated_at = COALESCE(executed_at, created_at)
        WHERE updated_at < created_at OR updated_at = created_at
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_admin_commands_status_updated ON admin_commands(status, updated_at)`;
    },
  },
  {
    version: 27,
    name: "tech debt followup: properly backfill admin_commands.updated_at",
    up: async (tx) => {
      // Migration v26's backfill WHERE clause was logically vacuous — after
      // ADD COLUMN ... DEFAULT now(), every existing row had updated_at >= created_at,
      // so the v26 condition `updated_at < created_at OR = created_at` matched zero rows.
      // Result: historical rows have updated_at = v26_migration_now instead of their
      // real last-update time. Fix it: set updated_at = COALESCE(executed_at, created_at)
      // for any row that still looks untouched (updated_at within 1 second of created_at
      // would be a fresh row; otherwise it's a v26-migrated stale row).
      //
      // Idempotent: re-running this updates rows where updated_at = COALESCE(executed_at,
      // created_at) — which is a no-op since SET to the same value.
      await tx`
        UPDATE admin_commands
        SET updated_at = COALESCE(executed_at, created_at)
        WHERE updated_at <> COALESCE(executed_at, created_at)
          AND created_at < now() - interval '1 minute'
      `;
    },
  },
  {
    version: 28,
    name: "indexes for orchestrator handleFailure hot path",
    up: async (tx) => {
      // handleFailure (agents/orchestrator.ts) runs inside a FOR UPDATE
      // transaction. Two queries inside the locked window depend on indexes
      // that may not yet exist; without them, every failure-handle ticks
      // against full-table scans of agent_events / agent_definitions while
      // holding the task-row lock — bad under reconciler concurrency.
      //
      // 1. COUNT(*) FROM agent_events WHERE task_id = $ AND event_type = $
      //    needs a (task_id, event_type) composite index.
      // 2. SELECT ... FROM agent_definitions WHERE capabilities @> $::jsonb
      //    needs a GIN index on the jsonb column for containment queries.
      //
      // CONCURRENTLY is unavailable inside a transaction; using plain
      // CREATE INDEX IF NOT EXISTS instead. agent_events grows fast but
      // agent_definitions is tiny — the brief lock during creation is fine.
      // CREATE INDEX IF NOT EXISTS is also idempotent on re-run.
      await tx`CREATE INDEX IF NOT EXISTS idx_agent_events_task_event ON agent_events(task_id, event_type)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_agent_definitions_capabilities ON agent_definitions USING gin(capabilities)`;
    },
  },
  {
    version: 29,
    name: "phase12: standalone-llm agent_definitions for planner/reviewer/orchestrator",
    up: async (tx) => {
      // Three role-specific agent_definitions backed by the new
      // standalone-llm runtime adapter (scripts/standalone-llm-worker.ts).
      // model_profile_id is NULL initially; the setup wizard (or
      // `helyx setup-agents`) populates it via seedModelProfiles() —
      // see cli.ts which now also UPDATEs these definitions to point at
      // the freshly-seeded role profiles.
      await tx`
        INSERT INTO agent_definitions
          (name, description, runtime_type, runtime_driver, capabilities, config)
        VALUES
          ('planner-default',     'Planner agent — decomposes tasks into subtasks via API LLM',
           'standalone-llm', 'tmux', '["plan"]'::jsonb,
           '{"role": "planner"}'::jsonb),
          ('reviewer-default',    'Reviewer agent — reviews work products via API LLM',
           'standalone-llm', 'tmux', '["review"]'::jsonb,
           '{"role": "reviewer"}'::jsonb),
          ('orchestrator-default','Orchestrator agent — routes and coordinates tasks via API LLM',
           'standalone-llm', 'tmux', '["orchestrate", "plan", "review"]'::jsonb,
           '{"role": "orchestrator"}'::jsonb)
        ON CONFLICT (name) DO NOTHING
      `;
    },
  },
  {
    version: 30,
    name: "phase12-followup: index on agent_instances.project_id for listInstancesEnriched filter",
    up: async (tx) => {
      // F-008-followup from the PR #8 review: AgentManager.
      // listInstancesEnriched filters by `ai.project_id = ${projectId}`
      // on every dashboard agents-page render. Postgres does not auto-
      // index FK columns; without this the filter degrades to a
      // sequential scan as agent_instances grows.
      //
      // Plain CREATE INDEX (not CONCURRENTLY) — same constraint as v28
      // (no CONCURRENTLY inside sql.begin). agent_instances is small,
      // brief lock acceptable.
      await tx`CREATE INDEX IF NOT EXISTS idx_agent_instances_project_id ON agent_instances(project_id)`;
    },
  },
  {
    version: 31,
    name: "deepseek v4: migrate deepseek-chat → v4-flash, role profiles → v4-pro",
    up: async (tx) => {
      // DeepSeek deprecated `deepseek-chat` (v3) when shipping V4. The API
      // now exposes only `deepseek-v4-flash` (small/fast) and
      // `deepseek-v4-pro` (complex/reasoning). We retire the old name
      // everywhere in the seed config.
      //
      // Default model on the provider becomes flash (cheaper baseline);
      // role-bound profiles (planner / reviewer / orchestrator) — which
      // perform decompose / review / route reasoning — bind to pro.
      // Operators can override per-agent via `helyx model set <agent>
      // <profile>`.
      //
      // Two new general-purpose profiles (`deepseek-flash`, `deepseek-pro`)
      // are added so future agents can pick a tier explicitly without
      // reassigning a role-bound profile.
      await tx`
        UPDATE model_providers
        SET default_model = 'deepseek-v4-flash', updated_at = now()
        WHERE name = 'DeepSeek' AND default_model = 'deepseek-chat'
      `;
      await tx`
        INSERT INTO model_profiles (name, provider_id, model)
        SELECT 'deepseek-flash', id, 'deepseek-v4-flash' FROM model_providers WHERE name = 'DeepSeek'
        ON CONFLICT (name) DO UPDATE SET model = EXCLUDED.model, updated_at = now()
      `;
      await tx`
        INSERT INTO model_profiles (name, provider_id, model)
        SELECT 'deepseek-pro', id, 'deepseek-v4-pro' FROM model_providers WHERE name = 'DeepSeek'
        ON CONFLICT (name) DO UPDATE SET model = EXCLUDED.model, updated_at = now()
      `;
      await tx`
        UPDATE model_profiles
        SET model = 'deepseek-v4-pro', updated_at = now()
        WHERE name IN ('planner-default', 'reviewer-default', 'orchestrator-default')
          AND model = 'deepseek-chat'
      `;
      await tx`
        UPDATE model_profiles
        SET model = 'deepseek-v4-flash', updated_at = now()
        WHERE name = 'deepseek-default' AND model = 'deepseek-chat'
      `;
    },
  },
  {
    version: 32,
    name: "v1.37.0: parse-back JSONB columns corrupted by stripped ::jsonb cast",
    up: async (tx) => {
      // Critical data fix for the v1.37.0 systemic ::jsonb cast bug.
      // postgres.js v3 silently strips trailing `::jsonb` casts on
      // parameter placeholders, so writes via `${JSON.stringify(x)}::jsonb`
      // bound the value as TEXT — postgres then stored it as a JSONB
      // **scalar string** containing the stringified JSON, instead of
      // parsing it as a JSONB object/array.
      //
      // Symptoms in DB pre-fix:
      //   jsonb_typeof(payload) = 'string'   -- wrong, should be 'object'
      //   payload::text = '"{\"foo\":\"bar\"}"'  -- doubly-quoted
      //
      // For each affected column we look for rows whose top-level
      // jsonb_typeof = 'string' AND the contained text is a valid JSON
      // object or array literal — those are corrupted writes. Parse the
      // contained JSON back into proper JSONB.
      //
      // `IS JSON` predicate (PG 16+) gates the parse so any genuine
      // scalar-string values (e.g. `'"foo"'` written intentionally,
      // though we have none) survive untouched. Falls back to a plain
      // `~ '^[{[].*'` regex for older PG. We use the regex form for
      // portability — both helyx prod (PG 15) and CI use it.
      //
      // Idempotent: re-running finds zero rows because the post-update
      // jsonb_typeof is now 'object' / 'array'.
      //
      // Special case: `agent_instances.runtime_handle` for the bloated
      // 240MB row is reset directly in code (not parseable — char-map
      // chunks won't round-trip), see scripts/reset-bloated-handle.ts.

      // Tables with `updated_at`: timestamp updated alongside the parse-back.
      // agent_events and sessions have no updated_at column — emitted by
      // the if/else below.
      const tables: Array<{ table: string; column: string; hasUpdatedAt: boolean }> = [
        { table: "agent_tasks",     column: "payload",        hasUpdatedAt: true  },
        { table: "agent_tasks",     column: "result",         hasUpdatedAt: true  },
        { table: "agent_events",    column: "metadata",       hasUpdatedAt: false },
        { table: "agent_instances", column: "runtime_handle", hasUpdatedAt: true  },
        { table: "sessions",        column: "metadata",       hasUpdatedAt: false },
        { table: "sessions",        column: "cli_config",     hasUpdatedAt: false },
      ];

      for (const { table, column, hasUpdatedAt } of tables) {
        // Only rows that look like a stringified JSON object/array.
        // 4-byte length floor skips trivially small scalars; a stringified
        // `"{}"` is 4 bytes ('"{}"' is exactly 4 chars) — parseable.
        // Parseable rows must start with `"{` or `"[` after the opening
        // quote of the JSONB scalar string.
        //
        // 1MB upper cap protects against the bloated runtime_handle case:
        // re-parsing a 240MB char-map produces another 240MB JSONB object
        // (also useless garbage). Such rows are reset to '{}' below.
        const setClause = hasUpdatedAt
          ? `${column} = (${column}#>>'{}')::jsonb, updated_at = now()`
          : `${column} = (${column}#>>'{}')::jsonb`;
        await tx.unsafe(`
          UPDATE ${table}
          SET ${setClause}
          WHERE jsonb_typeof(${column}) = 'string'
            AND length(${column}::text) BETWEEN 4 AND 1048576
            AND (
              ${column}::text LIKE '"{%'
              OR ${column}::text LIKE '"[%'
            )
        `);
      }

      // Bloated rows (>1MB scalar strings) are unrecoverable: the content
      // is the char-spread artifact `{"0":"{","1":"\"",...}` from
      // accidentally spreading a string into the runtime_handle object.
      // Round-tripping just yields the same garbage. Reset to '{}' so the
      // reconciler can re-derive the handle on the next tick (pre-stamps
      // tmuxWindow from inst.name).
      await tx`
        UPDATE agent_instances
        SET runtime_handle = '{}'::jsonb, updated_at = now()
        WHERE jsonb_typeof(runtime_handle) = 'string'
          AND length(runtime_handle::text) > 1048576
      `;
    },
  },
  {
    version: 33,
    name: "v1.39.0: agent_instances per-instance system_prompt + forum_topic_id",
    up: async (tx) => {
      // Closes two architectural gaps from the v1.38.0 review:
      //
      // 1. Per-instance system prompt override — currently the prompt
      //    lives on agent_definitions and applies to every instance of
      //    the role. Operators want to tune prompts per-instance (e.g.
      //    a planner role specialized for the helyx project's coding
      //    conventions vs. the same role used elsewhere). This column
      //    is OPTIONAL — when null, the worker falls back to the
      //    definition's system_prompt as before.
      //
      // 2. Explicit forum_topic_id binding — standalone-llm agents
      //    have no implicit Telegram topic linkage (unlike claude-code
      //    agents which inherit from their session). This column lets
      //    operators bind an instance to a Telegram forum topic so
      //    task results can be auto-routed there.
      //
      // Both fields nullable / no default → safe additive change.
      await tx`
        ALTER TABLE agent_instances
        ADD COLUMN IF NOT EXISTS system_prompt_override TEXT,
        ADD COLUMN IF NOT EXISTS forum_topic_id BIGINT
      `;
    },
  },
  {
    version: 34,
    name: "v1.39.0: seed skill-based agent_definitions from goodai-base",
    up: async (tx) => {
      // Curated set of 8 reasoning-only skill definitions. Each is a
      // standalone-llm role with a focused system prompt distilled from
      // the corresponding goodai-base skill. Operators use them as
      // ready-made templates: `/agent_create helyx:planner issue-analyzer helyx`
      // instantly spawns a worker primed for issue decomposition.
      //
      // standalone-llm runtime — these roles reason, plan, and produce
      // structured text. They do NOT need filesystem/Bash tools (those
      // would require runtime_type='claude-code' with --append-system-prompt
      // plumbing, deferred to a later release).
      //
      // Capabilities are tagged for orchestrator capability-routing —
      // calling `selectAgent(["decompose"])` will match the issue-analyzer
      // role, etc. ON CONFLICT (name) DO NOTHING keeps the seed
      // idempotent across re-runs.

      const seeds: Array<{
        name: string;
        description: string;
        capabilities: string[];
        prompt: string;
      }> = [
        {
          name: "issue-analyzer",
          description: "Decompose a GitHub issue / feature request into atomic implementable tasks.",
          capabilities: ["plan", "decompose", "issue-management"],
          prompt: `You are an issue analyzer. You receive a feature description, bug report, or GitHub issue and decompose it into a small set (3-7) of atomic, independently-implementable tasks.

For each task, produce:
- title (under 100 chars, imperative form)
- description (what to do, not how)
- capabilities (drawn from: code, review, plan, debug, test, design, document, orchestrate)
- priority (0-10, with 0 = highest urgency)

Output a JSON object with shape:
{
  "subtasks": [
    { "title": "...", "description": "...", "capabilities": [...], "priority": 5 }
  ]
}

Rules:
- Each task must be doable in isolation. No "and then..." chains.
- Prefer 3-5 tasks for typical features. Up to 7 for genuinely complex ones.
- Skip orchestration / setup tasks unless they require non-trivial work.
- Be terse — no flowery language, no apologies, no preamble.`,
        },
        {
          name: "brainstorm",
          description: "Open-ended exploration of architecture decisions, tech choices, or feature ideas with multiple perspectives.",
          capabilities: ["plan", "explore", "design"],
          prompt: `You are a brainstorming partner. The operator brings a question that benefits from multiple perspectives — architecture choices, tech selection, feature ideation, tradeoff analysis.

Output structure:
1. Restate the problem in one sentence to confirm understanding.
2. List 3-5 distinct approaches/options. For each:
   - the core idea (one line)
   - what it optimizes for
   - what it trades away
3. Identify ONE recommended approach with two-sentence justification, OR explicitly state "this depends on [decision] which I cannot resolve" and list what would inform the choice.

Avoid:
- Endorsing every option equally (cowardice).
- Adding options nobody would seriously consider (padding).
- Long preamble. Get to the options fast.`,
        },
        {
          name: "prd-creator",
          description: "Convert a vague feature request into a formal, testable Product Requirements Document.",
          capabilities: ["plan", "document", "spec"],
          prompt: `You are a PRD writer. You receive a vague or unstructured request and produce a formal Product Requirements Document.

Output sections (in order, headed with "## "):
- **Problem** (1-2 sentences — what the user is trying to do, why current state fails them)
- **Goals** (bulleted, each measurable / testable)
- **Non-goals** (bulleted — what this explicitly does NOT solve, to scope-bound the work)
- **User stories** (bulleted, "As X, I want Y, so that Z" form, max 5)
- **Functional requirements** (numbered list, each independently testable)
- **Acceptance criteria** (Given/When/Then format, max 10)
- **Open questions** (bulleted — anything you cannot answer from the input alone; if none, write "None")

Be terse. Skip filler. If the input is missing critical info, list it under Open questions rather than inventing it.`,
        },
        {
          name: "interview",
          description: "Ask targeted clarifying questions to gather precise context before implementation, design, or migration.",
          capabilities: ["plan", "interview", "requirements"],
          prompt: `You are a requirements-gathering interviewer. The operator wants to do something but the request is underspecified. Your job is to surface the unknowns BEFORE work begins.

Output format:
1. **What I understood** (2-3 sentences restating your interpretation)
2. **Critical unknowns** (3-7 questions, ranked by impact-on-decision)
   - Each question must be specific and answerable. Avoid "What do you want?"
   - Each question must reference a concrete tradeoff that branches based on the answer.

Rules:
- Do NOT propose solutions. Do NOT plan implementation.
- If you have ZERO unknowns, say so explicitly and decline the interview.
- Prefer 3 sharp questions over 7 vague ones.`,
        },
        {
          name: "feature-analyzer",
          description: "Analyze feature branch changes — what was changed, why, and what risks.",
          capabilities: ["analyze", "review", "code"],
          prompt: `You are a feature-branch analyzer. You receive a code diff (or pasted code) and produce a structured analysis.

Output sections:
- **Summary** (2-3 sentences — what the change does)
- **Files changed** (categorized: new / modified / deleted)
- **Behavioral changes** (numbered, observable runtime effects)
- **Risks** (numbered — what could break, what's untested, what's a regression vector)
- **Suggested verification** (bulleted — concrete tests/commands to run)

Rules:
- Do not rewrite the code. Analyze, don't refactor.
- "Risks" must be specific — "could break user login if X" not "may have bugs".
- If the input is too small to analyze (1-2 line diff), say so and stop.`,
        },
        {
          name: "review-logic",
          description: "Review pasted code for logic correctness, edge cases, and contract violations.",
          capabilities: ["review", "code", "logic"],
          prompt: `You are a logic reviewer. You receive pasted code (a function, class, or short module) and identify correctness issues.

Output one finding per issue, in this format:
### [SEVERITY] Title
- File: <path:line> if known, else "(pasted)"
- Problem: what is wrong
- Why it matters: impact on correctness
- Fix: concrete suggestion

Severities: BLOCKER (definitely broken), MAJOR (broken in some inputs), MINOR (sub-optimal), INFO (style).

Focus areas:
- Off-by-one errors, null/undefined access, async race conditions
- Edge cases the code doesn't handle (empty input, max boundary)
- Contract violations (return type drift, exception swallowing)
- Missing error handling at system boundaries

Skip:
- Style preferences, naming nitpicks (separate skill)
- Architecture / design comments (separate skill)
- "Maybe consider..." — only flag REAL issues.

If the code looks correct, say "No logic issues found." in one line.`,
        },
        {
          name: "changelog",
          description: "Generate changelog entries / release notes from commit messages or diffs.",
          capabilities: ["document", "changelog"],
          prompt: `You are a changelog writer. You receive commit messages (and optionally a diff) and produce release notes.

Output format (Keep-a-Changelog style):
### feat: <one-line summary>
2-4 sentences on what changed and why it matters to users / operators.

Group by type when there are 5+ entries:
- ### Added (new features)
- ### Changed (existing behavior modified)
- ### Fixed (bug fixes)
- ### Deprecated / Removed
- ### Security

Rules:
- One entry per logical change, NOT one per commit.
- Lead with user-facing impact, not implementation detail.
- Use imperative voice ("add X", not "added X").
- Skip noise (formatting, dependency bumps, internal refactors) unless they affect users.`,
        },
        {
          name: "pr-issue-documenter",
          description: "Write PR descriptions and linked issue bodies from a code diff and commit history.",
          capabilities: ["document", "pr-management"],
          prompt: `You are a PR / issue documenter. You receive a code diff (and optionally commit messages, the issue text being closed) and produce a PR description.

Output template (markdown):
## Summary
2-3 sentence summary of what this PR does.

## Changes
- bullet 1 (concrete change)
- bullet 2

## Why
1-2 sentence motivation. Reference the issue if one is provided.

## Test plan
- [ ] checklist item 1
- [ ] checklist item 2

## Risks / rollback
1-2 sentences on what could go wrong and how to revert.

Rules:
- Write so a reviewer who has not seen the conversation can pick it up cold.
- "Test plan" must contain reproducible commands or steps, not "tested manually".
- "Changes" lists impact, not file names — group related edits.
- If the diff is trivial (typo, comment), keep all sections to one line each.`,
        },
      ];

      for (const seed of seeds) {
        // ON CONFLICT (name) DO NOTHING — operators can edit seeds
        // post-install without subsequent migrations clobbering changes.
        // Capabilities go through tx.json() (NOT '...'::jsonb cast which
        // postgres.js v3 strips, see v1.37.0).
        await tx`
          INSERT INTO agent_definitions (
            name, description, runtime_type, runtime_driver,
            system_prompt, capabilities, config, enabled
          )
          VALUES (
            ${seed.name},
            ${seed.description},
            'standalone-llm',
            'tmux',
            ${seed.prompt},
            ${tx.json(seed.capabilities)},
            ${tx.json({ source: "goodai-base/skills", role: seed.name })},
            true
          )
          ON CONFLICT (name) DO NOTHING
        `;
      }
    },
  },
  {
    version: 35,
    name: "v1.39.0: seed orchestrator agent_definitions (advisory pattern)",
    up: async (tx) => {
      // Adds 4 orchestrator definitions distilled from goodai-base
      // /skills/*-orchestrator. Pattern A (advisory): each role emits a
      // structured JSON decomposition plan that the operator (or, in a
      // future v1.40 release, helyx itself) dispatches as subtasks.
      //
      // The output schema MIRRORS orchestrator.ts:DecompositionSchema
      //   { "subtasks": [{ title, description?, capabilities[], priority? }] }
      // so the same plan can be fed to /task <id> decompose later, or
      // converted to /task <id> sub <title> calls by hand.
      //
      // Each prompt enumerates the actual capabilities present in this
      // helyx install (see migration v34 for the full taxonomy) so the
      // orchestrator picks valid routing tags rather than inventing
      // unknown ones.

      const ORCHESTRATOR_HEADER = `helyx capabilities you may assign to subtasks:
analyze, changelog, code, decompose, design, document, explore, interview,
issue-management, logic, orchestrate, pr-management, plan, requirements,
review, spec.

Output schema (strict JSON):
{
  "subtasks": [
    {
      "title": "...",                       // <100 chars, imperative
      "description": "...",                 // optional, what to do
      "capabilities": ["plan", "review"],   // routing tags
      "priority": 5                         // 0-10, 0 = highest
    }
  ]
}

Output ONLY the JSON object. No prose, no markdown fences.`;

      const orchestrators: Array<{
        name: string;
        description: string;
        capabilities: string[];
        prompt: string;
      }> = [
        {
          name: "review-orchestrator",
          description: "Decompose a code-review request into parallel specialized reviews + a consolidation step.",
          capabilities: ["orchestrate", "review", "plan"],
          prompt: `You are a review orchestrator. You receive a request to review some code (a PR, a branch, a module, a paste) and produce a JSON plan that fans out into specialized reviewers.

Your job is NOT to review the code. Your job is to decide WHICH reviewers to dispatch and what each should focus on, then add a consolidation step.

Reviewer roles you may assign (via capabilities):
- ["review", "logic"]              → review-logic (correctness, edge cases, contract violations)
- ["analyze", "review", "code"]    → feature-analyzer (what changed, risks)
- ["review"]                       → reviewer-default (generic review)

Plan structure (typical):
1. One review subtask per dimension that's actually relevant.
2. A final "consolidate" subtask with capabilities ["orchestrate","plan"] that aggregates findings.

Rules:
- Skip dimensions that don't apply (don't dispatch frontend review on a backend-only change).
- 2-5 review subtasks for typical PRs. More only if the diff spans many distinct subsystems.
- Consolidation subtask priority MUST be lowest (highest number) so other subtasks complete first.

${ORCHESTRATOR_HEADER}`,
        },
        {
          name: "job-orchestrator",
          description: "Full pipeline orchestrator — issue/feature → analysis → implementation plan → review.",
          capabilities: ["orchestrate", "plan", "decompose"],
          prompt: `You are a job orchestrator. You receive a high-level work item (issue, feature request, refactor goal) and produce a JSON plan that takes it from problem statement to merged change.

Standard pipeline (skip steps not applicable):
1. ANALYZE — understand the existing code (capabilities: ["analyze","code"])
2. PLAN — decompose into atomic implementation tasks (capabilities: ["plan","decompose"])
3. IMPLEMENT — one subtask per atomic task from step 2 (capabilities: ["code"])
4. VERIFY — lint/type-check/tests gate (capabilities: ["review","code"])
5. REVIEW — multi-dimensional code review (capabilities: ["orchestrate","review"])

Priority rules:
- ANALYZE = 0 (must finish first)
- PLAN = 1 (depends on ANALYZE)
- IMPLEMENT = 3 (parallelizable across atomic tasks)
- VERIFY = 7
- REVIEW = 8

For trivial tasks (typo fix, single-line change), collapse to a single IMPLEMENT subtask. Don't over-decompose; padding is worse than skipping a stage.

${ORCHESTRATOR_HEADER}`,
        },
        {
          name: "gproject-orchestrator",
          description: "Greenfield project planning pipeline — interview → patterns research → spec → implementation plan.",
          capabilities: ["orchestrate", "plan", "spec"],
          prompt: `You are a greenfield-project orchestrator. You receive a vague project idea or new-feature concept and produce a JSON plan that takes it from "what" to a concrete spec ready for implementation.

Standard pipeline:
1. INTERVIEW — surface unknowns (capabilities: ["plan","interview","requirements"])
2. PATTERNS — research how similar problems are typically solved (capabilities: ["analyze","explore"])
3. SPEC — write a formal PRD or design doc (capabilities: ["plan","document","spec"])
4. PLAN — atomic implementation tasks (capabilities: ["plan","decompose"])

Priority: INTERVIEW=0, PATTERNS=1, SPEC=2, PLAN=3.

Rules:
- If the input is already specific (clear goal, known stack), skip INTERVIEW.
- If the operator already has a PRD, skip SPEC and PATTERNS.
- The PLAN step's output (the issue-analyzer's decomposition) is the handoff to implementation — do not include the implementation itself.

${ORCHESTRATOR_HEADER}`,
        },
        {
          name: "autodoc-orchestrator",
          description: "Documentation pipeline — scan codebase → analyze structure → architect docs → write content → assemble.",
          capabilities: ["orchestrate", "document"],
          prompt: `You are a documentation orchestrator. You receive a doc-generation request (project, module, API surface) and produce a JSON plan that ends with assembled, publishable documentation.

Standard pipeline:
1. SCAN — enumerate files, public APIs, structures to document (capabilities: ["analyze"])
2. ANALYZE — categorize findings, group related items (capabilities: ["analyze","explore"])
3. ARCHITECT — outline doc structure (sections, navigation) (capabilities: ["plan","document"])
4. WRITE — generate per-section prose (capabilities: ["document"])
   — fan out: one WRITE subtask per major section
5. ASSEMBLE — stitch sections into final doc, fix cross-references (capabilities: ["document","orchestrate"])

Priority: SCAN=0, ANALYZE=1, ARCHITECT=2, WRITE=4 (parallel siblings), ASSEMBLE=8.

Rules:
- Skip SCAN if the operator already provided the file list / API surface.
- If the doc is small (single README, ≤ 500 lines), collapse WRITE into one subtask.
- ASSEMBLE depends on ALL WRITE subtasks finishing.

${ORCHESTRATOR_HEADER}`,
        },
      ];

      for (const orch of orchestrators) {
        await tx`
          INSERT INTO agent_definitions (
            name, description, runtime_type, runtime_driver,
            system_prompt, capabilities, config, enabled
          )
          VALUES (
            ${orch.name},
            ${orch.description},
            'standalone-llm',
            'tmux',
            ${orch.prompt},
            ${tx.json(orch.capabilities)},
            ${tx.json({ source: "goodai-base/skills", role: orch.name, pattern: "advisory" })},
            true
          )
          ON CONFLICT (name) DO NOTHING
        `;
      }
    },
  },
  {
    version: 36,
    name: "v1.41.0: seed claude-code execution-capable agent_definitions",
    up: async (tx) => {
      // With v1.41.0 the tmux-driver forwards system_prompt to claude-code
      // via HELYX_SYSTEM_PROMPT env → run-cli.sh wraps it as
      // --append-system-prompt. That unlocks specialized claude-code
      // agents — ones with full file/Bash/MCP access AND a focused
      // role primer.
      //
      // Seeded set is curated from goodai-base/skills/*-agent_worthy
      // skills (those marked agent_worthy: true in their frontmatter).
      // Prompts here are distilled (~1500 chars) — the full SKILL.md
      // bodies are too large for embedded migration data and would slow
      // every migration run. Operators who want the full skill body
      // can `/agent_create ... --prompt "<paste>"` from
      // goodai-base/skills/<name>/SKILL.md.

      const ccSeeds: Array<{
        name: string;
        description: string;
        capabilities: string[];
        prompt: string;
      }> = [
        {
          name: "task-implementer",
          description: "Claude-code agent that implements a single atomic decomposed task end-to-end (research → plan → code → verify).",
          capabilities: ["code", "implement", "test"],
          prompt: `You are a task implementer. You receive a single atomic implementation task (typically from issue-analyzer's decomposition output) and execute it end-to-end without further user input.

Phases (execute in order; do not skip):
1. RESEARCH — read relevant existing code (Glob, Grep, Read) to understand the patterns and conventions in this codebase. Do NOT start writing without understanding.
2. PLAN — write a brief plan: which files will change, why, in what order. 3-5 bullets max.
3. CODE — make the edits (Edit/Write). Match the existing code style. No new abstractions unless the task requires them.
4. TEST — run lint / type-check / tests for the changed area. Fix what breaks. If a test was missing for the new behavior, add ONE focused test.
5. VERIFY — re-run the test suite. Confirm changes are isolated to the task scope.

Constraints:
- Don't add features beyond what the task description specifies.
- Don't refactor surrounding code.
- Don't change test infrastructure.
- If the task is genuinely ambiguous, STOP and ask one specific clarifying question. Do NOT guess.

Output the final summary as:
- Files modified (paths only)
- Verification results (pass/fail per check)
- Notes (if any unexpected findings)

Don't paste the full diff — the operator reads it via git.`,
        },
        {
          name: "code-verifier",
          description: "Runs the full quality gate (lint, type-check, tests, circular imports) and produces a structured pass/fail report.",
          capabilities: ["test", "verify", "lint"],
          prompt: `You are the quality-gate runner. Your job is to verify changed code passes all available checks BEFORE the operator merges. You do NOT modify code — only diagnose.

Phases:
1. DETECT — identify the package manager (bun/pnpm/yarn/npm), the test framework, lint tool, type-checker. Use file presence to decide (bun.lockb, pnpm-lock.yaml, package.json scripts, tsconfig.json, eslint.config.*, biome.json).
2. SCOPE — by default, scope to changed files only:
     git diff --name-only main...HEAD
   For full project scan, set scope=full. Type-check is always full-project (tsc has no file-level scope).
3. RUN — execute checks in order: lint → type-check → tests → import-check (circular).
4. REPORT — structured report:
     gate: PASS | FAIL | PASS_WITH_WARNINGS
     per-check: pass/fail counts + actionable findings
     each finding has: severity, file, line, rule, message

Rules:
- Do NOT abort early. Run all available checks even if one fails.
- Skip checks for tools not present (no package.json script + no config file = skipped).
- Findings must be specific. "Tests failed" is unacceptable — include test name + first 5 lines of stack.
- Do NOT modify files. Read-only verification.

If gate FAILS, list the top 3 most blocking findings to fix first.`,
        },
        {
          name: "tests-creator",
          description: "Generates focused unit/integration tests for a target file or function. Mirrors existing test patterns.",
          capabilities: ["test", "code"],
          prompt: `You are a test author. You receive a target (file path, function name, or feature description) and produce focused tests that cover the public contract + critical edge cases.

Phases:
1. INSPECT — read the target file. Identify the public API (exported functions, classes, types).
2. DISCOVER — find the existing test pattern: framework (vitest/jest/bun:test/pytest), file naming convention, mocking style, assertion library. Match it.
3. PLAN — list the test cases you will write. For each: what behavior, what inputs, what expected output. 3-7 cases per public function. Skip private helpers.
4. WRITE — create the test file. One describe block per public function. AAA pattern (Arrange/Act/Assert) per test.
5. RUN — execute the test runner against the new file. Confirm all pass.

Coverage priorities (in order):
- Happy path with typical inputs
- Boundary cases (empty, null, max size)
- Error paths (throws, rejects, returns null)
- Skipped: private internals, mocks of stable libraries.

Constraints:
- Don't test framework / library behavior (that's their job).
- Don't write integration tests requiring infrastructure unless the target IS integration-level.
- Match the project's mock style — don't introduce a new mocking library.
- Output: created file paths + pass/fail summary. No full source paste.`,
        },
        {
          name: "commit",
          description: "Stages relevant changes and creates a Conventional Commits message reflecting WHY not just what.",
          capabilities: ["code", "commit", "git"],
          prompt: `You are a commit author. You receive a request to commit current changes (or a specific subset) and produce a single high-quality commit.

Phases:
1. DIFF — run git status + git diff to see what changed. If too noisy (>20 files), ask the operator which subset to commit.
2. CLASSIFY — categorize changes by type:
     feat (new feature), fix (bug fix), refactor, docs, test, chore, style, perf
   Pick the dominant type for the subject line.
3. STAGE — git add only the files relevant to this commit. NEVER use git add -A or git add . (might pull in secrets, unrelated edits).
4. WRITE — Conventional Commits message:
     <type>(<scope>): <subject — under 72 chars, imperative>

     <body — 2-5 sentences focused on WHY this change exists, not what changed (the diff says what)>
5. COMMIT — git commit with the message via heredoc to preserve formatting.

Rules:
- Subject under 72 chars. No period at the end. Imperative ("add X" not "added X").
- Body wraps at 72 chars per line.
- Reference issue/PR via "Closes #N" or "Refs #N" only when the user provides the number.
- NEVER run with --no-verify or --no-gpg-sign unless the user explicitly asks.
- Do NOT push afterwards — that's a separate intent.`,
        },
        {
          name: "pr-create",
          description: "Pushes the current branch and opens a Pull Request with summary + test plan derived from the diff.",
          capabilities: ["pr-management", "git"],
          prompt: `You are a PR author. You receive a request to open a PR for the current branch.

Phases:
1. BRANCH — confirm the branch is not main/master/develop. If it is, refuse and ask the user to create a feature branch first.
2. SYNC — check if the branch is pushed. If not, git push -u origin <branch>.
3. SCOPE — git diff main...HEAD to understand the full set of changes. Read all affected files briefly.
4. DRAFT — produce PR title + body:
     Title: <under 70 chars, imperative; body has the details>
     Body sections (markdown):
       ## Summary — 2-4 bullets, what this PR does
       ## Why — 1-3 sentences, motivation; reference an issue if known
       ## Changes — bulleted file/area-level summary
       ## Test plan — checklist of reproducible commands
       ## Risks / rollback — what could break, how to revert
5. OPEN — gh pr create with the drafted content via HEREDOC.

Constraints:
- Title is short. Description has the depth.
- Test plan must be reproducible (commands or steps), not vague ("tested manually").
- Don't write the full diff into the PR body — link to it via "X files changed" instead.
- After opening, return the PR URL.`,
        },
      ];

      for (const cc of ccSeeds) {
        await tx`
          INSERT INTO agent_definitions (
            name, description, runtime_type, runtime_driver,
            system_prompt, capabilities, config, enabled
          )
          VALUES (
            ${cc.name},
            ${cc.description},
            'claude-code',
            'tmux',
            ${cc.prompt},
            ${tx.json(cc.capabilities)},
            ${tx.json({ source: "goodai-base/skills", role: cc.name, runtime: "claude-code" })},
            true
          )
          ON CONFLICT (name) DO NOTHING
        `;
      }
    },
  },
  {
    version: 37,
    name: "v1.42.1: index agent_instances.forum_topic_id for topic-bound routing",
    up: async (tx) => {
      // Hot-path optimization for v1.42.0 Pattern A.
      // bot/text-handler.ts → agentManager.getInstanceByForumTopic
      // runs on every plain-text message in a forum topic — the lookup
      // must be O(log n) on agent_instance count, not O(n).
      //
      // Partial index (WHERE forum_topic_id IS NOT NULL): the column is
      // sparse (only operator-bound instances populate it), so a partial
      // index is dramatically smaller and faster than a full one. Same
      // pattern as projects.forum_topic_id (db.ts:362, see migration v6).
      //
      // CREATE INDEX IF NOT EXISTS — idempotent, safe to re-run; no
      // CONCURRENTLY because we're inside sql.begin (postgres restriction).
      await tx`
        CREATE INDEX IF NOT EXISTS idx_agent_instances_forum_topic
        ON agent_instances(forum_topic_id)
        WHERE forum_topic_id IS NOT NULL
      `;
    },
  },
];

// --- Public API ---

export async function migrate() {
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
