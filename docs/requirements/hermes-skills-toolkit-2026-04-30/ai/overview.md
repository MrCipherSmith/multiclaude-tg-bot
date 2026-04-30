# PRD (AI-readable): Hermes Skills Toolkit — Overview

```yaml
prd:
  id: hermes-skills-toolkit
  date: 2026-04-30
  type: overview
  scope:
    - feature: inline-shell-expansion
      phase: A
      ref: ./inline-shell.md
    - feature: autonomous-skill-creator
      phase: C
      depends_on: [inline-shell-expansion]
      ref: ./autonomous-skill-creator.md
    - feature: skill-curator
      phase: B
      depends_on: [autonomous-skill-creator]
      ref: ./skill-curator.md
  rollout: sequential A → C → B
  feature_flag: none (all features ship always-on)
```

## 1. Overview

Three Hermes-Agent-inspired features, sequenced as a roadmap. Layer atop helyx's Claude-Code-MCP architecture without replacing the agent runtime.

## 2. Context

```yaml
product: helyx
architecture: bot-in-Docker (MCP server :3847) + per-session bun channel.ts on host + Claude Code as agent runtime
stack:
  language: TypeScript
  runtime: Bun
  database: Postgres 16 (pgvector)
  container: Docker Compose
  llm_primary: Claude Sonnet 4.6 / Opus 4.7 via Claude Code (single conversation)
  llm_aux: DeepSeek-chat (default, configured) / Local Gemma via Ollama (fallback option)
  mcp: @modelcontextprotocol/sdk over HTTP
skills_today:
  source: filesystem `~/.claude/skills/<name>/SKILL.md`
  loader: native Claude Code (no helyx involvement)
  format: YAML frontmatter (name/description/use-when) + Markdown body
  ecosystem: goodai-base ships engineering skills; helyx itself ships none yet
constraints_global:
  - must_not_break: existing TTS/ASR pipeline, MCP tool dispatch, channel.ts session lifecycle, goodai-base skill compatibility
  - must_not_break: Claude Code's native skill loading (we LAYER on top, not replace)
  - must_not_break: prompt cache of main session (aux-LLM tasks use separate client)
  - migration: zero-downtime; opt-out path = `git revert <pr-sha>` + redeploy
```

## 3. Problem Statement

```yaml
problems:
  - id: P1
    statement: "skills are static — every dynamic context (git status, file listing) requires the LLM to make a tool call, costing tokens and round-trips"
    addressed_by: [feature-A]
  - id: P2
    statement: "successful complex workflows are forgotten after the conversation ends — same multi-step pattern is rediscovered next time"
    addressed_by: [feature-C]
  - id: P3
    statement: "agent-created skills accumulate without curation — duplicates pile up, stale ones never archive, no consolidation"
    addressed_by: [feature-B]
```

## 4. Goals

```yaml
goals:
  - G1: "skills can inject dynamic shell output at load time, eliminating one tool-call round-trip per dynamic dependency"
  - G2: "after a multi-step success, the agent CAN distill the workflow into a reusable SKILL.md without user intervention"
  - G3: "agent-created skills auto-curate over time: pin frequently-used, archive stale, merge near-duplicates"
  - G4: "no regression on goodai-base skills, existing TTS/ASR, MCP, or channel.ts session lifecycle"
  - G5: "aux-LLM costs per active user stay <$0.50/month under typical usage (~10 curator runs/month)"
```

## 5. Non-Goals

```yaml
non_goals:
  - "rewrite Claude Code's skill loader — we LAYER on top via MCP, never replace"
  - "support Hermes' full multi-platform gateway (Discord/Slack/WhatsApp) — Telegram-only stays"
  - "replicate Hermes' multi-LLM provider switching at session level — Claude Code stays the primary runtime"
  - "implement RL/Atropos training pipelines — out of scope"
  - "auto-DELETE skills (curator only archives, never deletes — same invariant as Hermes)"
  - "share agent-created skills across users — per-installation only for v1"
```

## 6. Functional Requirements (top-level)

```yaml
fr:
  - id: FR-Overview-1
    text: "all three features SHALL be opt-in via `git revert` only — no env flag, no config toggle"
  - id: FR-Overview-2
    text: "features SHALL be sequenced A → C → B as separate PRs, each independently mergeable and reverteable"
  - id: FR-Overview-3
    text: "feature C SHALL depend on feature A's preprocessor (so generated skills can use `!`cmd``)"
  - id: FR-Overview-4
    text: "feature B SHALL depend on feature C's `agent_created_skills` table (otherwise nothing to curate)"
```

Per-feature FRs live in the deep-dive PRDs.

## 7. Non-Functional Requirements

```yaml
nfr:
  - id: NFR-Compat
    text: "zero changes to goodai-base SKILL.md files — they remain valid input"
    verify: "grep `!` in /home/altsay/goodai-base/skills/*/SKILL.md returns no Hermes-style tokens; goodai skills load unchanged"
  - id: NFR-Cost
    text: "aux-LLM cost SHALL stay under $0.50/month/user at 10 curator runs/month with average prompt size ≤8 KB"
    verify: "logged token counts × DeepSeek pricing in postgres `aux_llm_invocations` table"
  - id: NFR-Latency
    text: "feature A preprocessor SHALL add ≤200ms median latency per skill load (excluding shell-cmd execution time itself)"
    verify: "p50 from `tts_skill_load_ms` perf log on staging"
  - id: NFR-Isolation
    text: "feature B SHALL use a dedicated aux-LLM client; main Claude Code session prompt cache SHALL NOT be affected"
    verify: "Anthropic billing dashboard shows curator events on separate API key OR DeepSeek/Ollama (not Claude)"
  - id: NFR-Observability
    text: "every preprocessor invocation, skill creation, and curator run SHALL be logged to postgres + structured logs"
    verify: "tables: `skill_preprocess_log`, `agent_created_skills` (audit columns), `curator_runs`"
```

