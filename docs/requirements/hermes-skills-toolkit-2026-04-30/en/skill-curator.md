# PRD: Phase B — Skill Curator

## 1. Overview

Background cron job that periodically reviews `agent_created_skills` and applies lifecycle transitions: pin frequently-used, archive stale, consolidate near-duplicates, patch low-quality skills. Uses aux-LLM (separate from main session) to keep prompt cache isolated.

Mirrors `agent/curator.py` from Hermes-Agent: idle-triggered, archives never deletes, only touches `is_agent_created` skills.

## 2. Context

- **Product**: helyx (parent PRD: `./overview.md`)
- **Module**: skill subsystem — background lifecycle management
- **User Role**: skill consumer who tacitly benefits from curated skill collection
- **Tech Stack**: Postgres for curator state, existing `admin-daemon.ts` for cron scheduling, OpenAI-compatible aux-LLM (DeepSeek default)

**Trigger**:
- Cron `0 3 * * 0` (Sundays 03:00 UTC, weekly) — configurable via env `HELYX_CURATOR_CRON`
- Scheduler: existing `scripts/admin-daemon.ts` (no new long-running process)

**Source data**:
- `agent_created_skills` table from Phase C (only `status='active' AND pinned=false`)
- Cost log: `aux_llm_invocations` table from Phase C

**Isolation**:
- aux-LLM client is the same as Phase C distiller (DeepSeek default, Ollama fallback)
- Critical: main Claude session prompt cache MUST NOT be touched

**Actions curator can take**:
1. **pin** — `pinned=true` (auto-applied for high-use recent skills)
2. **archive** — `status='archived', archived_at=now()` (auto-applied for stale skills)
3. **consolidate** — merge two skills into one (requires Telegram approval)
4. **patch** — small edit via aux-LLM rewrite (requires Telegram approval)

## 3. Problem Statement

Once Phase C ships, agent-created skills accumulate. Without periodic review:
- Stale skills (unused for months) hang around forever
- Near-duplicates pile up (e.g. `/git-state`, `/git-status-snapshot`)
- Low-quality skills go unnoticed until they fail in use

Hermes' curator solves this with a weekly aux-LLM-driven pass that proposes pin/archive/consolidate/patch and applies safe actions automatically while gating risky ones behind human approval.

## 4. Goals

- **G-B-1** — weekly cron runs the curator on all agent-created skills
- **G-B-2** — curator NEVER touches user-created skills (by table scope: only `agent_created_skills` queried)
- **G-B-3** — curator NEVER deletes — only archives (matches Hermes invariant)
- **G-B-4** — pinned skills bypass all auto-transitions
- **G-B-5** — auto-applied: pin, archive (low risk). Confirmation-required: consolidate, patch (touches body)
- **G-B-6** — curator uses aux-LLM, NOT main session — billing isolation verifiable
- **G-B-7** — after each run, send a weekly summary message to Telegram supervisor topic

## 5. Non-Goals

- Curate goodai-base or other user skills — only `agent_created_skills`
- Real-time / event-driven curation — fixed cron is sufficient for v1
- ML-driven similarity detection for consolidate — use LLM judgment for v1, vector embeddings = follow-up
- Auto-apply consolidate or patch without human approval — too risky for v1
- Curator that learns from user overrides — out of scope

## 6. Functional Requirements

