# PRD: Phase A — Inline Shell Expansion

## 1. Overview

Add a helyx-side preprocessing step that expands `` !`cmd` `` tokens in SKILL.md bodies into the stdout of the executed command, before the rendered text reaches the LLM. Mirrors `agent/skill_preprocessing.py::expand_inline_shell` from Hermes-Agent.

## 2. Context

- **Product**: helyx (parent PRD: `./overview.md`)
- **Module**: skill subsystem — new helyx-side preprocessor + MCP tool
- **User Role**: skill author (writes SKILL.md), skill consumer (LLM via Claude Code)
- **Tech Stack**: Bun spawn for shell execution, MCP SDK for tool exposure, Postgres for invocation log

**Delivery path**:
- New module `utils/skill-preprocessor.ts` performs the regex match + spawn + replace
- New MCP tool `mcp__helyx__skill_view` returns post-preprocessing body
- Claude Code invokes this tool when it wants to load a skill (replacing the native filesystem read)

The native Claude Code loader is NOT modified — we expose a parallel path via MCP. Skills that don't use `` !`cmd` `` syntax behave identically whether loaded natively or via this tool.

## 3. Problem Statement

Skills today inject only static markdown. Any dynamic context — git status, environment state, file listing — requires the LLM to make a tool call (`Bash`, `Read`, `Grep`). That's an extra round-trip: ~150 tokens for the call + ~500ms latency per dependency.

Hermes solves this by running shell commands at skill load time and embedding their output directly into the rendered body. A `/git-state` skill goes from "tell the LLM to run git status" to "here's git status, draw conclusions".

## 4. Goals

- **G-A-1** — skills MAY embed `` !`cmd` `` tokens; helyx preprocessor resolves to stdout before delivery
- **G-A-2** — skills WITHOUT `` !`cmd` `` tokens load identically to today (zero behavioral change)
- **G-A-3** — preprocessor adds ≤200ms median latency for skills with no shell tokens
- **G-A-4** — shell command execution is sandboxed: per-cmd timeout, output cap, non-root user

## 5. Non-Goals

- Support Hermes' template vars (`${HERMES_SKILL_DIR}` / `${HERMES_SESSION_ID}`) — separate ticket if/when needed
- Intercept Claude Code's native skill loading — we add a parallel MCP tool, native loader stays untouched
- Execute commands as anyone other than the helyx container's `bun` user
- Support multi-line shell commands — one-liners only, matches Hermes regex behavior

## 6. Functional Requirements

