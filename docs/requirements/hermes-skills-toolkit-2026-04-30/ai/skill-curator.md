# PRD (AI-readable): Phase B — Skill Curator

```yaml
prd:
  id: hermes-skill-curator
  parent: hermes-skills-toolkit
  phase: B
  date: 2026-04-30
  depends_on: [hermes-autonomous-skill-creator]
  blocks: []
  feature_flag: none
```

## 1. Overview

Background cron job that periodically reviews `agent_created_skills` and applies lifecycle transitions: pin frequently-used, archive stale, consolidate near-duplicates, patch low-quality skills. Uses aux-LLM (separate from main session) to keep prompt cache isolated.

Mirrors `agent/curator.py` from Hermes-Agent: idle-triggered, archives never deletes, only touches `is_agent_created` skills.

## 2. Context

```yaml
trigger:
  cron: "0 3 * * 0"  # Sundays 03:00 UTC, weekly
  scheduler: helyx admin-daemon (existing /home/altsay/bots/helyx/scripts/admin-daemon.ts)
  alt_trigger: idle-detection (no MCP traffic for 2h+) — skipped in v1, fixed cron is simpler
storage:
  state: postgres table `curator_runs` (last_run_at, duration_ms, summary, paused)
  source_data: `agent_created_skills` table (Phase C)
  cost_log: `aux_llm_invocations` table (Phase C)
isolation:
  aux_llm: same client as Phase C distiller (DeepSeek default)
  not_main_claude: critical — main session prompt cache must NOT be touched
actions_curator_can_take:
  - pin (status='active', pinned=true)
  - archive (status='archived', archived_at=now())
  - consolidate (merge two skills into one — implementation: archive old, append text to new)
  - patch (small edit via aux-LLM rewrite)
existing_code:
  scripts/admin-daemon.ts: NEW cron entry
  utils/llm-clients/openai-compatible.ts: reuse from Phase C
```

## 3. Problem Statement

```yaml
problem:
  current: |
    once Phase C is in production, agent-created skills accumulate
    no automatic cleanup → stale skills hang around forever
    near-duplicates pile up (e.g. /git-state, /git-status-snapshot)
    no one notices low-quality skills until they fail in use
  target: |
    weekly curator pass: examine all agent-created skills, recommend actions
    aux-LLM proposes pin/archive/consolidate/patch with reasoning
    helyx applies safe actions automatically (pin, archive)
    risky actions (consolidate, patch) require Telegram confirmation
    user gets weekly summary report
```

## 4. Goals

```yaml
goals:
  - id: G-B-1
    statement: "weekly cron runs the curator on all agent-created skills"
  - id: G-B-2
    statement: "curator NEVER touches user-created skills (is_agent_created=false in v1: all skills in goodai-base/, ~/.claude/skills/<not under agent-created/>) — by table scope, only agent_created_skills considered"
  - id: G-B-3
    statement: "curator NEVER deletes — only archives (matches Hermes invariant)"
  - id: G-B-4
    statement: "pinned skills bypass all auto-transitions"
  - id: G-B-5
    statement: "auto-applied actions: pin, archive (low risk). Confirmation-required: consolidate, patch (touches body)"
  - id: G-B-6
    statement: "curator uses aux-LLM, NOT main session — billing isolation verifiable"
  - id: G-B-7
    statement: "after each run, send a weekly summary message to Telegram supervisor topic"
```

## 5. Non-Goals

```yaml
non_goals:
  - "curate goodai-base or other user skills (out of scope; only agent_created_skills)"
  - "real-time / event-driven curation — fixed cron is sufficient for v1"
  - "ML-driven similarity detection for consolidate (use LLM judgment for v1; vector embeddings = follow-up)"
  - "auto-apply consolidate or patch without human approval — too risky for v1"
  - "curator that learns from user overrides — out of scope"
```

## 6. Functional Requirements

