# PRD (AI-readable): Phase C — Autonomous Skill Creator

```yaml
prd:
  id: hermes-autonomous-skill-creator
  parent: hermes-skills-toolkit
  phase: C
  date: 2026-04-30
  depends_on: [hermes-inline-shell]
  blocks: [hermes-skill-curator]
  feature_flag: none
```

## 1. Overview

After a successful multi-step task, helyx offers (or autonomously decides) to distill the workflow into a reusable SKILL.md and persist it as an `agent-created` skill. Skill metadata lives in postgres (`agent_created_skills` table); SKILL.md body is regenerated on demand for Claude Code consumption.

## 2. Context

```yaml
trigger_surface:
  - "session boundary: when Claude Code marks a multi-step task as complete (transcript-tail signal)"
  - "explicit user request: `/save-as-skill <name>`"
  - "MCP tool call: `mcp__helyx__propose_skill` (agent self-initiated)"
storage:
  metadata: postgres table `agent_created_skills` (queryable, audited)
  body_render: on-demand via `mcp__helyx__skill_view` (Phase A path)
  body_storage: TEXT column in postgres OR generated on disk to ~/.claude/skills/agent-created/<name>/SKILL.md
  decision: "TEXT in postgres + on-demand on-disk write when Claude Code requests it"
distillation:
  primary: aux-LLM (DeepSeek default, Ollama fallback) sees task transcript + asks for SKILL.md
  prompt_template: file `prompts/skill-distillation.md`
  validation: name ≤64, description ≤1024, body ≤100k, frontmatter valid YAML
existing_code:
  channel/tools.ts: ToolContext + dispatch — extend with `propose_skill`, `save_skill`, `list_agent_skills`
  utils/llm-clients.ts: NEW — generic OpenAI-compatible client for DeepSeek/Ollama
  memory/db.ts: NEW migration v40
```

## 3. Problem Statement

```yaml
problem:
  current: |
    user asks: "fix the kesha jsonb bug"
    agent: investigates → finds postgres.js v3 issue → patches → tests → commits
    end of session: workflow forgotten
    next time same class of bug: agent re-investigates from scratch
  target: |
    end of successful task: agent proposes "save this workflow as skill `/postgres-jsonb-fix`?"
    user confirms (or agent auto-confirms based on heuristics): SKILL.md written
    next time: `/postgres-jsonb-fix` loads the proven steps
    accumulated agent-skills become institutional knowledge
```

## 4. Goals

```yaml
goals:
  - id: G-C-1
    statement: "after a multi-step success, agent CAN call `propose_skill` MCP tool with task summary"
  - id: G-C-2
    statement: "user CAN approve via Telegram inline button OR via `/save-as-skill` command"
  - id: G-C-3
    statement: "auto-approval optional for trusted heuristics: ≥3 tool calls + clean lint/tests + user expressed satisfaction (heuristic v1)"
  - id: G-C-4
    statement: "saved skills are queryable via `agent_created_skills` and visible in dashboard"
  - id: G-C-5
    statement: "saved skill body MAY use Phase A inline-shell tokens for dynamic context"
```

## 5. Non-Goals

```yaml
non_goals:
  - "automatic SKILL.md improvement post-creation — that's Phase B (curator)"
  - "share agent-created skills across users — single installation only"
  - "support frontmatter beyond Hermes-spec subset (name, description, version, author, license, metadata.helyx.{tags,related_skills})"
  - "version-control skills via git inside helyx — they live in postgres only"
  - "fully auto-create without user gate in v1 — opt-in to auto-approval is post-launch tuning"
```

## 6. Functional Requirements

```yaml
fr:
  - id: FR-C-1
    text: "MCP tool `propose_skill` SHALL accept `{ name, description, body, source_session_id }` and return `{ success: bool, skill_id, errors? }`"
  - id: FR-C-2
    text: "MCP tool `save_skill` SHALL accept `{ skill_id, approved: bool }` and finalize the skill (status: 'active') or reject (status: 'rejected')"
  - id: FR-C-3
    text: "MCP tool `list_agent_skills` SHALL return `Array<{ name, description, status, use_count, last_used_at, created_at }>`"
  - id: FR-C-4
    text: "validator SHALL enforce: name regex `^[a-z][a-z0-9-]{0,63}$`, description ≤1024 chars, body ≤100000 chars, frontmatter parseable as YAML mapping"
  - id: FR-C-5
    text: "validator SHALL enforce description starts with 'Use when' (matches goodai-base / Hermes convention)"
  - id: FR-C-6
    text: "on first `skill_view` for an agent-created skill, helyx SHALL write body to ~/.claude/skills/agent-created/<name>/SKILL.md so Claude Code can also load it natively"
  - id: FR-C-7
    text: "unique constraint `(name)` SHALL prevent duplicates; collision returns `{ success: false, errors: ['name already exists'] }`"
  - id: FR-C-8
    text: "distillation aux-LLM call SHALL log to `aux_llm_invocations` table: model, tokens_in, tokens_out, cost_usd, duration_ms, purpose='skill_distillation'"
  - id: FR-C-9
    text: "Telegram approval message SHALL include inline keyboard: [Save] [Reject] [Edit name…] (callback_data routes through bot/callbacks.ts)"
  - id: FR-C-10
    text: "every state transition (proposed → active / rejected / archived) SHALL be timestamped in `agent_created_skills`"
```

