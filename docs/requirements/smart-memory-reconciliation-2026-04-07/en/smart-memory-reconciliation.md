# PRD: Smart Memory Reconciliation

## 1. Overview

Instead of always inserting a new memory record, the system first searches for similar existing entries via vector similarity, then calls Claude API to decide: ADD / UPDATE / DELETE / NOOP. The approach mirrors mem0's core architecture, implemented natively on top of the existing stack without adding new dependencies.

## 2. Context

- **Product:** claude-bot — Telegram bot managing Claude Code sessions
- **Module:** memory (long-term.ts), bot/commands/memory.ts, mcp/tools.ts, memory/summarizer.ts
- **Tech Stack:** Bun, TypeScript, PostgreSQL + pgvector, Ollama (nomic-embed-text), Claude API
- **Current DB schema version:** v8

## 3. Problem Statement

The current `remember()` always performs an INSERT. This leads to:
- Duplicates: "I use Linux" and "user works on Linux" become two separate records
- Stale facts: "PostgreSQL 14" persists alongside "migrated to PostgreSQL 16"
- Unbounded growth of `memories`: each `summarizeWork` appends a new `project_context` instead of updating the existing one

## 4. Goals

- Implement `rememberSmart()` with LLM reconciliation before every save
- Eliminate duplicates and stale facts in `memories`
- Improve project_context quality: accumulate knowledge instead of duplicating it
- Communicate the reconciliation outcome to the user (added / updated / already known)

## 5. Non-Goals

- DB schema changes (UPDATE is in-place, no new tables)
- Batch deduplication of existing records (future work)
- Graph-based relationship tracking between memories (as in mem0 + Neo4j)
- Changes to `recall()` and `listMemories()` — read path is unchanged

## 6. Functional Requirements

### FR-1: `rememberSmart()` function

Add `rememberSmart(memory: Memory): Promise<ReconcileResult>` to `memory/long-term.ts`.

**Algorithm:**
1. Embed new content via Ollama
2. Search top-5 similar records from `memories` (scoped by `project_path` or `chat_id`)
3. If no similar found OR nearest distance > `CONFIG.MEMORY_SIMILARITY_THRESHOLD` (default `0.35`) — call `remember()` directly, return `{ action: 'added', id, content }`
4. Otherwise — call `reconcileWithExisting(newContent, similarMemories)` → LLM decides
5. Execute decision (see FR-2)

**Return type:**
```typescript
interface ReconcileResult {
  action: 'added' | 'updated' | 'noop';
  id: number;
  content: string;
  replacedId?: number; // set when DELETE+ADD occurred
}
```

### FR-2: LLM decision (reconcileWithExisting)

Call Claude API (`claude-haiku-4-5-20251001`) with a short reconciliation prompt.

**Prompt:**
```
You are a memory manager. Decide how to integrate new information with existing memories.

Existing memories:
[id=1] user works on Linux
[id=2] project uses PostgreSQL 14
[id=3] user prefers Vim

New information: "migrated database to PostgreSQL 16"

Rules:
- ADD: new info is distinct from all existing memories
- UPDATE id=X content="merged text": new info updates or extends memory X
- DELETE id=X: memory X is contradicted; new info replaces it (you must then ADD)
- NOOP: new info is already captured in existing memories

Reply with exactly one line. No explanation.
Examples: ADD | UPDATE id=2 content="project uses PostgreSQL 16" | DELETE id=2 | NOOP
```

**Decision execution:**
- `ADD` → call `remember(memory)`, return `{ action: 'added' }`
- `UPDATE id=X content="..."` → `UPDATE memories SET content=..., updated_at=now()`, regenerate embedding, return `{ action: 'updated', id: X }`
- `DELETE id=X` → delete X, call `remember(memory)`, return `{ action: 'added', replacedId: X }`
- `NOOP` → return `{ action: 'noop', id: X, content: existing.content }`

### FR-3: Error fallback

- Ollama unavailable → embedding = null → skip similarity search → call `remember()` directly, log `[memory] ollama unavailable, skipping reconciliation`
- Claude API failure → log `[memory] reconcile failed: <err>, falling back to remember()` → call `remember()` directly
- LLM returned unparseable response → same: fallback to `remember()`

### FR-4: Integration points

**`handleRemember` (bot/commands/memory.ts):**
- Replace `remember(...)` with `rememberSmart(...)`
- Reply based on action:
  - `added` → `Saved (#N): ...`
  - `updated` → `Updated #N: ...`
  - `noop` → `Already known (#N): ...`

**MCP tool `remember` (mcp/tools.ts):**
- Replace `remember(...)` with `rememberSmart(...)`
- Include `action` field in tool result for Claude Code

**`summarizeWork` (memory/summarizer.ts):**
- Replace `remember(...)` with `rememberSmart(...)` when saving `project_context`
- On `updated` or `noop` — no duplicate created, existing record is updated in-place