- **FR-B-1** — Cron entry SHALL run `curator.run()` weekly on Sundays 03:00 UTC; configurable via `HELYX_CURATOR_CRON` env
- **FR-B-2** — Curator SHALL select all rows from `agent_created_skills` WHERE `status='active' AND pinned=false`
- **FR-B-3** — Curator SHALL build a single aux-LLM prompt with all skill names + descriptions + use_count + last_used_at; max 200 skills per run (chunked if more)
- **FR-B-4** — Aux-LLM response SHALL list proposed actions: `{ name, action, reason }`; action ∈ `{pin, archive, consolidate_with, patch, no_action}`
- **FR-B-5** — Curator SHALL auto-apply 'pin' (low risk) and 'archive' (Hermes invariant) actions
- **FR-B-6** — Curator SHALL queue 'consolidate_with' and 'patch' as Telegram messages with [Approve] [Skip] buttons; user has 24h before action expires
- **FR-B-7** — Auto-archive criterion: `last_used_at` older than 90 days (configurable)
- **FR-B-8** — Auto-pin criterion: `use_count > 10` AND `last_used_at` within 14 days
- **FR-B-9** — Every curator run SHALL insert a row in `curator_runs` with timing + counts + cost
- **FR-B-10** — Summary message SHALL be sent to Telegram (`SUPERVISOR_CHAT_ID + SUPERVISOR_TOPIC_ID` if configured, else first registered chat)
- **FR-B-11** — Curator SHALL be idempotent: re-running on same data yields same actions (modulo aux-LLM nondeterminism, which is bounded)
- **FR-B-12** — Curator SHALL be pausable: env `HELYX_CURATOR_PAUSED=true` skips all runs with logged reason

## 7. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-B-1 | Curator run SHALL complete within 5 minutes p95 for ≤200 skills |
| NFR-B-2 | Aux-LLM cost per run SHALL be <$0.10 at typical sizes |
| NFR-B-3 | Curator failure SHALL NOT crash admin-daemon; logged + retried next schedule |
| NFR-B-4 | Anthropic prompt cache for main session SHALL NOT be invalidated (verify: zero API calls to main Claude during curator run) |
| NFR-B-5 | Consolidate/patch confirmations SHALL expire after 24h to keep Telegram inbox clean |

## 8. Constraints

**Technical**:
- Scheduler: existing admin-daemon (no new long-running process)
- Aux-LLM: reuse Phase C client (openai-compatible)
- Postgres: 1 new table `curator_runs`, no schema changes to `agent_created_skills`

**Architectural**:
- Curator MUST run inside helyx-bot container (not on Claude Code subprocess)
- Curator MUST use aux-LLM client, never main Claude API
- Actions MUST be deterministically derived from aux-LLM response (no fuzzy logic)
- Actions touching body (patch, consolidate) MUST log before/after diff to `aux_llm_invocations.related_id` chain

**Design**:
- Weekly cadence is conservative; can tune to daily once stable
- Single aux-LLM call per run if all skills fit prompt; chunked otherwise (200 skills/chunk)
- Summary report includes: counts per action, list of pending confirmations, cost

## 9. Edge Cases

- **Aux-LLM proposes consolidate where target doesn't exist**: validator rejects, log warning, continue with other actions
- **Aux-LLM proposes archive of skill used yesterday**: violates auto-archive criterion (≥90 days idle); validator rejects
- **Two consolidate proposals targeting same skill**: process first, second becomes no-op
- **Aux-LLM unavailable on scheduled run**: log warning, set `curator_runs.status='skipped'`, retry next schedule
- **User manually edits a skill while curator is running**: optimistic concurrency — re-read at apply time, skip if mtime changed
- **Skill with `is_agent_created=true` is also user-pinned**: curator skips pinned regardless of recommendation
- **Telegram approval expires before user sees it**: log expiry, no action; curator may re-propose next run
- **Consolidation creates body >100k chars**: validator rejects, fall back to archive of one + keep other
- **Curator run produces zero actions**: still log row + send "all clear" summary

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Phase B — Skill Curator

  Scenario: Cron entry registered on admin-daemon startup
    Given Phase B PR merged
    When admin-daemon starts
    Then a cron entry "0 3 * * 0" exists for runCurator
    And it is visible in mcp__helyx__list_crons (existing tool)

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

**Unit tests** (`tests/unit/curator.test.ts`):
- Select active+unpinned skills only
- Auto-archive criterion (>90 days idle)
- Auto-pin criterion (use_count>10 && recent)
- Consolidate proposal goes to Telegram queue
- Patch proposal goes to Telegram queue
- Pinned skills excluded from action set
- Chunked aux-LLM calls for >200 skills
- `curator_runs` row inserted with correct counts
- Graceful skip on aux-LLM unavailable

