import Anthropic from "@anthropic-ai/sdk";
import { sql } from "./db.ts";
import { embed, embedSafe } from "./embeddings.ts";
import { CONFIG } from "../config.ts";

const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

let _indexingCount = 0;
export function isIndexing(): boolean { return _indexingCount > 0; }

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
  archivedAt?: Date;
  distance?: number;
}

export async function remember(memory: Memory): Promise<Memory> {
  _indexingCount++;
  const embedding = await embedSafe(memory.content).finally(() => { _indexingCount--; });
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
      AND archived_at IS NULL
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
    archivedAt: r.archived_at,
    distance: r.distance,
  }));
}

// --- Smart Memory Reconciliation ---

export interface ReconcileResult {
  action: "added" | "updated" | "noop";
  id: number;
  content: string;
  replacedId?: number;
}

type ReconcileDecision =
  | { action: "ADD" }
  | { action: "UPDATE"; id: number; content: string }
  | { action: "DELETE"; id: number }
  | { action: "NOOP"; id: number };

function parseReconcileDecision(raw: string, similarIds: number[]): ReconcileDecision {
  const s = raw.trim();
  if (s === "ADD") return { action: "ADD" };
  if (s === "NOOP") return { action: "NOOP", id: similarIds[0] ?? -1 };

  const updateMatch = s.match(/^UPDATE id=(\d+) content="(.+)"$/s);
  if (updateMatch) return { action: "UPDATE", id: Number(updateMatch[1]), content: updateMatch[2] };

  const deleteMatch = s.match(/^DELETE id=(\d+)$/);
  if (deleteMatch) return { action: "DELETE", id: Number(deleteMatch[1]) };

  throw new Error(`unparseable decision: "${s.slice(0, 100)}"`);
}

async function reconcileWithExisting(newContent: string, similar: Memory[]): Promise<ReconcileDecision> {
  const memoriesList = similar.map((m) => `[id=${m.id}] ${m.content}`).join("\n");

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: `You are a memory manager. Decide how to integrate new information with existing memories.

Existing memories:
${memoriesList}

New information: "${newContent}"

Rules:
- ADD: new info is distinct from all existing memories
- UPDATE id=X content="merged text": new info updates or extends memory X
- DELETE id=X: memory X is contradicted; new info replaces it (caller will then ADD)
- NOOP: new info is already captured in existing memories

Reply with exactly one line. No explanation.
Examples: ADD | UPDATE id=2 content="project uses PostgreSQL 16" | DELETE id=2 | NOOP`,
      },
    ],
  });

  const raw = response.content[0].type === "text" ? response.content[0].text : "";
  return parseReconcileDecision(raw, similar.map((m) => m.id!));
}

/**
 * Remember with LLM-based deduplication and update logic.
 * Searches for similar existing memories first; if found, asks Claude to decide
 * ADD / UPDATE / DELETE / NOOP instead of always inserting.
 */
export async function rememberSmart(memory: Memory): Promise<ReconcileResult> {
  // Step 1: embed
  const embedding = await embedSafe(memory.content);
  if (!embedding) {
    console.log("[memory] ollama unavailable, skipping reconciliation");
    const saved = await remember(memory);
    return { action: "added", id: saved.id!, content: saved.content };
  }

  // Step 2: search similar (same type + scope)
  const embeddingStr = `[${embedding.join(",")}]`;
  const rows = await sql`
    SELECT id, content, embedding <=> ${embeddingStr}::vector AS distance
    FROM memories
    WHERE type = ${memory.type}
      ${memory.projectPath ? sql`AND project_path = ${memory.projectPath}` : memory.chatId ? sql`AND chat_id = ${memory.chatId}` : sql``}
    ORDER BY embedding <=> ${embeddingStr}::vector
    LIMIT ${CONFIG.MEMORY_RECONCILE_TOP_K}
  `;

  // Step 3: threshold check — skip LLM if nothing is close enough
  if (rows.length === 0 || Number(rows[0].distance) > CONFIG.MEMORY_SIMILARITY_THRESHOLD) {
    const saved = await remember(memory);
    return { action: "added", id: saved.id!, content: saved.content };
  }

  const similar: Memory[] = rows.map((r) => ({ id: r.id, content: r.content, source: "api", type: memory.type }));

  // Step 4: LLM decision
  let decision: ReconcileDecision;
  try {
    decision = await reconcileWithExisting(memory.content, similar);
  } catch (err) {
    console.log(`[memory] reconcile failed: ${(err as Error).message}, falling back to remember()`);
    const saved = await remember(memory);
    return { action: "added", id: saved.id!, content: saved.content };
  }

  // Step 5: execute
  switch (decision.action) {
    case "ADD": {
      const saved = await remember(memory);
      console.log(`[memory] reconcile: added #${saved.id}`);
      return { action: "added", id: saved.id!, content: saved.content };
    }

    case "UPDATE": {
      if (!similar.some((m) => m.id === decision.id)) {
        console.log(`[memory] reconcile: UPDATE for unknown id ${decision.id}, falling back to ADD`);
        const saved = await remember(memory);
        return { action: "added", id: saved.id!, content: saved.content };
      }
      const newEmb = await embedSafe(decision.content);
      const newEmbStr = newEmb ? `[${newEmb.join(",")}]` : null;
      await sql`
        UPDATE memories
        SET content = ${decision.content},
            embedding = ${newEmbStr}::vector,
            updated_at = now()
        WHERE id = ${decision.id}
      `;
      console.log(`[memory] reconcile: updated #${decision.id}`);
      return { action: "updated", id: decision.id, content: decision.content };
    }

    case "DELETE": {
      await sql`DELETE FROM memories WHERE id = ${decision.id}`;
      const saved = await remember(memory);
      console.log(`[memory] reconcile: replaced #${decision.id} → added #${saved.id}`);
      return { action: "added", id: saved.id!, content: saved.content, replacedId: decision.id };
    }

    case "NOOP": {
      const existing = similar.find((m) => m.id === decision.id) ?? similar[0];
      console.log(`[memory] reconcile: noop #${existing.id}`);
      return { action: "noop", id: existing.id!, content: existing.content };
    }
  }
}

export async function forget(id: number): Promise<boolean> {
  const result = await sql`
    DELETE FROM memories WHERE id = ${id}
    RETURNING id
  `;
  return result.length > 0;
}

export async function archiveMemory(id: number): Promise<boolean> {
  const result = await sql`
    UPDATE memories SET archived_at = now() WHERE id = ${id} AND archived_at IS NULL
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
    SELECT id, source, session_id, project_path, chat_id, type, content, tags, created_at, updated_at, archived_at
    FROM memories
    WHERE 1=1
      AND archived_at IS NULL
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
    archivedAt: r.archived_at,
  }));
}
