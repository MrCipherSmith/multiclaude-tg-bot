# PRD: Phase C — Autonomous Skill Creator

## 1. Overview

After a successful multi-step task, helyx offers (or autonomously decides) to distill the workflow into a reusable SKILL.md and persist it as an `agent-created` skill. Skill metadata lives in postgres (`agent_created_skills` table); SKILL.md body is regenerated on demand for Claude Code consumption.

Mirrors Hermes' `tools/skill_manager_tool.py::skill_manage(action='create')` + autonomous learning loop, adapted to helyx's Claude-Code-MCP architecture.

## 2. Context

- **Product**: helyx (parent PRD: `./overview.md`)
- **Module**: skill subsystem — new postgres-backed registry + aux-LLM distiller + Telegram approval flow
- **User Role**: skill consumer who tacitly creates skills through productive sessions
- **Tech Stack**: Postgres for registry, Bun for orchestration, OpenAI-compatible aux-LLM (DeepSeek default, Ollama fallback)

**Trigger surfaces**:
1. Session boundary signal — agent self-detects "this was a useful multi-step success" via heuristics
2. Explicit user command — `/save-as-skill <name>`
3. Direct MCP call — agent invokes `mcp__helyx__propose_skill` with summary

**Storage**:
- Skill metadata + body live in postgres (`agent_created_skills` table)
- SKILL.md file is generated on disk lazily, only when Claude Code requests it via Phase A's `skill_view`
- Files written to `~/.claude/skills/agent-created/<name>/SKILL.md` (mode 0700)

**Distillation**:
- aux-LLM (DeepSeek default) sees task transcript + structured prompt
- Prompt template lives in `prompts/skill-distillation.md`
- Validator checks frontmatter, name regex, length limits, "Use when" prefix

## 3. Problem Statement

Today, when the agent solves a complex problem (debug postgres.js v3 jsonb cast, or set up forum topic routing), the workflow disappears with the conversation. Next time the same class of issue arises, it gets re-investigated from scratch — wasted tokens, wasted user time.

Hermes solves this with `is_agent_created` skills + a distillation step. We adapt: helyx maintains a postgres-backed registry of agent-created skills, with a Telegram approval flow gating the human-in-the-loop transition from "proposed" to "active".

## 4. Goals

- **G-C-1** — after a multi-step success, agent CAN call `propose_skill` MCP tool with task summary
- **G-C-2** — user CAN approve via Telegram inline button OR via `/save-as-skill` command
- **G-C-3** — auto-approval optional for trusted heuristics (≥3 tool calls + clean lint/tests + user satisfaction signal)
- **G-C-4** — saved skills are queryable via `agent_created_skills` table and visible in dashboard
- **G-C-5** — saved skill bodies MAY use Phase A inline-shell tokens for dynamic context

## 5. Non-Goals

- Automatic skill improvement post-creation — that's Phase B (curator)
- Sharing agent-created skills across users — single installation only for v1
- Frontmatter beyond Hermes-spec subset (name, description, version, author, license, metadata.helyx.{tags,related_skills})
- Version-control skills via git inside helyx — they live in postgres only
- Fully auto-create without user gate in v1 — heuristic auto-approval is post-launch tuning

## 6. Functional Requirements

- **FR-C-1** — MCP tool `propose_skill` SHALL accept `{ name, description, body, source_session_id }` and return `{ success: bool, skill_id, errors? }`
- **FR-C-2** — MCP tool `save_skill` SHALL accept `{ skill_id, approved: bool }` and finalize (status='active') or reject (status='rejected')
- **FR-C-3** — MCP tool `list_agent_skills` SHALL return `Array<{ name, description, status, use_count, last_used_at, created_at }>`
- **FR-C-4** — Validator SHALL enforce: name regex `^[a-z][a-z0-9-]{0,63}$`, description ≤1024 chars, body ≤100000 chars, frontmatter parseable as YAML mapping
- **FR-C-5** — Validator SHALL enforce description starts with "Use when" (matches goodai-base / Hermes convention)
- **FR-C-6** — On first `skill_view` for an agent-created skill, helyx SHALL write body to `~/.claude/skills/agent-created/<name>/SKILL.md` so Claude Code can also load it natively
- **FR-C-7** — Unique constraint `(name)` SHALL prevent duplicates; collision returns `{ success: false, errors: ['name already exists'] }`
- **FR-C-8** — Distillation aux-LLM call SHALL log to `aux_llm_invocations` table: model, tokens_in, tokens_out, cost_usd, duration_ms, purpose='skill_distillation'
- **FR-C-9** — Telegram approval message SHALL include inline keyboard: [Save] [Reject] [Edit name…] (callbacks routed via `bot/callbacks.ts`)
- **FR-C-10** — Every state transition (proposed → active / rejected / archived) SHALL be timestamped in `agent_created_skills`

