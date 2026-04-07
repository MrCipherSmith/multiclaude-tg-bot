# PRD: Smart Memory Reconciliation — AI-Readable Format

## METADATA
```
feature: smart-memory-reconciliation
date: 2026-04-07
db_schema_version: v8 (no migrations required)
model: claude-haiku-4-5-20251001
affected_files:
  - memory/long-term.ts        # core logic: rememberSmart(), reconcileWithExisting(), parseReconcileDecision()
  - config.ts                  # MEMORY_SIMILARITY_THRESHOLD, MEMORY_RECONCILE_TOP_K
  - bot/commands/memory.ts     # handleRemember: remember() → rememberSmart()
  - mcp/tools.ts               # case "remember": remember() → rememberSmart()
  - memory/summarizer.ts       # summarizeWork: remember() → rememberSmart()
new_dependencies: none
new_tables: none
new_columns: none
```

## DOMAIN MODEL

```
ReconcileDecision =
  | { action: 'ADD' }
  | { action: 'UPDATE', id: number, content: string }
  | { action: 'DELETE', id: number }
  | { action: 'NOOP', id: number }

ReconcileResult =
  | { action: 'added',   id: number, content: string, replacedId?: number }
  | { action: 'updated', id: number, content: string }
  | { action: 'noop',    id: number, content: string }
```

## ALGORITHM: rememberSmart(memory: Memory)

```
STEP 1: embed(memory.content) via Ollama
  IF embedding == null:
    LOG "[memory] ollama unavailable, skipping reconciliation"
    RETURN remember(memory) wrapped as { action: 'added' }

STEP 2: similarity search
  SELECT top-K from memories
  WHERE type = memory.type
    AND (project_path = memory.projectPath OR chat_id = memory.chatId)
  ORDER BY embedding <=> queryEmbedding
  LIMIT CONFIG.MEMORY_RECONCILE_TOP_K  // default 5

STEP 3: threshold check
  IF results.length == 0 OR results[0].distance > CONFIG.MEMORY_SIMILARITY_THRESHOLD (default 0.35):
    RETURN remember(memory) wrapped as { action: 'added' }

STEP 4: LLM reconciliation
  TRY:
    decision = reconcileWithExisting(memory.content, results)  // → ReconcileDecision
  CATCH:
    LOG "[memory] reconcile failed: <err>, falling back to remember()"
    RETURN remember(memory) wrapped as { action: 'added' }

STEP 5: execute decision
  SWITCH decision.action:
    'ADD':
      saved = await remember(memory)
      RETURN { action: 'added', id: saved.id, content: saved.content }

    'UPDATE':
      IF decision.id not in results[].id:
        LOG "[memory] reconcile: UPDATE for unknown id ${decision.id}, falling back"
        saved = await remember(memory)
        RETURN { action: 'added', id: saved.id, content: saved.content }
      newEmbedding = await embedSafe(decision.content)
      await sql`UPDATE memories SET content=${decision.content}, embedding=${newEmbedding}::vector, updated_at=now() WHERE id=${decision.id}`
      RETURN { action: 'updated', id: decision.id, content: decision.content }

    'DELETE':
      await sql`DELETE FROM memories WHERE id=${decision.id}`
      saved = await remember(memory)
      RETURN { action: 'added', id: saved.id, content: saved.content, replacedId: decision.id }

    'NOOP':
      existing = results.find(r => r.id === decision.id) ?? results[0]
      RETURN { action: 'noop', id: existing.id, content: existing.content }
```

## RECONCILIATION PROMPT

```
System: (none)

User:
You are a memory manager. Decide how to integrate new information with existing memories.

Existing memories:
${similar.map(m => `[id=${m.id}] ${m.content}`).join('\n')}

New information: "${newContent}"

Rules:
- ADD: new info is distinct from all existing memories
- UPDATE id=X content="merged text": new info updates or extends memory X
- DELETE id=X: memory X is contradicted; new info replaces it (caller will then ADD)
- NOOP: new info is already captured in existing memories

Reply with exactly one line. No explanation.
Examples: ADD | UPDATE id=2 content="project uses PostgreSQL 16" | DELETE id=2 | NOOP
```

**Model:** `claude-haiku-4-5-20251001`
**max_tokens:** 100
**temperature:** 0

## RESPONSE PARSER: parseReconcileDecision(raw: string)

```
raw = raw.trim()

IF raw === 'ADD':
  RETURN { action: 'ADD' }

IF raw === 'NOOP':
  RETURN { action: 'NOOP', id: -1 }  // id resolved from nearest similar

IF raw matches /^UPDATE id=(\d+) content="(.+)"$/:
  RETURN { action: 'UPDATE', id: parseInt(m[1]), content: m[2] }

IF raw matches /^DELETE id=(\d+)$/:
  RETURN { action: 'DELETE', id: parseInt(m[1]) }

// fallback
LOG "[memory] reconcile: LLM returned unknown decision \"${raw}\", falling back"
THROW ParseError  // caught by STEP 4, triggers fallback
```

## INTEGRATION POINTS

### memory/long-term.ts
```typescript
// NEW exports:
export async function rememberSmart(memory: Memory): Promise<ReconcileResult>
async function reconcileWithExisting(newContent: string, similar: Memory[]): Promise<ReconcileDecision>
function parseReconcileDecision(raw: string): ReconcileDecision
```

### config.ts
```typescript
MEMORY_SIMILARITY_THRESHOLD: Number(process.env.MEMORY_SIMILARITY_THRESHOLD ?? "0.35") || 0.35,
MEMORY_RECONCILE_TOP_K: Number(process.env.MEMORY_RECONCILE_TOP_K ?? "5") || 5,
```