## 7. Non-Functional Requirements

```yaml
nfr:
  - id: NFR-C-1
    text: "distillation aux-LLM call SHALL complete within 30s p95 for transcripts ≤16 KB; longer transcripts truncated to last 16 KB"
  - id: NFR-C-2
    text: "distillation cost per skill creation SHALL be <$0.01 (DeepSeek pricing × max prompt size)"
  - id: NFR-C-3
    text: "agent_created_skills table SHALL support 10000 rows without query slowdown (indexed on name, status, last_used_at)"
  - id: NFR-C-4
    text: "on-demand on-disk write SHALL NOT race: file write is `mkdir -p` + `writeFile` atomic via temp+rename"
  - id: NFR-C-5
    text: "dashboard view of agent-created skills SHALL render <500ms for up to 1000 rows"
```

## 8. Constraints

```yaml
constraints:
  technical:
    - "aux-LLM client uses OpenAI-compatible API (works for DeepSeek, Ollama, OpenRouter)"
    - "model selection via env: HELYX_AUX_LLM_PROVIDER ∈ {deepseek, ollama, openrouter}, HELYX_AUX_LLM_MODEL"
    - "default: deepseek + deepseek-chat (already in helyx .env: CUSTOM_OPENAI_BASE_URL=https://api.deepseek.com)"
  architectural:
    - "SKILL.md body lives in postgres TEXT column, not in git — generated on disk only when Claude Code reads it"
    - "agent-created skills MUST live under directory `~/.claude/skills/agent-created/<name>/` so Claude Code's native loader can find them"
    - "directory created with mode 0700 to avoid leaking workflow patterns"
  design:
    - "skill name suggested by aux-LLM, but user can override before approval"
    - "approval flow MAY be skipped via heuristic auto-approval, but heuristic is conservative in v1"
    - "rejected skills retained for 7 days then hard-deleted (allow rollback if user changes mind)"
```

## 9. Edge Cases

```yaml
edge_cases:
  - case: "aux-LLM hallucinates a duplicate name"
    handling: "validator catches via unique constraint, prompts retry with diagnostic; aux-LLM gets the existing names list in next prompt"
  - case: "aux-LLM produces malformed frontmatter"
    handling: "validator rejects, retry once with parser error in prompt; if still bad, fail with diagnostic to user"
  - case: "user wants to rename before approval"
    handling: "callback `Edit name…` opens inline reply; bot waits for `<new-name>`, validates, updates record"
  - case: "name collision after rename"
    handling: "validator reports conflict; suggest suffix (`-2`, `-v2`)"
  - case: "transcripts too long (>16 KB)"
    handling: "truncate to last 16 KB with `[…earlier truncated…]` marker"
  - case: "session has no clear 'success' marker"
    handling: "agent doesn't trigger propose; user can still call `/save-as-skill` explicitly"
  - case: "user keeps approving low-quality skills"
    handling: "out of scope for Phase C; Phase B curator will mark stale ones eventually"
  - case: "filesystem write fails (disk full, permissions)"
    handling: "skill record stays in postgres with status='active' but no file; next skill_view retries write; logged as warning"
```

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

```yaml
verification:
  unit_tests:
    file: tests/unit/skill-distiller.test.ts
    cases:
      - "validator: valid frontmatter accepted"
      - "validator: name regex enforced"
      - "validator: description ≤1024 enforced"
      - "validator: body ≤100k enforced"
      - "validator: 'Use when' prefix enforced"
    file: tests/unit/agent-skill-store.test.ts
    cases:
      - "insert: status='proposed' on first call"
      - "transition: proposed → active on save_skill(approved=true)"
      - "transition: proposed → rejected on save_skill(approved=false)"
      - "unique constraint on name"
      - "lazy file write on first read"
  integration_tests:
    file: tests/unit/aux-llm-client.test.ts
    cases:
      - "DeepSeek call returns response (mocked)"
      - "Ollama call returns response (mocked)"
      - "cost tracking inserts aux_llm_invocations row"
  smoke_telegram:
    - "trigger a multi-step task, verify proposal message arrives, click [Save], verify skill appears in list_agent_skills"
  goodai_regression:
    - "no goodai-base skill is touched; load 3 reference skills, byte-identical output"
  rollback_test:
    - "git revert this PR + redeploy → MCP tools propose_skill/save_skill/list_agent_skills disappear, table dropped via migration down"
```