```yaml
fr:
  - id: FR-B-1
    text: "cron entry SHALL run `curator.run()` weekly on Sundays 03:00 UTC; configurable via `HELYX_CURATOR_CRON` env"
  - id: FR-B-2
    text: "curator SHALL select all rows from `agent_created_skills` WHERE status='active' AND pinned=false"
  - id: FR-B-3
    text: "curator SHALL build a single aux-LLM prompt containing all skill names + descriptions + use_count + last_used_at; max 200 skills per run (chunked if more)"
  - id: FR-B-4
    text: "aux-LLM response SHALL list proposed actions per skill: { name, action, reason }; action ∈ {pin, archive, consolidate_with, patch, no_action}"
  - id: FR-B-5
    text: "curator SHALL auto-apply 'pin' (low risk) and 'archive' (Hermes invariant) actions"
  - id: FR-B-6
    text: "curator SHALL queue 'consolidate_with' and 'patch' as Telegram messages with [Approve] [Skip] inline buttons; user has 24h to respond before action expires"
  - id: FR-B-7
    text: "auto-archive criterion: last_used_at older than 90 days (configurable via env)"
  - id: FR-B-8
    text: "auto-pin criterion: use_count > threshold (10) AND last_used_at within 14 days"
  - id: FR-B-9
    text: "every curator run SHALL insert a row in `curator_runs`: started_at, duration_ms, skills_examined, skills_pinned, skills_archived, skills_proposed_consolidate, skills_proposed_patch, status, summary"
  - id: FR-B-10
    text: "summary message SHALL be sent to Telegram (SUPERVISOR_CHAT_ID + SUPERVISOR_TOPIC_ID if configured, else first registered chat)"
  - id: FR-B-11
    text: "curator SHALL be idempotent: re-running on the same data yields the same actions (modulo aux-LLM nondeterminism — which is OK because actions are bounded)"
  - id: FR-B-12
    text: "curator SHALL be pausable: env `HELYX_CURATOR_PAUSED=true` skips all runs with logged reason"
```

## 7. Non-Functional Requirements

```yaml
nfr:
  - id: NFR-B-1
    text: "curator run SHALL complete within 5 minutes p95 for ≤200 skills"
  - id: NFR-B-2
    text: "aux-LLM cost per run SHALL be <$0.10 at typical sizes (200 skills × ~30 tokens metadata + 4096 prompt overhead)"
  - id: NFR-B-3
    text: "curator failure (LLM timeout, network) SHALL NOT crash admin-daemon; logged + retried next schedule"
  - id: NFR-B-4
    text: "Anthropic prompt cache for main session SHALL NOT be invalidated (verify: no API call to main Claude during curator run)"
  - id: NFR-B-5
    text: "consolidate/patch confirmations SHALL expire after 24h to keep Telegram inbox clean"
```

## 8. Constraints

```yaml
constraints:
  technical:
    - "scheduler: existing admin-daemon (no new long-running process)"
    - "aux-LLM: reuse Phase C client (openai-compatible)"
    - "postgres: 1 new table `curator_runs`, no schema changes to agent_created_skills"
  architectural:
    - "curator MUST run inside helyx-bot container (not on Claude Code subprocess)"
    - "curator MUST use aux-LLM client, never main Claude API"
    - "actions MUST be deterministically derived from aux-LLM response (no fuzzy logic)"
    - "actions touching body (patch, consolidate) MUST log before/after diff to `aux_llm_invocations.related_id` chain"
  design:
    - "weekly cadence is conservative; can tune to daily once stable"
    - "single aux-LLM call per run if all skills fit prompt; chunked otherwise (200 skills/chunk)"
    - "summary report includes: counts per action, list of pending confirmations, cost"
```

## 9. Edge Cases

