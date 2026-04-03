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

  console.log("[db] migrations complete");
}

// Run migrations directly if this file is executed
if (import.meta.main) {
  await migrate();
  await sql.end();
  console.log("[db] done");
}