**Integration tests** (`tests/unit/curator-integration.test.ts`):
- Full run on staging postgres with seed data
- Telegram confirmations queued and process callback responses

**Telegram smoke**:
- Manually trigger curator run via admin-daemon, verify summary message arrives

**Prompt cache isolation**:
- Monitor Anthropic API usage during curator run; expect zero requests on main key

**goodai-base regression**:
- Run curator on staging with agent skills present; verify no goodai-base skill is modified

**Rollback test**:
- `git revert` this PR + redeploy → admin-daemon cron entry disappears, `curator_runs` table dropped via migration down

## 12. Implementation Sketch

**Files to create**:
- `utils/curator/index.ts` (~200 LOC, orchestrator)
- `utils/curator/select-candidates.ts` (~80 LOC, query active+unpinned skills)
- `utils/curator/aux-llm-prompt.ts` (~150 LOC, build prompt, parse response)
- `utils/curator/apply-actions.ts` (~150 LOC, auto-apply pin/archive, queue consolidate/patch)
- `utils/curator/summary-report.ts` (~100 LOC, format Telegram summary)
- `prompts/skill-curation.md` (~100 lines, system prompt for aux-LLM)
- `migrations/v42_create_curator_runs.sql` (~25 LOC)
- `tests/unit/curator.test.ts` (~350 LOC, 12 cases)
- `tests/unit/curator-integration.test.ts` (~200 LOC, 4 cases)

**Files to modify**:
- `scripts/admin-daemon.ts` — add cron entry calling `import('../utils/curator').then(m => m.run())`
- `mcp/server.ts` — register `mcp__helyx__curator_run` (manual trigger for testing) and `mcp__helyx__curator_status`
- `mcp/tools.ts` — add to tool list
- `channel/tools.ts` — dispatch cases
- `bot/callbacks.ts` — handlers for curator [Approve] / [Skip] inline buttons
- `dashboard/api` — new endpoint `/api/curator-runs` (history view)
- `dashboard/webapp` — new page with curator run history + skills lifecycle distribution
- `memory/db.ts` — register migration v42
- `CHANGELOG.md` — entry under v1.35.0
- `package.json` — bump to 1.35.0
- `.env.example` — `HELYX_CURATOR_CRON`, `HELYX_CURATOR_PAUSED`, `HELYX_CURATOR_ARCHIVE_AFTER_DAYS`, `HELYX_CURATOR_PIN_USE_COUNT`

**Postgres schema**:

```sql
-- v42_create_curator_runs.sql
CREATE TABLE curator_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  status TEXT NOT NULL,  -- running | success | skipped | error
  skills_examined INTEGER NOT NULL DEFAULT 0,
  skills_pinned INTEGER NOT NULL DEFAULT 0,
  skills_archived INTEGER NOT NULL DEFAULT 0,
  skills_proposed_consolidate INTEGER NOT NULL DEFAULT 0,
  skills_proposed_patch INTEGER NOT NULL DEFAULT 0,
  aux_llm_cost_usd NUMERIC(10,6),
  error_message TEXT,
  summary TEXT
);
CREATE INDEX curator_runs_started_at_idx ON curator_runs (started_at DESC);
```

**Curation prompt skeleton** (`prompts/skill-curation.md`):

```markdown
You are skill-curation aux. Given a list of agent-created skills with metadata,
propose lifecycle actions per skill. Allowed actions: pin, archive,
consolidate_with:<target_name>, patch:<diff>, no_action.

Auto-applied: pin (high use, recent) and archive (stale).
Confirmation-required: consolidate (merging) and patch (body edit).

Constraints:
- Never propose archive for skills used within 90 days
- Propose pin only if use_count > 10 AND last_used_at within 14 days
- Propose consolidate_with only when names + descriptions show >70% overlap
- Propose patch only for clearly improvable bodies (broken inline-shell, typos)
- When in doubt, choose no_action

Output JSON: { actions: [{ name, action, reason, ... }] }
```
