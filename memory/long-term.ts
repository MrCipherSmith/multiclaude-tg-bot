import { sql } from "./db.ts";
import { embed } from "./embeddings.ts";

export interface Memory {
  id?: number;
  source: "telegram" | "cli" | "api";
  sessionId?: number | null;
  chatId?: string | null;
  type: "fact" | "summary" | "decision" | "note";
  content: string;
  tags?: string[];
  createdAt?: Date;
  updatedAt?: Date;
  distance?: number;
}

export async function remember(memory: Memory): Promise<Memory> {
  const embedding = await embed(memory.content);
  const embeddingStr = `[${embedding.join(",")}]`;

  const [row] = await sql`
    INSERT INTO memories (source, session_id, chat_id, type, content, tags, embedding)
    VALUES (
      ${memory.source},
      ${memory.sessionId ?? null},
      ${memory.chatId ?? null},
      ${memory.type},
      ${memory.content},
      ${memory.tags ?? []},
      ${embeddingStr}::vector
    )
    RETURNING id, created_at, updated_at
  `;

  return { ...memory, id: row.id, createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function recall(
  query: string,
  options: {
    limit?: number;
    sessionId?: number | null;
    type?: string;
    tags?: string[];
  } = {},
): Promise<Memory[]> {
  const { limit = 5, sessionId, type, tags } = options;
  const queryEmbedding = await embed(query);
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  // Build dynamic query with filters
  const rows = await sql`
    SELECT
      id, source, session_id, chat_id, type, content, tags,
      created_at, updated_at,
      embedding <=> ${embeddingStr}::vector AS distance
    FROM memories
    WHERE 1=1
      ${sessionId !== undefined ? sql`AND (session_id = ${sessionId} OR session_id IS NULL)` : sql``}
      ${type ? sql`AND type = ${type}` : sql``}
      ${tags && tags.length > 0 ? sql`AND tags && ${tags}` : sql``}
    ORDER BY embedding <=> ${embeddingStr}::vector
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    sessionId: r.session_id,
    chatId: r.chat_id,
    type: r.type,
    content: r.content,
    tags: r.tags,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    distance: r.distance,
  }));
}

export async function forget(id: number): Promise<boolean> {
  const result = await sql`
    DELETE FROM memories WHERE id = ${id}
    RETURNING id
  `;
  return result.length > 0;
}

export async function listMemories(
  options: {
    type?: string;
    tags?: string[];
    sessionId?: number | null;
    limit?: number;
    offset?: number;
  } = {},
): Promise<Memory[]> {
  const { type, tags, sessionId, limit = 20, offset = 0 } = options;

  const rows = await sql`
    SELECT id, source, session_id, chat_id, type, content, tags, created_at, updated_at
    FROM memories
    WHERE 1=1
      ${sessionId !== undefined ? sql`AND (session_id = ${sessionId} OR session_id IS NULL)` : sql``}
      ${type ? sql`AND type = ${type}` : sql``}
      ${tags && tags.length > 0 ? sql`AND tags && ${tags}` : sql``}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    sessionId: r.session_id,
    chatId: r.chat_id,
    type: r.type,
    content: r.content,
    tags: r.tags,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}