### FR-5: Configuration

Add to `config.ts`:
```typescript
MEMORY_SIMILARITY_THRESHOLD: Number(process.env.MEMORY_SIMILARITY_THRESHOLD ?? "0.35") || 0.35,
MEMORY_RECONCILE_TOP_K: Number(process.env.MEMORY_RECONCILE_TOP_K ?? "5") || 5,
```

## 7. Non-Functional Requirements

- **NFR-1:** LLM reconciliation call ≤ 5s (haiku model, short prompt, single-line output)
- **NFR-2:** Fallback never loses data — on any error, memory is saved via regular `remember()`
- **NFR-3:** No blocking of the main thread — `summarizeWork` is already async, `handleRemember` awaits
- **NFR-4:** No new dependencies or DB migrations required

## 8. Constraints

- Reconciliation model: `claude-haiku-4-5-20251001` (cheap, fast, sufficient for single-line decision)
- Similarity search scope: `project_path` if set, else `chat_id`, else global
- `UPDATE` regenerates embedding via Ollama (same 768 dims, same model)
- No transaction wrapping for DELETE+ADD (acceptable: losing a new fact on crash is unlikely and non-critical)
- Reconciliation respects memory `type`: do not cross-compare `fact` vs `project_context`

## 9. Edge Cases

- **Multiple similar at equal distance:** LLM picks the most relevant one for UPDATE/NOOP
- **LLM suggests UPDATE for non-existent ID:** fallback to ADD, log error
- **`project_context` type:** reconcile scoped strictly to same `project_path`
- **Mixed types in search results:** filter similarity search by `type` to avoid cross-type merging
- **Empty session (0 messages):** `summarizeWork` does not call `rememberSmart` (no change)
- **Concurrent `rememberSmart` calls:** race condition is unlikely; worst case is two inserts (duplicate) — acceptable

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Smart Memory Reconciliation

  Scenario: Duplicate detection — NOOP
    Given memory id=5 "user works on Linux" exists
    When /remember "I'm working on Linux" is called
    Then LLM returns NOOP
    And no new record is created
    And bot replies "Already known (#5): ..."

  Scenario: Fact update — UPDATE
    Given memory id=3 "project uses PostgreSQL 14" exists
    When /remember "migrated to PostgreSQL 16" is called
    Then LLM returns UPDATE id=3 content="project uses PostgreSQL 16"
    And memory #3 content and embedding are updated in place
    And bot replies "Updated #3: ..."

  Scenario: Contradiction — DELETE + ADD
    Given memory id=7 "user uses Vim" exists
    When /remember "switched to Neovim" is called
    Then LLM returns DELETE id=7
    And memory #7 is deleted
    And a new memory is created
    And bot replies "Saved (#8): ..."

  Scenario: Distinct new fact — ADD without LLM
    Given no similar memories exist (distance > threshold)
    When /remember "deploy target is Ubuntu 22.04" is called
    Then LLM is NOT called
    And a new memory is inserted
    And bot replies "Saved (#N): ..."

  Scenario: Ollama unavailable — fallback
    Given Ollama is unreachable
    When /remember "any fact" is called
    Then memory is saved via regular remember()
    And log contains "[memory] ollama unavailable, skipping reconciliation"
    And no error is surfaced to the user

  Scenario: Claude API failure — fallback
    Given Claude API is unreachable
    And similar memories exist
    When /remember "updated fact" is called
    Then memory is saved via regular remember()
    And log contains "[memory] reconcile failed: ..., falling back to remember()"

  Scenario: summarizeWork does not duplicate project_context
    Given project_context id=10 for project 'claude-bot' exists in memories
    When session exits and new project_context is generated
    Then rememberSmart updates record #10 in place
    And no duplicate project_context record is created
```

## 11. Verification

### Testing
- Unit: `parseReconcileDecision()` — all LLM output formats (ADD, UPDATE, DELETE, NOOP, garbage input)
- Unit: `rememberSmart()` with mocked LLM and DB — all branches (fallback, update, noop)
- Integration: `/remember` duplicate → NOOP → `/memories` shows one record
- Integration: `/remember` update → UPDATE → `updated_at` changed, embedding recalculated
- Manual: run 5 related `/remember` calls in sequence, verify `/memories` count stays bounded

### Observability
- `[memory] reconcile: added #N`
- `[memory] reconcile: updated #N`
- `[memory] reconcile: noop #N`
- `[memory] reconcile: replaced #X → added #N`
- `[memory] ollama unavailable, skipping reconciliation`
- `[memory] reconcile failed: <err>, falling back to remember()`
- `[memory] reconcile: LLM returned unknown decision "<raw>", falling back`

### No migrations needed
- DB schema remains at v8
- `UPDATE memories SET content=..., embedding=...` is standard SQL