```yaml
edge_cases:
  - case: "aux-LLM proposes consolidate where target doesn't exist"
    handling: "validator rejects, log warning, continue with other actions"
  - case: "aux-LLM proposes archive of a skill used yesterday"
    handling: "violates auto-archive criterion (≥90 days idle); validator rejects"
  - case: "two consolidate proposals targeting same skill"
    handling: "process first, second becomes no-op (target already archived)"
  - case: "aux-LLM unavailable on scheduled run"
    handling: "log warning, set curator_runs.status='skipped', retry next schedule"
  - case: "user manually edits a skill while curator is running"
    handling: "row-level lock OR optimistic concurrency: re-read at apply time, skip if mtime changed since fetch"
  - case: "skill marked is_agent_created=true is also pinned by user"
    handling: "curator skips pinned skills regardless of action recommendation"
  - case: "telegram approval expires before user sees it"
    handling: "log expiry, no action; curator may re-propose on next run"
  - case: "consolidation creates a body >100k chars"
    handling: "validator rejects, fall back to archive of one + keep other unchanged"
  - case: "curator run produces zero actions"
    handling: "still log curator_runs row + send 'all clear' summary"
```

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Phase B — Skill Curator

  Scenario: Cron entry registered on admin-daemon startup
    Given Phase B PR merged
    When admin-daemon starts
    Then a cron entry "0 3 * * 0" exists for `runCurator`
    And it is visible in `mcp__helyx__list_crons` (existing tool)

  Scenario: Auto-archive of stale skill
    Given an agent-created skill with last_used_at = now() - 91 days
    And status='active', pinned=false
    When curator runs and aux-LLM proposes archive for it
    Then status becomes 'archived', archived_at=now()
    And no Telegram confirmation is sent
    And one row in curator_runs reflects skills_archived+=1

  Scenario: Auto-pin of frequently-used skill
    Given an agent-created skill with use_count=15, last_used_at within 14 days
    When curator runs and aux-LLM proposes pin
    Then pinned=true, status='active' (unchanged)
    And no Telegram confirmation is sent

  Scenario: Consolidate proposal requires confirmation
    Given two near-duplicate skills /git-status and /git-state-snapshot
    When curator proposes consolidate_with target=/git-state-snapshot
    Then a Telegram message is sent with [Approve] [Skip]
    And no body is modified yet

  Scenario: Patch proposal requires confirmation
    Given a low-quality skill body
    When curator proposes patch with diff
    Then a Telegram message includes the diff preview
    And [Approve] / [Skip] buttons gate the action

  Scenario: Pinned skill bypasses curator
    Given a pinned agent-created skill marked stale (>90 days)
    When curator runs
    Then no action is taken on this skill
    And curator_runs.skills_examined includes it but no action recorded

  Scenario: Aux-LLM unavailable — graceful skip
    Given DeepSeek and Ollama both unreachable
    When curator runs
    Then curator_runs.status='skipped', error_message logged
    And admin-daemon does NOT crash
    And next scheduled run will retry

  Scenario: Curator does not touch user-created skills
    Given goodai-base skills in ~/.claude/skills/
    And agent-created skills in agent_created_skills table
    When curator runs
    Then only agent_created_skills are queried
    And ~/.claude/skills/ filesystem is not modified except agent-created/ subtree

  Scenario: Main session prompt cache not affected
    Given a curator run completes successfully
    When user sends next message
    Then main Claude session response time matches pre-curator baseline
    And no Anthropic API spike on main key
```

## 11. Verification

```yaml
verification:
  unit_tests:
    file: tests/unit/curator.test.ts
    cases:
      - "select active+unpinned skills only"
      - "auto-archive criterion (>90 days idle)"
      - "auto-pin criterion (use_count>10 && recent)"
      - "consolidate proposal goes to Telegram queue"
      - "patch proposal goes to Telegram queue"
      - "pinned skills excluded from action set"
      - "chunked aux-LLM calls for >200 skills"
      - "curator_runs row inserted with correct counts"
      - "graceful skip on aux-LLM unavailable"
  integration_tests:
    file: tests/unit/curator-integration.test.ts
    cases:
      - "full run on staging postgres with seed data"
      - "Telegram confirmations queued and process callback responses"
  smoke_telegram:
    - "manually trigger curator run via admin-daemon, verify summary message arrives"
  prompt_cache_isolation:
    - "monitor Anthropic API usage during curator run; expect zero requests on main key"
  goodai_regression:
    - "run curator on staging with agent skills present; verify no goodai-base skill is modified"
  rollback_test:
    - "git revert this PR + redeploy → admin-daemon cron entry disappears, curator_runs table dropped"
