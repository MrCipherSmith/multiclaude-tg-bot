# PRD (AI-readable): Phase A — Inline Shell Expansion

```yaml
prd:
  id: hermes-inline-shell
  parent: hermes-skills-toolkit
  phase: A
  date: 2026-04-30
  blocks: [autonomous-skill-creator, skill-curator]
  feature_flag: none
```

## 1. Overview

Add a helyx-side preprocessing step that expands `` !`cmd` `` tokens in SKILL.md bodies into the stdout of the executed command, before the rendered text reaches the LLM. Mirrors `agent/skill_preprocessing.py::expand_inline_shell` from Hermes.

## 2. Context

```yaml
delivery_path:
  layer: helyx-MCP server (channel/tools.ts dispatch)
  new_module: utils/skill-preprocessor.ts
  integration: new MCP tool `mcp__helyx__skill_view` that returns preprocessed body
mechanism:
  trigger: Claude Code invokes `mcp__helyx__skill_view` instead of native skill load
  alt_trigger: PreToolUse hook (rejected — too coupled to Claude Code internals)
  user_visible_change: skill body in conversation context contains expanded shell output instead of literal `!`cmd``
existing_code:
  channel/tools.ts: ToolContext + dispatch table — extend with `skill_view` case
  mcp/server.ts: tool registration — add `skill_view` schema
  mcp/tools.ts: tool list — add `skill_view`
  hooks: none used today
```

## 3. Problem Statement

```yaml
problem:
  current: "skills inject only static markdown; dynamic context (git status, env state, file listing) requires the LLM to call Bash() — extra round-trip, ~150 tokens, ~500ms"
  target: "skills can embed `!`cmd`` tokens that resolve at load time"
  example_skill_today: |
    /git-state asks LLM: "Run `git status` and tell me the result..."
    LLM: tool_call Bash('git status') → tool_result → LLM responds
    cost: 1 extra round-trip + Bash tool tokens
  example_skill_after: |
    /git-state body: "Branch: !`git rev-parse --abbrev-ref HEAD`\nStatus:\n!`git status`"
    helyx preprocesses → LLM sees rendered status directly
    cost: 0 extra round-trips
```

## 4. Goals

```yaml
goals:
  - id: G-A-1
    statement: "skills MAY embed `!`cmd`` tokens; helyx preprocessor resolves to stdout before delivery"
  - id: G-A-2
    statement: "skills WITHOUT `!`cmd`` tokens load identically to today (zero behavioral change)"
  - id: G-A-3
    statement: "preprocessor adds ≤200ms median latency for skills with no shell tokens"
  - id: G-A-4
    statement: "shell-cmd execution is sandboxed: per-cmd timeout, output cap, no shell injection of skill author's input"
```

## 5. Non-Goals

```yaml
non_goals:
  - "support Hermes' template vars `${HERMES_SKILL_DIR}` / `${HERMES_SESSION_ID}` — separate ticket if/when needed"
  - "intercept Claude Code's NATIVE skill loading — we add a parallel MCP tool, native loader stays untouched"
  - "execute commands as anyone other than the helyx container's bun user"
  - "support multi-line shell commands (one-liners only — matches Hermes)"
```

## 6. Functional Requirements

```yaml
fr:
  - id: FR-A-1
    text: "preprocessor SHALL match the regex `!`([^`\\n]+)`` (single-line backtick-bounded)"
    rationale: "exact same regex as Hermes' `_INLINE_SHELL_RE`"
  - id: FR-A-2
    text: "for each match, preprocessor SHALL execute the captured command via `bun spawn` with: `cwd=skillDir`, `timeout=5000ms` (configurable), `stdout=pipe`, `stderr=pipe`"
  - id: FR-A-3
    text: "command stdout SHALL replace the entire `!`...`` token in the rendered body"
  - id: FR-A-4
    text: "if command exits non-zero, replacement string SHALL be `[inline-shell error: <stderr first 500 chars>]`"
  - id: FR-A-5
    text: "if command exceeds timeout, replacement string SHALL be `[inline-shell timeout after Ns: <command>]`"
  - id: FR-A-6
    text: "stdout SHALL be truncated to 4096 chars + `…[truncated]` suffix"
  - id: FR-A-7
    text: "preprocessor SHALL execute commands SEQUENTIALLY (no parallel) to keep behavior deterministic"
  - id: FR-A-8
    text: "skills WITHOUT `!`cmd`` tokens SHALL bypass spawn — fast path = unchanged content"
  - id: FR-A-9
    text: "MCP tool `skill_view` SHALL accept `{ name: string }` and return `{ name, description, body, frontmatter }` — body is post-preprocessing"
  - id: FR-A-10
    text: "every preprocessor invocation SHALL log to postgres table `skill_preprocess_log` with: skill_name, started_at, duration_ms, shell_count, errors_count"