## 8. Constraints

```yaml
constraints:
  technical:
    - "TypeScript 5.x + Bun 1.3+ (current stack)"
    - "Postgres 16 with pgvector (current stack)"
    - "MCP SDK ^1.x"
    - "no new external services — DeepSeek and Ollama already configured in `.env`"
  architectural:
    - "preprocessor MUST live in helyx-MCP server side, not Claude Code subprocess — keeps logic in helyx repo, reusable across sessions"
    - "agent-created skills MUST live in postgres for queryability + audit; on-disk SKILL.md is generated on demand for Claude Code consumption"
    - "curator MUST run as cron job triggered by helyx admin-daemon, not by Claude Code"
  design:
    - "match Hermes' validation rules: name ≤64 chars, description ≤1024 chars, body ≤100k chars"
    - "match goodai-base convention: description starts with 'Use when'"
    - "Hermes-specific extensions (`!`cmd``, related_skills graph) are ADDITIVE — absent tokens = same behavior as today"
```

## 9. Edge Cases

```yaml
edge_cases:
  - "Hermes-style skill loaded by non-Hermes-aware client (e.g. Cursor): gracefully degrades — `!`cmd`` text passes through verbatim, becomes unrendered markdown"
  - "agent generates skill that exceeds 100k char limit: rejected with diagnostic, retried with truncation"
  - "curator's aux-LLM unavailable (DeepSeek down + Ollama not running): curator run skips with logged warning, retries on next schedule"
  - "two concurrent autonomous skill creations for similar workflows: postgres unique constraint on `(name, owner)` prevents duplicates; second creator gets EXISTS error and exits"
  - "user manually edits a skill marked is_agent_created=true: pin it (curator never touches pinned), or transfer ownership to user"
  - "circular `related_skills` reference: detect on insert via DFS, reject with diagnostic"
```

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Hermes Skills Toolkit — Overview Acceptance

  Scenario: Phase A merged independently
    Given main branch with no Hermes features
    When PR for inline-shell-expansion is merged
    Then helyx serves Hermes-style skills with `!`cmd`` expanded
    And goodai-base skills continue to load unchanged
    And no postgres schema migration ran
    And no aux-LLM was invoked

  Scenario: Phase C merged after Phase A
    Given Phase A is in production
    When PR for autonomous-skill-creator is merged
    Then `agent_created_skills` table exists in postgres
    And after a complex multi-step task succeeds, agent CAN propose saving as a skill
    And feature A's preprocessor is reused for the generated SKILL.md

  Scenario: Phase B merged after Phase C
    Given Phase A and C are in production with at least 1 agent-created skill
    When PR for skill-curator is merged
    Then a cron entry runs the curator weekly
    And curator uses DeepSeek (default) or Ollama (configurable)
    And curator never touches user-created skills (is_agent_created=false)
    And curator never deletes — only marks `archived_at`

  Scenario: All-features rollback
    Given all three phases are in production
    When `git revert` is applied to all three PRs in reverse order (B then C then A)
    And helyx is redeployed
    Then helyx behaves exactly as today (pre-Hermes)
    And `agent_created_skills` table is dropped via migration down
    And no orphaned data remains

  Scenario: Cost ceiling not exceeded
    Given Phase B is in production
    And 50 active users
    When 1 month elapses with typical usage (~10 curator runs/user/month)
    Then total aux-LLM cost <$25 ($0.50 × 50 users)
    And per-user cost <$0.50
```

## 11. Verification

```yaml
verification:
  per_feature: "see deep-dive PRDs for inline-shell, autonomous-skill-creator, skill-curator"
  cross_cutting:
    - "smoke after each PR: 1 RU + 1 EN message in Telegram, 1 voice message → existing TTS/ASR still works"
    - "load 3 random goodai-base skills (`/feature-analyzer`, `/review-orchestrator`, `/job-orchestrator`) → render correctly, no hangs, no exceptions"
    - "monitor postgres `aux_llm_invocations` table after each curator run for cost/latency"
    - "weekly review: dashboard panel `Hermes Toolkit Health` shows: skill_preprocess_count, agent_created_skills_count, curator_run_count, errors_count"
  rollback_test:
    - "in staging, after deploying all three phases, run `git revert` of each in reverse order — verify clean state and goodai-base regression-free"
```

## 12. Roadmap & Dependencies

```yaml
roadmap:
  phase_A:
    pr: "feat: inline shell expansion in skill preprocessor"
    eta: "1-2 days"
    blocks: [phase_C]
    file_count: ~3 (preprocessor.ts, tests, 1 demo skill)
  phase_C:
    pr: "feat: autonomous skill creation after complex tasks"
    eta: "3-5 days"
    blocks: [phase_B]
    depends_on: [phase_A]
    file_count: ~6 (creator.ts, prompt-template.ts, postgres-migration, mcp-tool, tests, docs)
  phase_B:
    pr: "feat: background skill curator"
    eta: "5-7 days"
    depends_on: [phase_C]
    file_count: ~7 (curator.ts, aux-llm-client.ts, scheduler integration, postgres-migration, dashboard panel, tests, docs)
total_eta: "9-14 days, single developer"
```
