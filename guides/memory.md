# Memory System

Claude Bot has a two-layer memory system: short-term per session, and long-term semantic across sessions.

---

## Short-Term Memory

**Scope:** Per session  
**Storage:** In-memory cache + PostgreSQL `messages` table  
**Window:** Last 20 messages (sliding window)

Each session maintains a sliding window of recent messages. These are loaded as conversation history when Claude CLI starts a new session in the same project, providing continuity.

When the window overflows or the session becomes idle, automatic summarization kicks in.

---

## Long-Term Memory

**Scope:** Per project (shared across all sessions in the same project)  
**Storage:** PostgreSQL with pgvector extension  
**Model:** Ollama `nomic-embed-text` (768 dimensions)

Long-term memories are stored as text with vector embeddings for semantic search. When you ask `/recall "how did we handle auth"`, the system finds semantically similar memories even if they don't contain those exact words.

### Memory types and retention

| Type | Default TTL | Created by |
|---|---|---|
| `fact` | 90 days | `/remember`, reconciliation |
| `summary` | 60 days | Auto-summarization on exit |
| `decision` | 180 days | Work summaries |
| `note` | 30 days | Manual `/remember` |
| `project_context` | 180 days | Session exit summaries |

Configure TTL via env vars: `MEMORY_TTL_FACT_DAYS`, `MEMORY_TTL_SUMMARY_DAYS`, etc.

---

## Smart Reconciliation

When new memories are saved (via `/remember` or work summaries), the system does **not** blindly insert. Instead:

1. Vector search finds top-K similar existing memories (`MEMORY_RECONCILE_TOP_K`, default: 5)
2. Claude Haiku compares the new memory against similar ones
3. Decides: `ADD` / `UPDATE` / `DELETE` / `NOOP`
4. Executes only the necessary operation

This prevents memory from accumulating duplicates over time.

**Config:**
```env
MEMORY_SIMILARITY_THRESHOLD=0.35   # Cosine distance threshold (lower = stricter match)
MEMORY_RECONCILE_TOP_K=5           # How many similar memories to compare
```

**Replies from `/remember`:**
- `Saved (#42)` — new memory added
- `Updated #38` — existing memory updated
- `Already known (#38)` — no change needed

**Fallback:** If Ollama or Claude API is unavailable, falls back to plain insert with no data loss.

---

## Auto-Summarization

When a session becomes idle (15 min) or disconnects, the recent conversation is summarized:

1. Messages are sent to Claude for summarization
2. Summary is structured: `[DECISIONS][FILES][PROBLEMS][PENDING][CONTEXT]`
3. Summary is embedded and saved as a `project_context` memory
4. Raw messages are archived with a TTL (`ARCHIVE_TTL_DAYS`, default: 30 days)

This means that when you start a new session on the same project, Claude loads the last project context summary as system context — providing a briefing without replaying all raw messages.

---

## Work Summary on Exit

When a **local** session exits (e.g., you `Ctrl+C` out of `claude-bot start`), the session generates a work summary:

- Structured format: `[DECISIONS][FILES][PROBLEMS][PENDING][CONTEXT]`
- Vectorized and saved to long-term memory as `project_context`
- Raw messages archived (deleted after `ARCHIVE_TTL_DAYS`)

This is more detailed than idle summarization — it captures the full arc of what was done in the session.

---

## Telegram Commands

| Command | Description |
|---|---|
| `/remember [text]` | Save to long-term memory, bound to current session's project |
| `/recall [query]` | Semantic search through project memories |
| `/memories` | List recent memories for this project |
| `/forget [id]` | Delete a memory by ID |
| `/summarize` | Force conversation summarization now |
| `/clear` | Clear current session's short-term context |

---

## MCP Tools (for Claude CLI)

| Tool | Description |
|---|---|
| `remember` | Save to long-term memory with semantic embedding |
| `recall` | Semantic search through memories |
| `forget` | Delete a memory by ID |
| `list_memories` | List recent memories |
| `search_project_context` | Semantic search over project work summaries and prior session context |

---

## Requirements

Long-term memory requires **Ollama** running on the host with the `nomic-embed-text` model:

```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull the embedding model
ollama pull nomic-embed-text
```

Without Ollama, the bot still works but:
- `/recall` and semantic search won't function
- Memory will fall back to plain insert (no reconciliation)
- Work summaries are still generated but not embedded