## 7. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-C-1 | Distillation aux-LLM call SHALL complete within 30s p95 for transcripts ≤16 KB; longer transcripts truncated to last 16 KB |
| NFR-C-2 | Distillation cost per skill creation SHALL be <$0.01 (DeepSeek pricing × max prompt size) |
| NFR-C-3 | `agent_created_skills` table SHALL support 10000 rows without query slowdown (indexed on name, status, last_used_at) |
| NFR-C-4 | On-demand on-disk write SHALL NOT race: file write is `mkdir -p` + `writeFile` atomic via temp+rename |
| NFR-C-5 | Dashboard view of agent-created skills SHALL render <500ms for up to 1000 rows |

## 8. Constraints

**Technical**:
- aux-LLM client uses OpenAI-compatible API (works for DeepSeek, Ollama, OpenRouter)
- Model selection via env: `HELYX_AUX_LLM_PROVIDER ∈ {deepseek, ollama, openrouter}`, `HELYX_AUX_LLM_MODEL`
- Default: deepseek + deepseek-chat (already in helyx `.env`: `CUSTOM_OPENAI_BASE_URL=https://api.deepseek.com`)

**Architectural**:
- SKILL.md body lives in postgres TEXT column, not in git — generated on disk only when Claude Code reads it
- Agent-created skills MUST live under `~/.claude/skills/agent-created/<name>/` so Claude Code's native loader can find them
- Directory created with mode 0700 to avoid leaking workflow patterns

**Design**:
- Skill name suggested by aux-LLM, but user can override before approval
- Approval flow MAY be skipped via heuristic auto-approval, but heuristic is conservative in v1
- Rejected skills retained for 7 days then hard-deleted (allow rollback if user changes mind)

## 9. Edge Cases

- **aux-LLM hallucinates duplicate name**: validator catches via unique constraint, prompts retry with diagnostic; aux-LLM gets the existing names list in next prompt
- **aux-LLM produces malformed frontmatter**: validator rejects, retry once with parser error in prompt; if still bad, fail with user-visible diagnostic
- **User wants to rename before approval**: callback `Edit name…` opens inline reply; bot waits for `<new-name>`, validates, updates record
- **Name collision after rename**: validator reports conflict; suggest suffix (`-2`, `-v2`)
- **Transcripts too long (>16 KB)**: truncate to last 16 KB with `[…earlier truncated…]` marker
- **Session has no clear "success" marker**: agent doesn't trigger propose; user can still call `/save-as-skill` explicitly
- **User keeps approving low-quality skills**: out of scope for Phase C; Phase B curator marks stale ones eventually
- **Filesystem write fails (disk full, permissions)**: skill record stays in postgres with status='active' but no file; next `skill_view` retries write; logged as warning

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Phase C — Autonomous Skill Creator

  Scenario: Agent proposes a skill after multi-step task
    Given Phase A is in production
    And a user request triggered ≥3 tool calls ending with successful tests
    When the agent calls mcp__helyx__propose_skill with valid name/description/body
    Then a row is inserted in agent_created_skills with status='proposed'
    And a Telegram message is sent with inline buttons [Save] [Reject] [Edit name…]
    And aux_llm_invocations has a row with purpose='skill_distillation'

  Scenario: User approves a proposed skill
    Given a row in agent_created_skills with status='proposed'
    When user clicks [Save] in Telegram
    Then status becomes 'active'
    And ~/.claude/skills/agent-created/<name>/SKILL.md exists with the body
    And subsequent mcp__helyx__skill_view({ name }) returns the body

  Scenario: User rejects a proposed skill
    Given a row with status='proposed'
    When user clicks [Reject]
    Then status becomes 'rejected'
    And no file is written
    And a follow-up cron deletes rejected rows after 7 days

  Scenario: Validation rejects bad frontmatter
    Given the agent calls propose_skill with body lacking valid YAML frontmatter
    When the validator runs
    Then the response is { success: false, errors: ['frontmatter parse error: <details>'] }
    And no row is inserted
    And aux_llm_invocations is NOT logged (validation precedes API)

  Scenario: Name collision is rejected
    Given an existing active skill named "git-state"
    When the agent calls propose_skill with name="git-state"
    Then the response is { success: false, errors: ['name already exists'] }

  Scenario: Description must start with "Use when"
    Given a body with description "git status helper"
    When the validator runs
    Then errors include 'description must start with "Use when"'

  Scenario: Lazy on-disk write on first skill_view
    Given an active agent-created skill with no file at ~/.claude/skills/agent-created/<name>/SKILL.md
    When mcp__helyx__skill_view({ name }) is called
    Then the file is created with body content
    And subsequent calls don't rewrite (timestamp unchanged)

  Scenario: Saved skill can use Phase A inline shell
    Given an agent-created skill body containing "!`date`"
    When mcp__helyx__skill_view is called
    Then the rendered body contains today's date (Phase A preprocessor applied)