```

## 7. Non-Functional Requirements

```yaml
nfr:
  - id: NFR-A-1
    text: "skills with no shell tokens — load latency p50 ≤ 50ms (vs ~30ms baseline native load)"
  - id: NFR-A-2
    text: "skills with N shell tokens — load latency ≤ N × cmd_timeout + 100ms preprocessing overhead"
  - id: NFR-A-3
    text: "memory cap on stdout buffer: 4096 chars per command, hard limit"
  - id: NFR-A-4
    text: "runtime: TypeScript on Bun (matches existing helyx stack)"
  - id: NFR-A-5
    text: "integration test SHALL load 3 sample goodai-base skills and verify byte-identical output to native loader"
```

## 8. Constraints

```yaml
constraints:
  - "MUST run inside helyx-bot container (postgres + cron access)"
  - "MUST NOT execute as root (current container runs as `bun` user — keep that)"
  - "MUST NOT shell-out to system shell with user-controlled string — use `Bun.spawn(['bash', '-c', cmd])` with command from SKILL.md only (skill author is trusted, but log everything)"
  - "MUST NOT change existing channel/tools.ts dispatch behavior for non-skill-related tools"
  - "MUST add a postgres migration `vNN_create_skill_preprocess_log.sql`"
```

## 9. Edge Cases

```yaml
edge_cases:
  - case: "skill body has ``!`malformed`` (unclosed backtick)"
    handling: "regex requires balanced backticks; unclosed token left verbatim"
  - case: "command output contains `!`...`` syntax itself"
    handling: "preprocessor runs ONCE — nested tokens NOT recursively expanded (matches Hermes)"
  - case: "command produces binary output"
    handling: "stdout buffered as utf-8 with replacement char for invalid bytes"
  - case: "skill missing on disk"
    handling: "skill_view returns 404-equivalent JSON `{ error: 'skill not found', name }`"
  - case: "skill body already contains rendered shell output (idempotency)"
    handling: "preprocessor only matches `!`...`` regex — already-rendered text isn't re-processed"
  - case: "concurrent skill_view requests for same skill"
    handling: "no per-skill lock — each invocation runs commands fresh; commands MUST be idempotent (skill author's contract, documented)"
  - case: "command needs PATH adjustments"
    handling: "run with `process.env` (full inheritance) — command can `cd` or set vars itself in the body"
