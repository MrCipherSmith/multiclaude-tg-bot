# PRD: Hermes Skills Toolkit — Overview

## 1. Overview

Three skill-system improvements inspired by [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), adapted to helyx's Bun-MCP-bridge architecture (where Claude Code remains the agent runtime). Sequenced as a roadmap with strict dependencies: **A → C → B**.

| Phase | Feature | Why now |
|---|---|---|
| **A** | Inline `` !`cmd` `` expansion in skill preprocessor | Lowest risk, highest immediate ROI — eliminates one tool-call round-trip per dynamic context |
| **C** | Autonomous skill creation after complex tasks | Closes the learning loop — successful workflows become reusable artifacts |
| **B** | Background skill curator | Maintains accumulated agent-created skills (pin / archive / consolidate) |

Each phase ships as an independent PR, mergeable and revertible in isolation.

## 2. Context

- **Product**: helyx — Telegram bot bridging the user's phone to Claude Code on a remote machine
- **Module**: skill subsystem (today: pass-through to Claude Code's native loader)
- **User Role**: developer using helyx as a coding assistant via Telegram
- **Tech Stack**: Bun 1.3+, TypeScript 5.x, Postgres 16 (pgvector), Docker Compose, MCP SDK ^1.x, DeepSeek API (configured), Ollama (configured for local fallback)

helyx today does NOT touch skills — Claude Code loads them directly from `~/.claude/skills/<name>/SKILL.md`. The goodai-base ecosystem provides ~30+ engineering skills (`feature-analyzer`, `review-orchestrator`, etc.).

This toolkit adds a thin helyx-side preprocessor + skill registry, layered atop Claude Code without replacing the loader.

## 3. Problem Statement

1. **Static skills require live data via tool calls.** A `/git-state` skill today must instruct the LLM to run `Bash("git status")` — a full round-trip, ~150 tokens, ~500ms. Hermes lets skills inject that output at load time via `` !`cmd` `` syntax.

2. **Successful workflows are forgotten.** When the agent stitches together a multi-step solution (debug + fix + test + commit), that workflow disappears with the conversation. Next time, it's rediscovered. Hermes' agent-created skills capture these as reusable SKILL.md files.

3. **Accumulated skills go uncurated.** Without periodic review, agent-created skills duplicate each other, never archive when stale, and never consolidate near-duplicates. Hermes' curator (auxiliary-LLM, idle-triggered) fixes this.

## 4. Goals

- **G1** — skills can inject dynamic shell output at load time, eliminating one tool-call round-trip per dynamic dependency
- **G2** — after a multi-step success, the agent CAN distill the workflow into a reusable SKILL.md without user intervention
- **G3** — agent-created skills auto-curate over time: pin frequently-used, archive stale, merge near-duplicates
- **G4** — no regression on goodai-base skills, existing TTS/ASR, MCP transport, or channel.ts session lifecycle
- **G5** — aux-LLM costs per active user stay <$0.50/month under typical usage (~10 curator runs/month)

## 5. Non-Goals

- **NG1** — rewrite Claude Code's skill loader. We LAYER on top via MCP, never replace.
- **NG2** — support Hermes' multi-platform gateway (Discord/Slack/WhatsApp). Telegram-only stays.
- **NG3** — replicate Hermes' multi-LLM provider switching at session level. Claude Code remains the primary runtime.
- **NG4** — implement RL/Atropos training pipelines.
- **NG5** — auto-DELETE skills. Curator only archives — matches Hermes' "never delete" invariant.
- **NG6** — share agent-created skills across users. Per-installation only for v1.

## 6. Functional Requirements (top-level)

- **FR-Overview-1** — All three features SHALL ship without env flags. Rollback path is `git revert <pr-sha>` + redeploy.
- **FR-Overview-2** — Features SHALL be sequenced A → C → B as separate PRs, each independently mergeable and revertible.
- **FR-Overview-3** — Feature C SHALL depend on feature A's preprocessor (so generated skills can use `` !`cmd` ``).
- **FR-Overview-4** — Feature B SHALL depend on feature C's `agent_created_skills` table (otherwise nothing to curate).

Per-feature FRs live in the deep-dive PRDs.

## 7. Non-Functional Requirements

| ID | Requirement | Verification |
|---|---|---|
| **NFR-Compat** | Zero changes to goodai-base SKILL.md files; they remain valid input | grep `!\`` in goodai-base skills returns no matches; loaded skills unchanged in token count |
| **NFR-Cost** | Aux-LLM cost <$0.50/month/user at 10 curator runs/month, average prompt ≤8 KB | Logged token counts × DeepSeek pricing in `aux_llm_invocations` postgres table |
| **NFR-Latency** | Feature A preprocessor adds ≤200ms median latency per skill load (excluding shell-cmd execution itself) | p50 from `tts_skill_load_ms` perf log on staging |
| **NFR-Isolation** | Feature B uses dedicated aux-LLM client; main session prompt cache unaffected | Anthropic billing shows curator events on separate API key OR DeepSeek/Ollama (not Claude) |
| **NFR-Observability** | Every preprocessor invocation, skill creation, curator run logged to postgres + structured logs | Tables: `skill_preprocess_log`, `agent_created_skills` (audit), `curator_runs` |

## 8. Constraints

**Technical**:
- TypeScript 5.x + Bun 1.3+ (current stack)
- Postgres 16 with pgvector (current stack)
- MCP SDK ^1.x
- No new external services — DeepSeek and Ollama already configured in `.env`

**Architectural**:
- Preprocessor MUST live in helyx-MCP server side, not Claude Code subprocess — keeps logic in helyx repo, reusable across sessions
- Agent-created skills MUST live in postgres for queryability + audit; on-disk SKILL.md is generated on demand for Claude Code consumption
- Curator MUST run as cron job triggered by helyx admin-daemon, not by Claude Code

**Design**:
- Match Hermes' validation rules: name ≤64 chars, description ≤1024 chars, body ≤100k chars
- Match goodai-base convention: description starts with "Use when"
- Hermes-specific extensions (`` !`cmd` ``, `related_skills` graph) are ADDITIVE — absent tokens = same behavior as today

## 9. Edge Cases

- **Hermes-style skill loaded by non-Hermes-aware client** (e.g. Cursor): gracefully degrades — `` !`cmd` `` text passes through verbatim, becomes unrendered markdown
- **Agent generates skill exceeding 100k char limit**: rejected with diagnostic, retried with truncation prompt
- **Curator's aux-LLM unavailable** (DeepSeek down + Ollama not running): run skips with logged warning, retries next schedule
- **Two concurrent autonomous skill creations for similar workflows**: postgres unique constraint on `(name, owner)` prevents duplicates; second creator gets EXISTS error and exits
- **User manually edits a skill marked `is_agent_created=true`**: pin it (curator never touches pinned), or transfer ownership to user
- **Circular `related_skills` reference**: detect on insert via DFS, reject with diagnostic

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Hermes Skills Toolkit — Overall Rollout

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
    And after a complex multi-step task succeeds, agent can propose saving as a skill
    And feature A's preprocessor is reused for the generated SKILL.md

  Scenario: Phase B merged after Phase C
    Given Phase A and C are in production with at least 1 agent-created skill
    When PR for skill-curator is merged
    Then a cron entry runs the curator weekly
    And curator uses DeepSeek (default) or Ollama (configurable)
    And curator never touches user-created skills (is_agent_created=false)
    And curator never deletes — only marks archived_at

  Scenario: All-features rollback
    Given all three phases are in production
    When git revert is applied in reverse order (B then C then A)
    And helyx is redeployed
    Then helyx behaves exactly as before Phase A
    And agent_created_skills table is dropped via migration down
    And no orphaned data remains
```

## 11. Verification

**Per-feature**: see deep-dive PRDs for inline-shell, autonomous-skill-creator, skill-curator.

**Cross-cutting**:
1. **Smoke after each PR**: 1 RU + 1 EN message in Telegram, 1 voice message → existing TTS/ASR still works
2. **goodai-base regression**: load 3 random goodai-base skills (`/feature-analyzer`, `/review-orchestrator`, `/job-orchestrator`) → render correctly, no hangs, no exceptions
3. **Cost monitoring**: postgres `aux_llm_invocations` table after each curator run
4. **Weekly health panel**: dashboard `Hermes Toolkit Health` shows skill_preprocess_count, agent_created_skills_count, curator_run_count, errors_count

**Rollback test**: in staging, after deploying all three phases, run `git revert` of each in reverse order — verify clean state and goodai-base regression-free.

## 12. Roadmap & Dependencies

| Phase | PR title | ETA | Blocks | Depends on | Files |
|---|---|---|---|---|---|
| A | feat: inline shell expansion in skill preprocessor | 1-2 days | C | — | ~3 (preprocessor, tests, demo skill) |
| C | feat: autonomous skill creation after complex tasks | 3-5 days | B | A | ~6 (creator, prompt template, migration, MCP tool, tests, docs) |
| B | feat: background skill curator | 5-7 days | — | C | ~7 (curator, aux-llm-client, scheduler, migration, dashboard panel, tests, docs) |

**Total ETA**: 9-14 days, single developer.

---

## See also

- `./inline-shell.md` — Phase A deep-dive
- `./autonomous-skill-creator.md` — Phase C deep-dive
- `./skill-curator.md` — Phase B deep-dive