```

## 11. Verification

**Unit tests** (`tests/unit/skill-distiller.test.ts`, `tests/unit/skill-validator.test.ts`):
- Validator: valid frontmatter accepted
- Validator: name regex enforced
- Validator: description ≤1024 enforced
- Validator: body ≤100k enforced
- Validator: "Use when" prefix enforced

**Store tests** (`tests/unit/agent-skill-store.test.ts`):
- Insert: status='proposed' on first call
- Transition: proposed → active on `save_skill(approved=true)`
- Transition: proposed → rejected on `save_skill(approved=false)`
- Unique constraint on name
- Lazy file write on first read

**Aux-LLM client tests** (`tests/unit/aux-llm-client.test.ts`, mocked):
- DeepSeek call returns response
- Ollama call returns response
- Cost tracking inserts `aux_llm_invocations` row

**Telegram smoke**:
- Trigger a multi-step task, verify proposal message arrives, click [Save], verify skill appears in `list_agent_skills`

**goodai-base regression**:
- No goodai-base skill is touched; load 3 reference skills, byte-identical output

**Rollback test**:
- `git revert` this PR + redeploy → MCP tools `propose_skill`/`save_skill`/`list_agent_skills` disappear, table dropped via migration down

## 12. Implementation Sketch

**Files to create**:
- `utils/llm-clients/openai-compatible.ts` (~200 LOC)
- `utils/skill-distiller.ts` (~250 LOC, prompt building + LLM call orchestration)
- `utils/skill-validator.ts` (~120 LOC, frontmatter + body checks)
- `mcp/agent-skill-tools.ts` (~150 LOC, propose/save/list handlers)
- `prompts/skill-distillation.md` (~60 lines, system prompt for aux-LLM)
- `migrations/v40_create_agent_created_skills.sql` (~40 LOC)
- `migrations/v41_create_aux_llm_invocations.sql` (~25 LOC)
- `tests/unit/skill-distiller.test.ts` (~250 LOC, 8 cases)
- `tests/unit/agent-skill-store.test.ts` (~200 LOC, 10 cases)
- `tests/unit/aux-llm-client.test.ts` (~180 LOC, 6 cases)

**Files to modify**:
- `mcp/server.ts` — register propose_skill, save_skill, list_agent_skills
- `mcp/tools.ts` — add to tool list
- `channel/tools.ts` — dispatch cases
- `bot/callbacks.ts` — handlers for Save/Reject/Edit-name inline buttons
- `dashboard/api` — new endpoint `/api/agent-skills` (GET list)
- `dashboard/webapp` — new page or table for agent-created skills
- `memory/db.ts` — register migrations v40, v41
- `CHANGELOG.md` — entry under v1.34.0
- `package.json` — bump to 1.34.0
- `.env.example` — `HELYX_AUX_LLM_PROVIDER`, `HELYX_AUX_LLM_MODEL`

**Postgres schema**:

```sql
-- v40_create_agent_created_skills.sql
CREATE TABLE agent_created_skills (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',  -- proposed | active | rejected | archived
  source_session_id BIGINT,
  source_chat_id TEXT,
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  related_skills TEXT[] DEFAULT ARRAY[]::TEXT[],
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  pinned BOOLEAN NOT NULL DEFAULT false,
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ
);
CREATE INDEX agent_created_skills_status_used_at_idx
  ON agent_created_skills (status, last_used_at DESC);
CREATE INDEX agent_created_skills_source_session_idx
  ON agent_created_skills (source_session_id);

-- v41_create_aux_llm_invocations.sql
CREATE TABLE aux_llm_invocations (
  id BIGSERIAL PRIMARY KEY,
  purpose TEXT NOT NULL,         -- skill_distillation | skill_curation | …
  provider TEXT NOT NULL,        -- deepseek | ollama | openrouter
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost_usd NUMERIC(10,6),
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,          -- success | error | timeout
  error_message TEXT,
  related_id BIGINT,             -- foreign-ish to agent_created_skills.id
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX aux_llm_invocations_purpose_created_idx
  ON aux_llm_invocations (purpose, created_at DESC);
```

**Distillation prompt skeleton** (`prompts/skill-distillation.md`):

```markdown
You are skill-distillation aux. Given a session transcript ending with a successful
multi-step task, produce a SKILL.md that captures the workflow as a reusable
procedure. Required output schema:

---
name: <kebab-case, ≤64 chars, regex ^[a-z][a-z0-9-]{0,63}$>
description: "Use when <one-line trigger>. <one-line behavior>."  # ≤1024 chars
version: 1.0.0
author: helyx
license: MIT
metadata:
  helyx:
    tags: [<tag1>, <tag2>]
    related_skills: []
---

# <Title>

## Overview
<2-3 sentences>

## When to Use
- <trigger 1>

## Steps
1. <action; use !`cmd` for dynamic context>

## Common Pitfalls
- <pitfall>: <fix>

## Verification Checklist
- [ ] <check>

Constraints:
- description MUST start with "Use when"
- body ≤100000 chars
- Use !`cmd` syntax for any dynamic git / fs / env state
- Generic enough for similar future tasks, specific enough to be useful
```