```

## 12. Implementation Sketch

```yaml
files_to_create:
  - utils/curator/index.ts:
      ~ 200 LOC (orchestrator)
  - utils/curator/select-candidates.ts:
      ~ 80 LOC (query active+unpinned skills)
  - utils/curator/aux-llm-prompt.ts:
      ~ 150 LOC (build prompt, parse response)
  - utils/curator/apply-actions.ts:
      ~ 150 LOC (auto-apply pin/archive, queue consolidate/patch)
  - utils/curator/summary-report.ts:
      ~ 100 LOC (format Telegram summary)
  - prompts/skill-curation.md:
      ~ 100 lines, system prompt for aux-LLM
  - migrations/v42_create_curator_runs.sql:
      ~ 25 LOC
  - tests/unit/curator.test.ts (~ 350 LOC, 12 cases)
  - tests/unit/curator-integration.test.ts (~ 200 LOC, 4 cases)
files_to_modify:
  - scripts/admin-daemon.ts: add cron entry calling `import('../utils/curator').then(m => m.run())`
  - mcp/server.ts: register `mcp__helyx__curator_run` (manual trigger for testing) and `mcp__helyx__curator_status`
  - mcp/tools.ts: add to tool list
  - channel/tools.ts: dispatch cases
  - bot/callbacks.ts: handlers for curator [Approve] / [Skip] inline buttons
  - dashboard/api: new endpoint /api/curator-runs (history view)
  - dashboard/webapp: new page with curator run history + skills lifecycle distribution
  - memory/db.ts: register migration v42
  - CHANGELOG.md: entry under v1.35.0
  - package.json: bump to 1.35.0
  - .env.example: HELYX_CURATOR_CRON, HELYX_CURATOR_PAUSED, HELYX_CURATOR_ARCHIVE_AFTER_DAYS, HELYX_CURATOR_PIN_USE_COUNT
```

```yaml
postgres_schema:
  table_curator_runs:
    columns:
      - id BIGSERIAL PRIMARY KEY
      - started_at TIMESTAMPTZ NOT NULL DEFAULT now()
      - finished_at TIMESTAMPTZ
      - duration_ms INTEGER
      - status TEXT NOT NULL  # 'running' | 'success' | 'skipped' | 'error'
      - skills_examined INTEGER NOT NULL DEFAULT 0
      - skills_pinned INTEGER NOT NULL DEFAULT 0
      - skills_archived INTEGER NOT NULL DEFAULT 0
      - skills_proposed_consolidate INTEGER NOT NULL DEFAULT 0
      - skills_proposed_patch INTEGER NOT NULL DEFAULT 0
      - aux_llm_cost_usd NUMERIC(10,6)
      - error_message TEXT
      - summary TEXT
    indexes:
      - (started_at DESC)
```

```yaml
curation_prompt_skeleton:
  system: |
    You are skill-curation aux. Given a list of agent-created skills with metadata,
    propose lifecycle actions per skill. Allowed actions: pin, archive,
    consolidate_with:<target_name>, patch:<diff>, no_action.
    
    Auto-applied: pin (high use, recent) and archive (stale).
    Confirmation-required: consolidate (merging) and patch (body edit).
    
    Constraints:
    - Never propose archive for skills used within 90 days
    - Propose pin only if use_count > 10 AND last_used_at within 14 days
    - Propose consolidate_with only when names + descriptions show >70% overlap
    - Propose patch only for clearly improvable bodies (e.g. broken inline-shell, typos in steps)
    - When in doubt, choose no_action
    
    Output JSON: { actions: [{ name, action, reason, ... }] }
  user: |
    Skills (max 200):
    <table: name | description | use_count | last_used_at>
```
