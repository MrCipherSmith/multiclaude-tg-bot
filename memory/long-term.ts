import { sql } from "./db.ts";
import { embed, embedSafe } from "./embeddings.ts";

export interface Memory {
  id?: number;
  source: "telegram" | "cli" | "api";
  sessionId?: number | null;
  projectPath?: string | null;
  chatId?: string | null;
  type: "fact" | "summary" | "decision" | "note" | "project_context";
  content: string;
  tags?: string[];
  createdAt?: Date;
  updatedAt?: Date;
  distance?: number;
}

export async function remember(memory: Memory): Promise<Memory> {
  const embedding = await embedSafe(memory.content);
  const embeddingStr = embedding ? `[${embedding.join(",")}]` : null;

  const [row] = await sql`
    INSERT INTO memories (source, session_id, project_path, chat_id, type, content, tags, embedding)
    VALUES (
      ${memory.source},
      ${memory.sessionId ?? null},
      ${memory.projectPath ?? null},
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
    projectPath?: string | null;
    type?: string;
    tags?: string[];
  } = {},
): Promise<Memory[]> {
  const { limit = 5, projectPath, sessionId, type, tags } = options;
  const queryEmbedding = await embed(query);
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  // Prefer project_path filter; fall back to sessionId for backwards compat
  const rows = await sql`
    SELECT
      id, source, session_id, project_path, chat_id, type, content, tags,
      created_at, updated_at,
      embedding <=> ${embeddingStr}::vector AS distance
    FROM memories
    WHERE 1=1
      ${projectPath ? sql`AND (project_path = ${projectPath} OR project_path IS NULL)` : sessionId !== undefined ? sql`AND (session_id = ${sessionId} OR session_id IS NULL)` : sql``}
      ${type ? sql`AND type = ${type}` : sql``}
      ${tags && tags.length > 0 ? sql`AND tags && ${tags}` : sql``}
    ORDER BY embedding <=> ${embeddingStr}::vector
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    sessionId: r.session_id,
    projectPath: r.project_path,
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
    projectPath?: string | null;
    limit?: number;
    offset?: number;
  } = {},
): Promise<Memory[]> {
  const { type, tags, projectPath, sessionId, limit = 20, offset = 0 } = options;

  const rows = await sql`
    SELECT id, source, session_id, project_path, chat_id, type, content, tags, created_at, updated_at
    FROM memories
    WHERE 1=1
      ${projectPath ? sql`AND (project_path = ${projectPath} OR project_path IS NULL)` : sessionId !== undefined ? sql`AND (session_id = ${sessionId} OR session_id IS NULL)` : sql``}
      ${type ? sql`AND type = ${type}` : sql``}
      ${tags && tags.length > 0 ? sql`AND tags && ${tags}` : sql``}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    sessionId: r.session_id,
    projectPath: r.project_path,
    chatId: r.chat_id,
    type: r.type,
    content: r.content,
    tags: r.tags,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}