## 12. Implementation Sketch

```yaml
files_to_create:
  - utils/llm-clients/openai-compatible.ts:
      ~ 200 LOC
  - utils/skill-distiller.ts:
      ~ 250 LOC (prompt building, validation, LLM call orchestration)
  - utils/skill-validator.ts:
      ~ 120 LOC (frontmatter + body checks)
  - mcp/agent-skill-tools.ts:
      ~ 150 LOC (propose_skill, save_skill, list_agent_skills handlers)
  - prompts/skill-distillation.md:
      ~ 60 lines, system prompt for aux-LLM
  - migrations/v40_create_agent_created_skills.sql:
      ~ 40 LOC
  - migrations/v41_create_aux_llm_invocations.sql:
      ~ 25 LOC
  - tests/unit/skill-distiller.test.ts (~ 250 LOC, 8 cases)
  - tests/unit/agent-skill-store.test.ts (~ 200 LOC, 10 cases)
  - tests/unit/aux-llm-client.test.ts (~ 180 LOC, 6 cases)
files_to_modify:
  - mcp/server.ts: register propose_skill, save_skill, list_agent_skills
  - mcp/tools.ts: add to tool list
  - channel/tools.ts: dispatch cases
  - bot/callbacks.ts: add handlers for Save/Reject/Edit-name inline buttons
  - dashboard/api: new endpoint /api/agent-skills (GET list)
  - dashboard/webapp: new page or table for agent-created skills
  - memory/db.ts: register migrations v40, v41
  - CHANGELOG.md: entry under v1.34.0
  - package.json: bump to 1.34.0
  - .env.example: HELYX_AUX_LLM_PROVIDER, HELYX_AUX_LLM_MODEL
```

```yaml
postgres_schema:
  table_agent_created_skills:
    columns:
      - id BIGSERIAL PRIMARY KEY
      - name TEXT NOT NULL UNIQUE
      - description TEXT NOT NULL
      - body TEXT NOT NULL
      - status TEXT NOT NULL DEFAULT 'proposed'  # proposed | active | rejected | archived
      - source_session_id BIGINT
      - source_chat_id TEXT
      - tags TEXT[] DEFAULT ARRAY[]::TEXT[]
      - related_skills TEXT[] DEFAULT ARRAY[]::TEXT[]
      - use_count INTEGER NOT NULL DEFAULT 0
      - last_used_at TIMESTAMPTZ
      - pinned BOOLEAN NOT NULL DEFAULT false
      - proposed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      - approved_at TIMESTAMPTZ
      - rejected_at TIMESTAMPTZ
      - archived_at TIMESTAMPTZ
    indexes:
      - (name)
      - (status, last_used_at DESC)
      - (source_session_id)
  table_aux_llm_invocations:
    columns:
      - id BIGSERIAL PRIMARY KEY
      - purpose TEXT NOT NULL  # 'skill_distillation' | 'skill_curation' | ...
      - provider TEXT NOT NULL  # 'deepseek' | 'ollama' | 'openrouter'
      - model TEXT NOT NULL
      - tokens_in INTEGER NOT NULL
      - tokens_out INTEGER NOT NULL
      - cost_usd NUMERIC(10,6)
      - duration_ms INTEGER NOT NULL
      - status TEXT NOT NULL  # 'success' | 'error' | 'timeout'
      - error_message TEXT
      - related_id BIGINT  # foreign-ish to agent_created_skills.id when applicable
      - created_at TIMESTAMPTZ NOT NULL DEFAULT now()
```

```yaml
distillation_prompt_skeleton:
  system: |
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
        related_skills: []  # leave empty unless explicit reference in transcript
    ---
    
    # <Title>
    
    ## Overview
    <2-3 sentences>
    
    ## When to Use
    - <trigger 1>
    - <trigger 2>
    
    ## Steps
    1. <action with concrete commands; use !`cmd` for dynamic context>
    2. ...
    
    ## Common Pitfalls
    - <pitfall>: <fix>
    
    ## Verification Checklist
    - [ ] <check>
    
    Constraints:
    - description MUST start with "Use when"
    - body ≤100000 chars
    - Use !`cmd` syntax for any dynamic git / fs / env state
    - Generic enough to apply to similar future tasks, specific enough to be useful
  user: |
    Transcript (last 16 KB):
    <transcript>
    
    Suggest a name + the SKILL.md body.
```