- **FR-A-1** — Preprocessor SHALL match the regex `` !`([^`\n]+)` `` (single-line backtick-bounded). Same as Hermes' `_INLINE_SHELL_RE`.
- **FR-A-2** — For each match, preprocessor SHALL execute the captured command via `Bun.spawn(['bash', '-c', cmd])` with `cwd=skillDir`, `timeout=5000ms` (configurable via env), `stdout=pipe`, `stderr=pipe`.
- **FR-A-3** — Command stdout SHALL replace the entire `` !`...` `` token in the rendered body.
- **FR-A-4** — If command exits non-zero, replacement string SHALL be `[inline-shell error: <stderr first 500 chars>]`.
- **FR-A-5** — If command exceeds timeout, replacement string SHALL be `[inline-shell timeout after Ns: <command>]`.
- **FR-A-6** — Stdout SHALL be truncated to 4096 chars + `…[truncated]` suffix.
- **FR-A-7** — Preprocessor SHALL execute commands sequentially (no parallelism) to keep behavior deterministic.
- **FR-A-8** — Skills WITHOUT `` !`cmd` `` tokens SHALL bypass spawn — fast path = unchanged content.
- **FR-A-9** — MCP tool `skill_view` SHALL accept `{ name: string }` and return `{ name, description, body, frontmatter }` — body is post-preprocessing.
- **FR-A-10** — Every preprocessor invocation SHALL log to postgres table `skill_preprocess_log` with: skill_name, started_at, duration_ms, shell_count, errors_count.

## 7. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-A-1 | Skills with no shell tokens — load latency p50 ≤ 50ms (vs ~30ms baseline native load) |
| NFR-A-2 | Skills with N shell tokens — load latency ≤ N × cmd_timeout + 100ms preprocessing overhead |
| NFR-A-3 | Memory cap on stdout buffer: 4096 chars per command, hard limit |
| NFR-A-4 | Runtime: TypeScript on Bun (matches existing helyx stack) |
| NFR-A-5 | Integration test loads 3 sample goodai-base skills and verifies byte-identical output to native loader |

## 8. Constraints

**Technical**:
- MUST run inside helyx-bot container (postgres + cron access)
- MUST NOT execute as root (current container runs as `bun` user — keep that)
- MUST use `Bun.spawn(['bash', '-c', cmd])` with command from SKILL.md only (skill author is trusted, but log everything)
- MUST add a postgres migration (versioned alongside existing `memory/db.ts` registry)

**Architectural**:
- MUST NOT change existing `channel/tools.ts` dispatch behavior for non-skill-related tools
- MUST be reverted by `git revert` of the single PR — no manual cleanup needed

## 9. Edge Cases

- **Skill body has unclosed backtick** (`` `!`malformed `` ): regex requires balanced backticks; unclosed token left verbatim
- **Command output contains `` !`...` `` syntax itself**: preprocessor runs ONCE — nested tokens NOT recursively expanded (matches Hermes)
- **Command produces binary output**: stdout buffered as utf-8 with replacement char for invalid bytes
- **Skill missing on disk**: skill_view returns `{ error: 'skill not found', name }` JSON
- **Skill body already contains rendered shell output (idempotency)**: preprocessor only matches `` !`...` `` regex — already-rendered text isn't re-processed
- **Concurrent skill_view requests for same skill**: no per-skill lock — each invocation runs commands fresh; commands MUST be idempotent (skill author's contract, documented)
- **Command needs PATH adjustments**: run with `process.env` (full inheritance) — command can `cd` or set vars itself in the body

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Phase A — Inline Shell Expansion

  Scenario: Skill without inline shell tokens loads unchanged
    Given a SKILL.md file at ~/.claude/skills/sample-static/SKILL.md
    And the body contains no "!`" tokens
    When mcp__helyx__skill_view({ name: "sample-static" }) is called
    Then the returned body is byte-identical to the SKILL.md body
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
    When mcp__helyx__skill_view is called
    Then the returned body matches /^Result: \[inline-shell error: /
    And the daemon does not crash
    And one row in skill_preprocess_log has errors_count=1

  Scenario: Skill with timeout-exceeded shell token shows timeout marker
    Given a SKILL.md file with body "Wait: !`sleep 10`"
    And the configured per-command timeout is 5000ms
    When mcp__helyx__skill_view is called
    Then the returned body matches /^Wait: \[inline-shell timeout after 5s: sleep 10\]/
    And the actual response time is < 5500ms

  Scenario: Output cap applied
    Given a SKILL.md file with body "Big: !`yes | head -10000`"
    When mcp__helyx__skill_view is called
    Then the rendered body has length ≤ 4096 + len("Big: ") + len("…[truncated]")
    And ends with "…[truncated]"

  Scenario: goodai-base skill loads identically to native loader
    Given a goodai-base skill at ~/.claude/skills/feature-analyzer/SKILL.md
    When mcp__helyx__skill_view is called
    Then the returned body is byte-identical to the file body section
```

## 11. Verification

**Unit tests** (`tests/unit/skill-preprocessor.test.ts`):
- regex matches single-line `` !`...` `` only
- no-token skill returns input unchanged
- single-cmd skill replaces token with stdout
- failed-cmd produces inline-shell error marker
- timeout produces inline-shell timeout marker
- output truncation at 4096 bytes
- binary output sanitized to utf-8 replacement char

**Integration tests** (`tests/unit/mcp-skill-view.test.ts`):
- MCP tool registered and callable
- 404 on missing skill
- postgres log row inserted on every invocation

**Telegram smoke**:
- Deploy to staging, send a message that triggers `/git-state` skill, verify response includes live git output
- Send 3 messages without triggering preprocessor — TTS still works as before

**goodai-base regression**:
- Load `/feature-analyzer`, `/review-orchestrator`, `/job-orchestrator` via skill_view → byte-identical to native loader read

**Rollback test**:
- `git revert` this PR + redeploy → skill_view tool returns "unknown tool", no schema migration drift

## 12. Implementation Sketch

**Files to create**:
- `utils/skill-preprocessor.ts` — exports `preprocessSkillBody`, `runInlineShell` (~150 LOC)
- `mcp/skill-view-tool.ts` — exports `registerSkillViewTool` (~50 LOC)
- `tests/unit/skill-preprocessor.test.ts` (~200 LOC, 12 cases)
- `tests/unit/mcp-skill-view.test.ts` (~80 LOC, 5 cases)
- `migrations/v39_create_skill_preprocess_log.sql` (~20 LOC)

**Files to modify**:
- `mcp/server.ts` — register `skill_view` tool schema
- `mcp/tools.ts` — add `skill_view` to tool list
- `channel/tools.ts` — add `skill_view` dispatch case
- `memory/db.ts` — register migration v39
- `CHANGELOG.md` — entry under v1.33.0
- `package.json` — bump to 1.33.0

**Demo skill**:

```markdown
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

**Postgres migration**:

```sql
-- v39_create_skill_preprocess_log.sql
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

**Configuration** (env-driven, no required settings):
- `HELYX_SHELL_TIMEOUT_MS` — per-command timeout (default 5000)
- `HELYX_SHELL_OUTPUT_CAP` — max stdout bytes per command (default 4096)