```

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Phase A — Inline Shell Expansion

  Scenario: Skill without inline shell tokens loads unchanged
    Given a SKILL.md file at ~/.claude/skills/sample-static/SKILL.md
    And the body contains no "!`" tokens
    When mcp__helyx__skill_view({ name: "sample-static" }) is called
    Then the returned body is byte-identical to the SKILL.md file body
    And the response time is < 50ms p50
    And no row is added to skill_preprocess_log

  Scenario: Skill with one shell token expands it
    Given a SKILL.md file with body "Today: !`date +%Y-%m-%d`"
    When mcp__helyx__skill_view({ name: "today" }) is called
    Then the returned body matches /^Today: \d{4}-\d{2}-\d{2}$/
    And the response time is < 200ms p50
    And one row is added to skill_preprocess_log with shell_count=1, errors_count=0

  Scenario: Skill with failing shell token shows error inline
    Given a SKILL.md file with body "Result: !`exit 1`"
    When mcp__helyx__skill_view({ name: "fail-cmd" }) is called
    Then the returned body matches /^Result: \[inline-shell error: /
    And the daemon does not crash
    And one row is added to skill_preprocess_log with errors_count=1

  Scenario: Skill with timeout-exceeded shell token shows timeout marker
    Given a SKILL.md file with body "Wait: !`sleep 10`"
    And the configured per-command timeout is 5000ms
    When mcp__helyx__skill_view({ name: "slow" }) is called
    Then the returned body matches /^Wait: \[inline-shell timeout after 5s: sleep 10\]/
    And the actual response time is < 5500ms

  Scenario: Output cap applied
    Given a SKILL.md file with body "Big: !`yes | head -10000`"
    When mcp__helyx__skill_view is called
    Then the rendered body has length ≤ 4096 + len("Big: ") + len("…[truncated]")
    And ends with "…[truncated]"

  Scenario: goodai-base skill loads identically to native loader
    Given a goodai-base skill at ~/.claude/skills/feature-analyzer/SKILL.md
    When mcp__helyx__skill_view({ name: "feature-analyzer" }) is called
    Then the returned body is byte-identical to a `cat ~/.claude/skills/feature-analyzer/SKILL.md` of the body section

  Scenario: Postgres schema migration applied
    Given migration v39_create_skill_preprocess_log.sql is in registry
    When helyx-bot starts
    Then table skill_preprocess_log exists with columns: id, skill_name, started_at, duration_ms, shell_count, errors_count
    And no other table is altered
```

## 11. Verification

```yaml
verification:
  unit_tests:
    file: tests/unit/skill-preprocessor.test.ts
    cases:
      - "regex matches single-line `!`...`` only"
      - "no-token skill returns input unchanged"
      - "single-cmd skill replaces token with stdout"
      - "failed-cmd produces inline-shell error marker"
      - "timeout produces inline-shell timeout marker"
      - "output truncation at 4096 bytes"
      - "binary output sanitized to utf-8 replacement char"
  integration_tests:
    file: tests/unit/mcp-skill-view.test.ts
    cases:
      - "MCP tool registered and callable"
      - "404 on missing skill"
      - "postgres log row inserted on every invocation"
  smoke_telegram:
    - "deploy to staging, send a message that triggers /git-state skill, verify response includes live git output"
    - "send 3 messages without triggering preprocessor — TTS still works as before kesha removal"
  goodai_regression:
    - "load /feature-analyzer, /review-orchestrator, /job-orchestrator via skill_view → byte-identical to native loader read"
  rollback_test:
    - "git revert this PR + redeploy → skill_view tool returns 'unknown tool', no schema migration drift"
```

## 12. Implementation Sketch

```yaml
files_to_create:
  - utils/skill-preprocessor.ts:
      exports: [preprocessSkillBody, runInlineShell]
      ~ 150 LOC
  - mcp/skill-view-tool.ts:
      exports: [registerSkillViewTool]
      ~ 50 LOC
  - tests/unit/skill-preprocessor.test.ts:
      ~ 200 LOC, 12 cases
  - tests/unit/mcp-skill-view.test.ts:
      ~ 80 LOC, 5 cases
  - migrations/v39_create_skill_preprocess_log.sql:
      ~ 20 LOC
files_to_modify:
  - mcp/server.ts: register skill_view tool schema
  - mcp/tools.ts: add skill_view to tool list
  - channel/tools.ts: add skill_view dispatch case (or delegate to mcp/skill-view-tool.ts)
  - memory/db.ts: register migration
  - CHANGELOG.md: add entry under v1.33.0
  - package.json: bump to 1.33.0
```

```yaml
demo_skill:
  path: ~/.claude/skills/git-state/SKILL.md
  content: |
    ---
    name: git-state
    description: "Use when you need a snapshot of the current git working state"
    version: 1.0.0
    author: helyx
    license: MIT
    ---
    
    # Git State Snapshot
    
    Branch: !`git rev-parse --abbrev-ref HEAD`
    
    Last commit: !`git log -1 --format='%h %s (%an, %ar)'`
    
    Working tree:
    ```
    !`git status --short`
    ```
    
    Diff summary:
    ```
    !`git diff --stat`
    ```
```

```yaml
postgres_migration:
  file: migrations/v39_create_skill_preprocess_log.sql
  sql: |
    CREATE TABLE skill_preprocess_log (
      id BIGSERIAL PRIMARY KEY,
      skill_name TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL,
      shell_count INTEGER NOT NULL DEFAULT 0,
      errors_count INTEGER NOT NULL DEFAULT 0,
      first_error TEXT
    );
    CREATE INDEX skill_preprocess_log_started_at_idx
      ON skill_preprocess_log (started_at DESC);
```