### bot/commands/memory.ts — handleRemember
```typescript
// BEFORE:
const m = await remember({ source: "telegram", ..., type: "note", content });
await ctx.reply(`Saved (#${m.id}, ...): ${content.slice(0, 100)}`);

// AFTER:
const result = await rememberSmart({ source: "telegram", ..., type: "note", content });
const label =
  result.action === 'added'   ? `Saved (#${result.id})` :
  result.action === 'updated' ? `Updated #${result.id}` :
                                `Already known (#${result.id})`;
await ctx.reply(`${label}: ${result.content.slice(0, 100)}`);
```

### mcp/tools.ts — case "remember"
```typescript
// BEFORE:
const m = await remember({ ... });
return { content: [{ type: "text", text: `Saved memory #${m.id}` }] };

// AFTER:
const result = await rememberSmart({ ... });
return { content: [{ type: "text", text: `Memory ${result.action} #${result.id}` }] };
```

### memory/summarizer.ts — summarizeWork
```typescript
// BEFORE:
const mem = await remember({
  source: "api", type: "project_context", sessionId: null, projectPath, content: summaryText
});

// AFTER:
const mem = await rememberSmart({
  source: "api", type: "project_context", sessionId: null, projectPath, content: summaryText
});
// mem.action will be 'added' | 'updated' | 'noop'
// log: [summarizer] project_context ${mem.action} #${mem.id}
```

## ACCEPTANCE CRITERIA (GHERKIN)

```gherkin
Feature: Smart Memory Reconciliation

  Scenario: NOOP on duplicate
    Given memories contains: id=5, type="note", content="user works on Linux", project_path="/bots/claude-bot"
    And distance(embed("I'm working on Linux"), embed("user works on Linux")) < 0.35
    When rememberSmart({ content: "I'm working on Linux", type: "note", projectPath: "/bots/claude-bot" })
    Then Claude API called with existing=[id=5 "user works on Linux"] and new="I'm working on Linux"
    And Claude returns "NOOP"
    And no INSERT or UPDATE executed
    And result = { action: 'noop', id: 5, content: "user works on Linux" }

  Scenario: UPDATE on extension
    Given memories contains: id=3, type="fact", content="project uses PostgreSQL 14"
    When rememberSmart({ content: "migrated to PostgreSQL 16", type: "fact" })
    And Claude returns "UPDATE id=3 content=\"project uses PostgreSQL 16\""
    Then sql: UPDATE memories SET content="project uses PostgreSQL 16", embedding=<new_vec>, updated_at=now() WHERE id=3
    And result = { action: 'updated', id: 3, content: "project uses PostgreSQL 16" }

  Scenario: DELETE+ADD on contradiction
    Given memories contains: id=7, type="note", content="user uses Vim"
    When rememberSmart({ content: "switched to Neovim", type: "note" })
    And Claude returns "DELETE id=7"
    Then sql: DELETE FROM memories WHERE id=7
    And sql: INSERT INTO memories (content="switched to Neovim", ...)
    And result = { action: 'added', id: 8, content: "switched to Neovim", replacedId: 7 }

  Scenario: ADD when distance > threshold
    Given no memories with distance < 0.35 to "deploy target is Ubuntu 22.04"
    When rememberSmart({ content: "deploy target is Ubuntu 22.04" })
    Then Claude API NOT called
    And sql: INSERT INTO memories
    And result = { action: 'added', id: N, content: "deploy target is Ubuntu 22.04" }

  Scenario: Fallback on Ollama failure
    Given Ollama returns null embedding
    When rememberSmart({ content: "any fact" })
    Then Claude API NOT called
    And sql: INSERT INTO memories (embedding=NULL)
    And result.action = 'added'
    And log = "[memory] ollama unavailable, skipping reconciliation"

  Scenario: Fallback on Claude API failure
    Given distance < threshold (similar memories exist)
    And Claude API throws error
    When rememberSmart({ content: "updated fact" })
    Then sql: INSERT INTO memories
    And result.action = 'added'
    And log matches "[memory] reconcile failed: .+, falling back to remember()"

  Scenario: summarizeWork deduplication
    Given memories contains: id=10, type="project_context", project_path="/bots/claude-bot", content="[DECISIONS]..."
    When summarizeWork(sessionId, projectPath="/bots/claude-bot") generates new project_context text
    And distance(new_embed, embed(existing)) < 0.35
    And Claude returns "UPDATE id=10 content=\"[merged content]\""
    Then memories count for type=project_context AND project_path="/bots/claude-bot" stays = 1
    And memories.id=10 has updated content and embedding
```

## OBSERVABILITY

```
[memory] reconcile: added #N
[memory] reconcile: updated #N (was: "old content")
[memory] reconcile: noop #N
[memory] reconcile: replaced #X → added #N
[memory] ollama unavailable, skipping reconciliation
[memory] reconcile failed: <error_message>, falling back to remember()
[memory] reconcile: LLM returned unknown decision "<raw_output>", falling back
[memory] reconcile: UPDATE for unknown id <id>, falling back to ADD
```

## CONSTRAINTS

```
model:             claude-haiku-4-5-20251001
max_tokens:        100
temperature:       0
no_new_deps:       true
no_migrations:     true
scope_filter:      similarity search filtered by memory.type (no cross-type reconciliation)
transaction:       none (DELETE+ADD is non-transactional; acceptable)
concurrent_writes: no locking (rare duplicate on race condition is acceptable)
```
