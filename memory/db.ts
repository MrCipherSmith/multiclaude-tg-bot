import postgres from "postgres";
import { CONFIG } from "../config.ts";

export const sql = postgres(CONFIG.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

export async function migrate() {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;

  // Sessions
  await sql`
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

  // Standalone session (id=0)
  await sql`
    INSERT INTO sessions (id, name, project_path, client_id, status)
    VALUES (0, 'standalone', NULL, '__standalone__', 'active')
    ON CONFLICT (id) DO NOTHING
  `;

  // Reset sequence after manual id=0 insert
  await sql`SELECT setval('sessions_id_seq', GREATEST((SELECT MAX(id) FROM sessions), 1))`;

  // Chat-session binding
  await sql`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      chat_id TEXT PRIMARY KEY,
      active_session_id INT NOT NULL REFERENCES sessions(id) DEFAULT 0
    )
  `;

  // Short-term memory: messages
  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      session_id INT NOT NULL REFERENCES sessions(id) DEFAULT 0,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_messages_session_chat
    ON messages(session_id, chat_id, created_at)
  `;

  // Long-term memory: memories with vectors
  await sql`
    CREATE TABLE IF NOT EXISTS memories (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      session_id INT REFERENCES sessions(id),
      chat_id TEXT,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT[] DEFAULT '{}',
      embedding vector(${sql.unsafe(String(CONFIG.VECTOR_DIMENSIONS))}),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING gin(tags)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id)
  `;

  // IVFFlat index — needs rows to build, create only if table has data
  // For now use HNSW which works on empty tables
  await sql`
    CREATE INDEX IF NOT EXISTS idx_memories_embedding
    ON memories USING hnsw (embedding vector_cosine_ops)
  `;

  // --- Incremental migrations ---

  // Add project_path to memories (long-term memory scoped by project, not session)
  await sql`
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS project_path TEXT
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_memories_project_path ON memories(project_path)
  `;

  // Add project_path to messages (allows cross-session history per project)
  await sql`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS project_path TEXT
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_messages_project_path
    ON messages(project_path, chat_id, created_at)
  `;

  // Message queue for stdio channel adapters
  await sql`
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
  await sql`
    CREATE INDEX IF NOT EXISTS idx_queue_session
    ON message_queue(session_id, delivered, created_at)
  `;

  // Permission requests from CLI sessions
  await sql`
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

  // API request statistics
  await sql`
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
  await sql`
    CREATE INDEX IF NOT EXISTS idx_api_stats_created
    ON api_request_stats(created_at)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_api_stats_session
    ON api_request_stats(session_id)
  `;

  // Transcription statistics
  await sql`
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
  await sql`
    CREATE INDEX IF NOT EXISTS idx_transcription_stats_created
    ON transcription_stats(created_at)
  `;

  // Request logs (structured per-message processing logs)
  await sql`
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
  await sql`
    CREATE INDEX IF NOT EXISTS idx_request_logs_session_created
    ON request_logs(session_id, created_at)
  `;

  console.log("[db] migrations complete");
}

// Run migrations directly if this file is executed
if (import.meta.main) {
  await migrate();
  await sql.end();
  console.log("[db] done");
}
