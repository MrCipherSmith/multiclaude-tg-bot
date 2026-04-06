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
