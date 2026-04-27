# Changelog

## v1.42.1

### fix: review follow-ups for v1.42.0 (perf index + defensive guards)

Addresses findings from the post-merge review of the topic-bound routing
PR (review-orchestrator-style critique on commit a7f01188).

**Migration v37 — `idx_agent_instances_forum_topic` (perf, important)**:
Partial index on `agent_instances(forum_topic_id) WHERE forum_topic_id IS
NOT NULL`. The lookup runs on EVERY plain-text message in any forum
topic via `bot/text-handler.ts → agentManager.getInstanceByForumTopic`.
Without an index, query degrades to a sequential scan as the
`agent_instances` table grows. Mirrors the existing partial index pattern
on `projects.forum_topic_id` (see migration v6).

**`agents/agent-manager.ts:getInstanceByForumTopic`**:
Filter changed to `desired_state IS NULL OR desired_state != 'stopped'`.
The schema declares `desired_state` as `NOT NULL` so this is currently a
no-op, but it survives any future migration that drops the constraint —
SQL three-valued logic would otherwise silently exclude NULL rows from
`!= 'stopped'`. Defense-in-depth, comment documents the rationale.

**`bot/text-handler.ts`**:
Cap routed-task `description` at 10,000 chars before persisting. Single
Telegram messages cap at 4,096 chars but concatenated forwards / pasted
blocks can be larger, and the underlying `agent_tasks.description` is
TEXT (no postgres-side limit). Title cap unchanged (200 chars + ellipsis).

**Not changed** (review noted but out of scope):
- empty/whitespace text guard — Telegram filters empty texts before
  webhook delivery; not a real-world condition.
- escape on ack already in place since v1.42.0 (`escapeHtml(boundAgent.name)`).
- tiebreak ordering already documented and indexed by id.

401/401 unit tests pass (no new test cases — index is a perf concern
not a behavioral one; defensive `IS NULL OR` is no-op against the
current schema).

## v1.42.0

### feat: topic-bound text routing (Pattern A)

Closes the UX gap surfaced after v1.41.0: plain-text messages in a
Telegram forum topic are now routed to the bound agent_instance as
agent_tasks (instead of always going to the project's claude-code
session). Lets operators dedicate a topic to a specialized agent and
get auto-handled work without typing `/orchestrate`.

**Behavior**:

```
operator types "проведи ревью" in topic 42
  ↓
text-handler checks: any agent_instance with forum_topic_id = 42
                    AND desired_state != 'stopped'?
  ├─ yes → orchestrator.createTask({
  │           title: "проведи ревью",
  │           agentInstanceId: <agent>,
  │           payload: { source: "telegram-topic-routed",
  │                      forum_topic_id, telegram_message_id, from }
  │        })
  │        bot replies: "🤖 Task #N queued for <agent>"
  │        worker picks up within ~3s
  │        result auto-posts back to topic via result-router (v1.39.0)
  │
  └─ no  → falls through to existing session/claude-code path (unchanged)
```

**Decision priority** when a topic has both a session and an agent
binding: agent binding wins. Operators who want a topic to remain
under claude-code control simply don't bind an agent there.

**Code surface**:

- `agents/agent-manager.ts`: new `getInstanceByForumTopic(topicId)` —
  excludes `desired_state='stopped'`, prefers running > idle/busy >
  starting > others, lowest id as tiebreaker for determinism if
  multiple instances claim the same topic.
- `bot/text-handler.ts`: pre-routeMessage check; if a bound agent is
  found, creates the task and acks. Errors fall through to session
  path (defensive — a routing-layer hiccup must not eat the user's
  message).

**Telegram metadata** carried into `payload`:
- `source: "telegram-topic-routed"` — distinguishes from
  `telegram /orchestrate`, `auto-dispatch`, etc.
- `forum_topic_id`, `telegram_chat_id`, `telegram_message_id`, `from` —
  full origin trail for audit / replies.

**Title truncation**: messages > 200 chars truncate the title to
197 chars + `…` and stash the full text in `description`.

**Tests** (`tests/unit/topic-bound-routing.integration.test.ts`, 5):
- `getInstanceByForumTopic` returns the running agent, ignores stopped
  agents on same topic, returns null for unbound topics.
- Stopping the running agent leaves no candidate (proves the filter).
- Telegram metadata persists in `agent_tasks.payload` as JSONB object
  (regression guard for v1.37.0 systemic fix).
- Long-text truncation: title ≤ 200 chars + `…`, full text in
  description.

401/401 unit tests pass.

## v1.41.0

### feat: Claude Code system prompt forwarding (Pattern C) + 5 execution-capable templates

Closes the deferred Pattern C path from v1.39.0. Specialized claude-code
agents are now possible — same `claude-code` runtime, but with a focused
role primer appended to the session system prompt via
`--append-system-prompt`. Unlocks the goodai-base execution-capable
skills (task-implementer, code-verifier, tests-creator, commit,
pr-create) as native helyx templates.

**Pattern C wiring**:

- `runtime/runtime-manager.ts` resolves the effective system prompt:
  `inst.systemPromptOverride ?? def.systemPrompt`. Forwards it as
  `HELYX_SYSTEM_PROMPT` env var to `driver.start`.
- `scripts/run-cli.sh` (claude-code branch) checks for
  `HELYX_SYSTEM_PROMPT` and, if set, wraps the launcher command with
  `--append-system-prompt $escaped_prompt`. Uses `printf %q` for
  shell-safe quoting so multi-line prompts with `$`/`` ` ``/`'` survive.
- Other runtimes (codex-cli, opencode, deepseek-cli) ignore the env
  var — no change for them.

**Migration v36** — seeds 5 claude-code execution-capable definitions:

- `task-implementer` (`code, implement, test`) — implements a single
  atomic decomposed task end-to-end (research → plan → code → verify).
- `code-verifier` (`test, verify, lint`) — runs the full quality gate
  and produces a structured pass/fail report.
- `tests-creator` (`test, code`) — generates focused unit/integration
  tests matching the project's existing patterns.
- `commit` (`code, commit, git`) — Conventional Commits author
  with WHY-focused body and safe staging.
- `pr-create` (`pr-management, git`) — pushes branch + opens a PR
  with auto-derived summary and test plan.

Each prompt is a 1100-1400 char distillation; operators wanting the
full SKILL.md body can copy from `goodai-base/skills/<name>/SKILL.md`
and pass via `/agent_create ... --prompt "<paste>"`.

**Synergy with v1.40.0 auto-dispatch**: a `job-orchestrator` plan now
fans out into REAL execution-capable claude-code agents:

```
/agent_create helyx:job job-orchestrator helyx
/agent_create helyx:impl task-implementer helyx
/agent_create helyx:check code-verifier helyx
/agent_create helyx:committer commit helyx

/orchestrate "Add /agent_definition_create command"
  → job-orchestrator emits 5-subtask plan
  → auto-dispatcher creates subtasks; selectAgent routes by capability
  → task-implementer (claude-code) implements code
  → code-verifier (claude-code) runs lint/types/tests
  → commit (claude-code) creates the commit
  → fan-out happens autonomously, with file/Bash access
```

**Tests** (+7):
- `runtime-driver.test.ts`: HELYX_SYSTEM_PROMPT threads through env
  layer; multi-line prompt with `$()`/`` ` `` survives single-quote
  escape (no shell expansion).
- `seed-skills.integration.test.ts`: all 5 claude-code seeds present
  with non-trivial prompts; task-implementer carries `code`
  capability (so orchestrator's IMPLEMENT subtasks route here);
  code-verifier carries `verify`.

396/396 unit tests pass.

**Pattern C limits**: `--append-system-prompt` extends but does not
replace the claude-code base prompt. The skill prompt steers behavior
on top of claude's defaults — operators get full claude-code tools
(Read/Edit/Bash/MCP) plus the role primer, not a sandboxed subset.

## v1.40.0

### feat: orchestrator auto-dispatch (Pattern B) — fan-out becomes automatic

Closes the v1.39.0 follow-up: when an orchestrator agent completes a
task and emits a valid `Decomposition` JSON, helyx now creates the
subtasks itself via `orchestrator.createTask`. Each subtask routes to
a candidate agent through `selectAgent(capabilities)` — no operator
action needed.

Pre-v1.40.0, the operator had to read the orchestrator's output and
either run `/task <id> decompose` or create children manually with
`/task <id> sub`. With Pattern B, the path becomes:

```
/agent_create helyx:job job-orchestrator helyx
/orchestrate "Add /agent_definition_create command"
  → job-orchestrator emits JSON plan
  → worker auto-creates 5 subtasks (analyze/plan/implement/verify/review)
  → each subtask's capabilities route to specialist agents
  → fan-out happens by itself
```

**`agents/auto-dispatcher.ts`** (new):
- `tryParseDecomposition(text)` — strips ```json fences, runs
  `DecompositionSchema.safeParse`. Returns `{ok:true, value}` or
  `{ok:false, reason: "unparseable_output" | "schema_invalid"}`.
- `maybeDispatchOrchestration(parentTask, resultText)` — gates on
  the parent agent's definition having the `orchestrate` capability,
  parses the result, calls `orchestrator.createTask` per subtask
  (with `parent_task_id`, `payload.source="auto-dispatch"`,
  `payload.required_capabilities` for handleFailure fallback). Records
  `orchestration_dispatched` audit event on the parent. Partial
  dispatch is preserved when individual subtasks fail (better than
  zero dispatch).

**`agents/orchestrator.ts`**: `SubtaskSchema`, `DecompositionSchema`,
`Subtask`, `Decomposition` are now exported (single source of truth
shared between classical decomposeTask and the auto-dispatcher).

**`scripts/standalone-llm-worker.ts`**: after `completeTask`, calls
`maybeDispatchOrchestration`. Wrapped in try/catch — auto-dispatch
failures never flip the parent task to `status='failed'`.

**Pattern A fallback**: when output doesn't parse as Decomposition,
auto-dispatch silently skips. The result is still in
`agent_tasks.result` for the operator to read and act on manually.

**Pattern C** (claude-code MCP-driven dispatch from the agent itself,
giving full tool access during orchestration) — still deferred.

**Tests** (`tests/unit/auto-dispatcher.integration.test.ts` — 10):
- `tryParseDecomposition`: plain JSON, fenced JSON, malformed input,
  schema violations (empty title, empty subtasks), all 5 paths.
- `maybeDispatchOrchestration`: skip without `orchestrate` capability,
  skip on unparseable / schema-invalid output, full success path with
  3 subtasks creating proper FK linkage and payload, single-subtask
  audit event with metadata jsonb_typeof = 'object' (regression guard
  for v1.37.0 systemic fix).

391/391 unit tests pass.

## v1.39.0

### feat: orchestrator agent_definitions (advisory pattern)

Migration v35 seeds 4 orchestrator definitions distilled from
goodai-base/skills/*-orchestrator. Each emits a structured JSON
decomposition plan that mirrors `orchestrator.ts:DecompositionSchema`,
so the same plan can be fed to `/task <id> decompose` later, or
converted to `/task <id> sub <title>` calls by hand.

- `review-orchestrator` — multi-dimensional code review fan-out + consolidation
- `job-orchestrator` — full pipeline (analyze → plan → implement → verify → review)
- `gproject-orchestrator` — greenfield planning (interview → patterns → spec → plan)
- `autodoc-orchestrator` — documentation pipeline (scan → analyze → architect → write → assemble)

All four carry the `orchestrate` capability tag, plus role-specific
tags (`review`, `decompose`, `spec`, `document`). Prompts enumerate
the actual helyx capability taxonomy so plans pick valid routing tags.

**Pattern A (advisory)**: operator dispatches subtasks manually.
Working today with no code changes.

**Pattern B (auto-dispatch)**: deferred to v1.40 — worker detects
JSON decomposition output from orchestrate-capable agents and creates
subtasks via `orchestrator.createTask` automatically.

**Pattern C (claude-code MCP)**: deferred until claude-code system
prompt forwarding lands.

`tests/unit/seed-skills.integration.test.ts` (+2 tests) — verifies
all 4 orchestrator seeds present with the `orchestrate` capability
and reference the strict JSON schema in their prompts (so Pattern B
parser can rely on uniform output shape).

### feat: skill-based agent_definitions seeded from goodai-base + /agents_catalog

Closes the "no easy way to add agents to a project" gap. Previously
operators had only 7 generic definitions (claude-code-default,
codex-cli-default, etc.) and had to write SQL inserts to add specialized
roles. v34 seeds 8 ready-made standalone-llm definitions distilled from
goodai-base's skill catalog so adding a planner/reviewer/PRD-writer to
a project is a one-liner:

  /agent_create helyx:planner issue-analyzer helyx

**Migration v34** — inserts (idempotent, ON CONFLICT DO NOTHING):
- `issue-analyzer` — decompose issues into atomic tasks
  (capabilities: plan, decompose, issue-management)
- `brainstorm` — open-ended exploration with multiple perspectives
  (plan, explore, design)
- `prd-creator` — convert vague requests to formal PRDs
  (plan, document, spec)
- `interview` — surface unknowns before implementation
  (plan, interview, requirements)
- `feature-analyzer` — analyze code changes / branches
  (analyze, review, code)
- `review-logic` — code logic + edge case + contract review
  (review, code, logic)
- `changelog` — release notes from commits/diffs
  (document, changelog)
- `pr-issue-documenter` — PR descriptions and issue bodies
  (document, pr-management)

Each role's `system_prompt` is a focused 600-900 character distillation
of the corresponding goodai-base SKILL.md — designed for standalone-llm
runtime (no tool access required) so they work today without the
claude-code `--append-system-prompt` plumbing (deferred).

**`bot/commands/agents-catalog.ts`** (new): `/agents_catalog` Telegram
command lists all available agent_definitions grouped by runtime_type
with capabilities and descriptions. Bridges the discovery gap before
operators can `/agent_create` something useful. Auto-chunks long
catalogs across multiple messages to stay under the 4096-char Telegram
cap.

**Tests** (`tests/unit/seed-skills.integration.test.ts`) — 3 tests
asserting all 8 seeds exist with non-trivial system prompts + at least
one capability tag, that issue-analyzer has the `decompose` capability
(orchestrator routing depends on this), and that re-running v34
produces no duplicates.

379/379 unit tests pass.

### feat: per-instance system prompt + project context injection + topic routing

Closes the four context gaps surfaced after v1.38.0 (per-instance prompts,
topic binding, project context for standalone-llm, result routing).

**Migration v33** — adds two columns to `agent_instances`:
- `system_prompt_override TEXT` — when non-null, takes precedence over
  the definition's `system_prompt`. Lets operators specialize a shared
  role (e.g. one planner tuned for helyx, another for a different
  project) without cloning the whole definition.
- `forum_topic_id BIGINT` — Telegram forum topic this instance is bound
  to. When set, task results are auto-posted there.

**`agents/agent-manager.ts`**:
- `AgentInstance` interface adds `systemPromptOverride` and `forumTopicId`.
- `createInstance` accepts both as optional inputs.

**`scripts/standalone-llm-worker.ts`** (Gap 1 + Gap 3 + Gap 4):
- `resolveAgentContext` returns `system_prompt_override` when set,
  falling back to `system_prompt` from the definition.
- After resolving the agent context, the worker calls
  `buildProjectContext` and appends the rendered block to the system
  prompt. Falls back silently when the agent has no project_id or no
  facts/messages exist.
- After completing a task, the worker calls `routeTaskResultToTopic`
  which posts to the bound forum topic via grammy. Failures are
  logged, never raised — the result is already in `agent_tasks.result`.

**`agents/context-injector.ts`** (new — Gap 3):
- `buildProjectContext(agentInstanceId)` — fetches project facts
  (`memories.type IN ('fact','decision')` filtered to `project_path`)
  + last 20 messages. Returns null when no project bound or no
  data exists.
- `formatProjectContext(ctx)` — renders into a system-prompt block
  with project header + facts + recent conversation. Honors a
  4000-char budget; individual messages truncated to 500 chars.

**`agents/result-router.ts`** (new — Gap 4):
- `routeTaskResultToTopic({...})` — posts task result to the
  agent's bound forum topic. Reads `bot_config.forum_chat_id` for the
  global chat, agent's `forum_topic_id` for the thread. Uses a
  cached grammy `Api` client built from `TELEGRAM_BOT_TOKEN`.
- Truncates >3800 chars with a "see /task <id>" pointer.
- Idempotent no-op when topic / chat / token is missing.

**`bot/commands/agent-create.ts`**:
- New flags: `--prompt "..."` (per-instance system override) and
  `--topic <id>` (forum topic binding).
- New tokenizer respects double-quoted segments so prompts can contain
  spaces.
- Reply now lists active overrides.
- Strict flag validation: unknown `--flag`, `--topic` without numeric
  id, `--prompt` without value all surface clear error messages.

**Tests** (376 pass total, +18 new):
- `tests/unit/context-injector.integration.test.ts` (7) —
  `buildProjectContext` happy + null cases (no project / empty
  project), filters note types, oldest-first ordering;
  `formatProjectContext` budget enforcement and section structure.
- `tests/unit/result-router.integration.test.ts` (5) —
  `getForumTopicId` happy + null + non-existent paths;
  `routeTaskResultToTopic` no-op semantics (no topic, no chat config).
- `tests/unit/agent-create-delete.integration.test.ts` (+6) —
  `--prompt` persists `system_prompt_override`, `--topic` persists
  `forum_topic_id`, parse errors for malformed flags, multi-flag combo.

## v1.38.0

### feat: /agent_create + /agent_delete Telegram commands

Closes the gap surfaced after v1.37.0: previously agent_instances could
only be created via direct SQL or DB migrations. The bot listed,
started, and stopped them but had no creation flow.

**`/agent_create <name> <definition> [project] [--stopped]`**:
- Validates: definition exists AND `enabled=true`; project (if given)
  exists; `(project_id, name)` is unique (DB UNIQUE plus a pre-flight
  check for clearer error messaging).
- Defaults `desired_state='running'` so the reconciler picks it up
  within ~5 s. `--stopped` flag creates an inert instance.
- Emits `agent_events` row with `event_type='instance_created'`,
  `source=telegram`, plus the resolved definition + project names.

**`/agent_delete <id>`**:
- Two-step flow: confirmation message with inline ✅/❌ buttons.
- On confirm: sets `desired=stopped`, polls `actual_state` for up to
  30 s waiting for the reconciler to tear down the runtime, then
  `DELETE`s the row.
- FK behavior: tasks become unassigned (`agent_instance_id = NULL`);
  events purged via `ON DELETE CASCADE`.
- Surfaces a warning if the reconciler does not settle within the
  budget — orphan tmux windows can be cleaned up via `/tmux_kill`.

**`agents/agent-manager.ts`**:
- New `deleteInstance(id): Promise<boolean>` method. Pure SQL DELETE —
  callers are responsible for stopping the runtime first. Idempotent.

**Tests** (`tests/unit/agent-create-delete.integration.test.ts`) — 14
integration tests:
- `deleteInstance` happy path + idempotent missing-id.
- `/agent_create` arg validation (missing args, unknown definition,
  unknown project), happy path (default running, `--stopped` flag),
  duplicate-name uniqueness, `instance_created` event metadata stored
  as JSONB object (regression guard for the v1.37.0 fix).
- `/agent_delete` arg validation, confirmation-prompt structure with
  inline keyboard.

358 unit tests pass total.

## v1.37.0

### fix: systemic ::jsonb cast bug across 14 call sites + data migration (CRITICAL)

**v1.34.1 fixed the `${json}::jsonb` parameter-cast bug for the two
capability-routing call sites. This release closes the same bug across
twelve more.** postgres.js v3 silently strips trailing `::jsonb` casts on
parameter placeholders, so `${JSON.stringify(x)}::jsonb` binds the value
as TEXT — postgres then stores it as a JSONB **scalar string** containing
the stringified JSON, instead of parsing it as a proper JSONB
object/array.

**Production impact (pre-fix)**:
- `agent_tasks.payload` of every task created via `orchestrator.createTask`
  was a scalar string. Reads returned a JS string, not an object.
  `task.payload.required_capabilities` and `task.payload.model_tier`
  silently evaluated to `undefined` — `handleFailure`'s payload-fallback
  path and the v1.36.0 tier-override never fired in production.
- `agent_instances.runtime_handle` corruption: each reconcile cycle
  spread a stringified handle into a char-map object
  (`{"0":"{","1":"\""...}`), then re-stringified it. **Exponential
  doubling**. One instance's row hit **240 MB** before the bug was
  discovered, blocking the reconcile loop from reaching downstream
  instances.
- `agent_events.metadata`, `agent_tasks.result`, `sessions.metadata`,
  `sessions.cli_config` all stored as scalar strings — readable by
  postgres but useless from JS without a manual `JSON.parse`.

**Code patches** — every `${JSON.stringify(x)}::jsonb` replaced with
`${sql.json(x)}` (or `${tx.json(x)}` inside transactions):

- `agents/agent-manager.ts:207, 287, 326` — `createInstance.runtime_handle`,
  `updateRuntimeHandle`, `logEvent.metadata`.
- `agents/orchestrator.ts:182, 196, 370, 381, 538, 815` —
  `createTask.payload`, `task_assigned` event, `setResult.result`,
  `task_result_set` event, `decomposeTask` event, `task_reassigned` event.
- `scripts/standalone-llm-worker.ts:175, 255` — `completeTask.result`,
  `onFallbackEvent` metadata.
- `sessions/manager.ts:81, 83, 285` — sessions `metadata`, `cli_config`
  (INSERT and UPDATE).

**Migration v32** — repairs existing corrupted rows:
- `agent_tasks.payload`, `agent_tasks.result`, `agent_events.metadata`,
  `agent_instances.runtime_handle`, `sessions.metadata`,
  `sessions.cli_config`: parse-back via `(col#>>'{}')::jsonb` for rows
  whose `jsonb_typeof = 'string'` AND text starts with `"{` or `"[`.
- Bloated `agent_instances.runtime_handle` rows (>1MB) reset to `'{}'`:
  the char-map artifact is unrecoverable; the reconciler re-derives the
  handle on the next tick. Idempotent — re-running finds zero rows.

**Tests** (`tests/unit/jsonb-cast-systemic.integration.test.ts`) — 8
integration tests against a live DB:
- `createTask.payload` stored as object (empty + nested).
- `setResult.result` stored as object.
- `logEvent.metadata` stored as object.
- `createInstance.runtime_handle` + `updateRuntimeHandle` preserve object
  shape across two write cycles (regression catches the bloat-spread bug
  via `handle["0"] === undefined` assertion).
- `handleFailure.task_reassigned` event metadata stored as object.
- Round-trip: `task.payload.required_capabilities` reachable as a real
  array, not via index-access on a string.

Reverting any patched site to the broken form fails the corresponding
test. 344/344 unit tests pass.

**Live verification post-migration**:
- `agent_instances.runtime_handle` for instance 6: 240 MB scalar string
  → 2 B JSONB object `{}`.
- Instance 16 (`helyx:p0verify`) `runtime_handle`: scalar string `"{}"`
  → JSONB object `{}`.
- Existing tasks: `jsonb_typeof = 'object'` for all `payload` fields.

## v1.36.0

### feat: per-task model_tier override ("flash" / "pro")

`agent_tasks.payload.model_tier = "flash" | "pro"` now overrides the agent
definition's default `model_profile` for an individual task without
re-binding the agent. Resolution is advisory — invalid tiers, missing
profiles, or resolver errors all fall back to the agent's default
(no task failures).

`llm/tier-resolver.ts` (new): `isValidTier`, `resolveTierOverride`. Maps
`"flash" → deepseek-flash`, `"pro" → deepseek-pro` (profile names from
the v31 migration). Hardcoded mapping intentionally — adding a new tier
must touch this file.

`scripts/standalone-llm-worker.ts`: after resolving the agent's default
provider, calls `resolveTierOverride(task.payload)` and uses the override
when present.

`agents/orchestrator.ts`: documents the reserved payload keys
(`model_tier`, `required_capabilities`) on `CreateTaskInput.payload`.

`tests/unit/tier-resolver.test.ts` (new): 13 tests covering the
`isValidTier` type guard (7), payload-shape short-circuits without DB
(6), and DB-backed profile resolution + cross-tier model uniqueness
(3 gated on DATABASE_URL).

### test: integration tests lock in jsonb capability routing fix

`tests/unit/capability-routing.integration.test.ts` — 8 new tests against a
live DB exercise `orchestrator.selectAgent` and `orchestrator.handleFailure`
end-to-end with seeded `agent_definitions`. Reverting either call site to
the broken `@> ${json}::jsonb` form fails 5/8 of the suite. Skipped via
`test.skipIf(!HAS_DB)` when DATABASE_URL is unset.

Coverage:
- selectAgent: subset match, exact match, missing-cap returns null, mixed
  match+missing returns null, agent with unrelated cap excluded.
- handleFailure: reassigns to alternative, no_alternative when callers
  exclude every matching agent, payload.required_capabilities fallback
  path (when task has no failing agent_instance_id).

### feat: startup state-recovery sweeps for daemon-crash resilience

`runtime/state-recovery.ts` — new module exporting `sweepStaleTransientStates`,
`sweepOrphanedWaitingApproval`, `runStartupSweeps`. Replaces the inline SQL
that previously ran in `scripts/admin-daemon.ts`.

The reconciler sets `actual_state` to `'starting'` / `'stopping'` BEFORE
calling `driver.start()` / `driver.stop()`. A daemon crash mid-call leaves
the row in a transient state forever — the reconciler's branching logic
treats `'starting'` as in-flight and never spontaneously re-evaluates it.
The new sweep resets such rows to `'stopped'` if `last_health_at` is older
than 60s (or NULL), so the next reconcile pass probes health and either
flips to `'running'` (if the tmux window survived the crash) or calls
`driver.start` again (subject to the per-instance restart budget).

The 60-second staleness window protects the *current* daemon's in-flight
transitions from accidental reset — tick (~5s) plus driver.start latency
fits comfortably inside it.

`tests/unit/state-recovery.integration.test.ts` — 10 tests against a live
DB:
- Stale `'starting'` / `'stopping'` reset to `'stopped'`.
- NULL `last_health_at` treated as stale.
- Fresh `'starting'` (within window) NOT touched.
- `'running'` rows untouched regardless of staleness.
- Custom `staleSeconds` threshold respected.
- Orphaned `'waiting_approval'` flips to `'running'` (no staleness bound).
- `runStartupSweeps` returns counts and is idempotent.

Closes the deferred follow-up filed at the end of v1.35.0.

## v1.35.0

### feat: tmux-driver instance-aware window naming + AGENT_INSTANCE_ID env propagation (P0 architecture)

**Closes the four architectural gaps surfaced during the v1.34.x smoke
session.** Multi-instance-per-project was effectively broken before this
release: the runtime layer used `projectName` as the tmux window name,
forcing all agents on a project to share one window. PRD §17.4's
`<project>:<role>` naming convention was incompatible with tmux because
of `:` in window names.

**`runtime/drivers/tmux-driver.ts`**

- New exported `sanitizeTmuxWindowName(name)` helper. Maps `:` and `/`
  to `_`, strips other non-`[a-zA-Z0-9_-]` characters. Throws on
  pathological input that sanitizes to empty.
- `start()` now takes optional `instanceName` from `RuntimeStartConfig`
  and derives the tmux window name from it (sanitized). Falls back to
  `projectName` when omitted (legacy callers).
- `start()` accepts `env: Record<string, string>` and prepends each as
  `KEY='value'` (POSIX single-quote literal — no shell expansion of the
  value). Key validated against `/^[A-Z_][A-Z0-9_]*$/`. Value's single
  quote escaped as `'\\\''`.
- `health()` returns `state: "stopped"` (was: `"running"`) when the
  handle has no `tmuxWindow`. Previous behavior was a session-level
  false-positive that made every fresh agent_instance immediately
  observe `actual_state=running` and skip the spawn path.

**`runtime/types.ts`**

- `RuntimeStartConfig.instanceName?: string` field documented.

**`runtime/runtime-manager.ts`**

- Reconciler stamps `handle.tmuxWindow` from sanitized `inst.name` BEFORE
  calling `driver.health(handle)` for legacy instances persisted with
  empty `runtime_handle`. Without this, the new "stopped on empty"
  health behavior would respawn every legacy claude-code window on
  every tick — wiping out user's running sessions.
- Reconciler now passes `instanceName: inst.name` and
  `env: { AGENT_INSTANCE_ID: String(inst.id) }` to `driver.start()`.
  AGENT_INSTANCE_ID propagation is required for the standalone-llm
  worker — without it the worker exits 2 immediately.
- `runtimeHandle` from postgres.js is frozen — spread into a fresh
  object before mutating. The pre-stamp threw `TypeError: Attempted to
  assign to readonly property` until this was fixed.

**Tests** (`tests/unit/runtime-driver.test.ts`)

11 new tests:
- `sanitizeTmuxWindowName` describe block (5 tests): `:` collapse,
  legacy round-trip, `/` and `.` collapse, invalid char strip, empty
  rejection.
- `instanceName drives tmux window name` — proves `helyx:planner` ⇒
  `helyx_planner` window in tmux new-window.
- `falls back to projectName when instanceName is omitted` — legacy.
- `env vars prepend as single-quoted assignments` — proves
  `AGENT_INSTANCE_ID='12'` lands in the typed shell command.
- `env var name with shell metacharacters is rejected`.
- `env var values are single-quote-isolated` — proves `$(rm -rf /)` is
  literal not subshell.
- `env var value containing single quote is properly escaped` (POSIX
  `'\\\''` round-trip).
- `health() returns 'stopped' when no window on handle (P0 fix)`
  — replaces the old "session-level running" test.

305/305 unit tests pass. 22 pre-existing non-TS5097 errors unchanged.

**Live verification**

- 5 of 8 legacy instances stayed `running` across daemon restart
  (no respawn loop) — pre-stamp correctly identifies existing tmux
  windows.
- Fresh `helyx:autoplan` instance auto-spawned via reconciler with
  `AGENT_INSTANCE_ID='15'` env — first ever PRD §17.4-compliant
  agent in this install.
- Standalone-llm worker received the env var, started polling
  agent_tasks, no exit-2.

**Deferred (still open follow-up)**: there's a stuck-state cleanup
needed for instances that landed in `actual_state="starting"` during
the buggy daemon runs. A startup sweep that resets `starting` →
`stopped` for instances older than N seconds would prevent operator
confusion. Filed as a follow-up to the next release.

## v1.34.1

### fix(orchestrator): CRITICAL ::jsonb cast bug + DeepSeek V4 migration (PR #9)

**Two changes, one CRITICAL hotfix and one config migration.** Discovered
end-to-end during the v1.34.0 smoke-test session.

**🔥 CRITICAL — `postgres.js` strips `::jsonb` cast on parameter placeholders**

`agents/orchestrator.ts` — `selectAgent` and `handleFailure` both filtered
agent definitions by required capabilities using:

```sql
WHERE ad.capabilities @> ${requiredJson}::jsonb
```

Manually in psql this works. But `postgres.js` v3 **silently strips the
trailing `::jsonb` cast** on a parameter placeholder. The query that ships
to Postgres becomes `WHERE ad.capabilities @> $1` with `$1` bound as TEXT —
`jsonb @> text` matches no rows.

**Capability-based agent selection has been broken since the orchestrator
MVP shipped (Phase 7).** The bug was masked because most installs only had
legacy `proj_start` agents that never reached this code path. Both PR #7
and PR #8 reviews inspected the SQL and assumed the cast worked.

**Fix:** `sql.json(...)` / `tx.json(...)` — postgres.js's explicit JSONB
binder forces the parameter type at the wire-protocol level.

```diff
- AND ad.capabilities @> ${requiredJson}::jsonb
+ AND ad.capabilities @> ${sql.json(required)}
```

Verified end-to-end with two `planner-default` agents (#12, #13) and a
failed task assigned to #12: `POST /api/tasks/2/reassign` now returns
`outcome:"reassigned"`, `newAgentInstanceId:13`, `attempts:1`.

**Migration v31 — DeepSeek V4**

DeepSeek deprecated `deepseek-chat` (V3) when shipping V4. The API now
exposes only `deepseek-v4-flash` (small/fast) and `deepseek-v4-pro`
(complex/reasoning). Existing `model_profiles` seeded by v22 still
referenced `deepseek-chat`, which would silently fail on first use
post-V4-rollout.

| Profile / setting | From | To |
|---|---|---|
| `model_providers.DeepSeek.default_model` | `deepseek-chat` | `deepseek-v4-flash` |
| New `deepseek-flash` profile | — | `deepseek-v4-flash` |
| New `deepseek-pro` profile | — | `deepseek-v4-pro` |
| `planner-default` profile | `deepseek-chat` | **`deepseek-v4-pro`** |
| `reviewer-default` profile | `deepseek-chat` | **`deepseek-v4-pro`** |
| `orchestrator-default` profile | `deepseek-chat` | **`deepseek-v4-pro`** |
| `deepseek-default` profile | `deepseek-chat` | `deepseek-v4-flash` |

Per-role tier rationale: planner / reviewer / orchestrator perform
decompose / review / routing — all reasoning-heavy. Pro tier. Future
"small task" agents (e.g. tagger, summarizer) can use the new
general-purpose `deepseek-flash` profile via `helyx model set <agent>
deepseek-flash`.

All updates guarded by `WHERE model = 'deepseek-chat'` so re-running on a
hand-migrated DB is a no-op.

`.env.example` updated to recommend `deepseek-v4-flash` as the
`CUSTOM_OPENAI_DEFAULT_MODEL` default with a comment explaining the
flash/pro split.

**Architectural gaps surfaced (deferred to follow-up PRs)**:
- `tmux-driver` uses `projectName` as window name, not `instance.name` —
  multi-instance-per-project is not actually supported by the runtime.
- `NAME_REGEX` rejects `:` so `<project>:<role>` from PRD §17.4 is
  incompatible with tmux. Reconciler has been silently false-positive
  matching via substring on existing project windows.
- `admin-daemon` reconciler doesn't auto-spawn standalone-llm workers
  through `tmux-driver` — for the smoke test we spawned them manually.
  These are real architectural gaps that need their own focused PR.

**Verification done**: bun test 294/294 pass, type-check 22 (baseline
unchanged), live reassign chain verified, migration v31 idempotent on
hand-migrated DB.

## v1.34.0

### refactor: architecture cleanup — boundary fixes from the PR #7 review (PR #8)

PR #8 — 14 files, +520 / −154. Closes the architecture findings (F-005..F-008)
and medium-severity polish (F-016..F-025) that were explicitly deferred at the
v1.33.0 merge. **No new features, no behavior changes visible to operators** —
purely structural improvements that pay down maintenance debt.

**Boundary fixes**
- **F-005**: `runtime/runtime-manager.ts` no longer issues raw SQL on `projects`
  or `agent_definitions` — now goes through `projectService.get()` and
  `agentMgr.getDefinition()`. Runtime layer is agent/project schema-agnostic.
- **F-006**: New `AgentManager.listInstancesEnriched()` consolidates the JOIN
  that `handleListAgents` previously duplicated. `handleCreateAgent` follow-up
  also routed through `agentManager` + `projectService` (no more raw SQL on
  agent_definitions / projects).
- **F-007**: `StreamContext.taskId` / `agentInstanceId` removed in favor of an
  `onFallbackEvent(type, metadata)` callback. LLM transport is now agent-
  agnostic; `llm/client.ts` no longer imports `memory/db.ts` (not even via
  lazy `import()`). New `FallbackEventType` exported.
- **F-008**: New `runtime/supported-runtimes.ts` is the single source of truth
  for supported runtime types. `tmux-driver.ts` and `cli.ts` wizard prompts
  both derive from it; `gemini-cli` (which was never implemented) removed.
  CI-enforced drift test parses `run-cli.sh` case branches and asserts
  equality with `SUPPORTED_RUNTIMES_LIST`.

**Concurrency / correctness**
- **F-016**: documented READ COMMITTED race window in `handleFailure` — joined
  reads on `agent_definitions` are not row-locked, so a concurrent
  `handleSetAgentProfile` can change the candidate pool mid-tx.
- **F-018 + H-1**: `decomposeTask` refreshes the FULL task row inside its tx
  and returns the fresh `parentTask` (was returning a snapshot from before the
  LLM call, which a concurrent `handleFailure` could invalidate).

**Security**
- **F-019**: `validateProjectPath` rejects `..`, `.`, AND empty path segments
  (was just `..`). +3 unit tests covering each case.
- **F-007 follow-up**: `sanitizeUpstreamMessage` now applied at the
  `primaryErrorMsg` capture site in `generateResponse`, covering Anthropic SDK
  errors that previously bypassed the `fetchOpenai` sanitize.
- **C-1**: SIGUSR1 dedupe comment corrected — module-load semantics, not
  EventEmitter dedup. Plus startup `logger.debug` line for Bun-issue
  diagnostics.

**Operations**
- **F-020**: SIGUSR1 handler in `llm/client.ts` clears the `LLM_FALLBACK_PROFILE`
  cache so an API-key rotation no longer requires a full bot restart.
- **F-021**: `standalone-llm-worker` collapsed two queries into a single
  `resolveAgentContext` call. JOIN now also filters `ad.enabled = true` —
  disabled definitions correctly fail tasks instead of silently running with
  stale config.
- **F-025**: dashboard ModelsPage refetch failures surface to console instead
  of fire-and-forget swallow.

**Database**
- New migration **v30**: `idx_agent_instances_project_id` for the dashboard
  `listInstancesEnriched` filter. Without it the per-page query degraded to a
  sequential scan as `agent_instances` grew.

**Test growth**: 294 unit tests (was 289). New suite:
- `supported-runtimes.test.ts`: 2 tests for the SoT drift check (parses
  `run-cli.sh` and asserts case-branch equality with `SUPPORTED_RUNTIMES_LIST`).
- 3 new tests in `runtime-driver.test.ts` covering `..`, `.`, and `//` path
  validation.

**Deferred to future releases**: §22 E2E suite, §9.3 pty-driver, §9.5
docker-driver — same as v1.33.0; no progress this release.

## v1.33.0

### feat: agent runtime refactor — provider-agnostic agent control plane

PR #7 — 91 commits, +13K LOC, 66 files. Refactors Helyx from a Claude/tmux-centric
Telegram control panel into a provider-agnostic agent control plane. ~98% of the
`agent-runtime-refactor-2026-04-25` PRD shipped (see `docs/requirements/`).

**Provider-agnostic agent runtime (PRD §10.4, §9.4)**
- 5 runtime adapters now whitelisted: `claude-code`, `codex-cli`, `opencode`,
  `deepseek-cli`, `standalone-llm` (new)
- standalone-llm worker (`scripts/standalone-llm-worker.ts`): polls
  `agent_tasks`, claims via `FOR UPDATE SKIP LOCKED`, runs through
  `generateResponse()`, writes `done`/`failed` with audit events.
  Crash-recovery sweep on startup resets stuck `in_progress` rows.
- Capability-based agent routing in `orchestrator.handleFailure` /
  `selectAgent` (`code` / `review` / `plan` / `orchestrate`).

**Atomic orchestrator (PRD §14)**
- `handleFailure` and `decomposeTask` now run under single transactions
  with `FOR UPDATE` row locks — closes the double-assignment race in
  cross-agent reassignment.
- Three terminal-failure paths collapsed into one `inlineFail()` closure.
- Non-string `requiredCapabilities` rejected up-front.

**Provider failover (PRD §11.2)**
- New `LLM_FALLBACK_PROFILE` env: when set, `generateResponse` retries
  via the named `model_profiles` row on retryable errors (429, 5xx,
  timeout, network failure, rate-limit, "service unavailable").
  Non-retryable errors (401/403/404/context-length) skip fallback to
  avoid storms.
- `agent_events` traceability: `model_primary_failed` /
  `model_fallback_selected` / `model_request_completed` events written
  when taskId is in scope.

**Operator surface (PRD §17.7 — 13/13 CLI commands)**
- `helyx agents` / `agent {create,start,stop,restart,snapshot,logs}`
- `helyx runtime {doctor,status}` — non-destructive prerequisite
  checks + live driver readiness
- `helyx providers` / `provider test <ref>` — credential validation
  via ping/pong against the configured endpoint
- `helyx models` / `model set <agent> <profile>` — profile binding
- `helyx setup-agents` — re-run agent-runtime portion only
- 12 new HTTP API endpoints under `/api/agents/*`, `/api/tasks/*`,
  `/api/providers/*`, `/api/profiles`, `/api/runtime/status`

**Dashboard (PRD §16)**
- Three new pages: Agents (start/stop/restart + drift indicator),
  Tasks (filter chips + parent pivot + reassign), Models (read-only
  providers/profiles).
- React `<ErrorBoundary>` above `<Outlet />` — sidebar survives page
  errors instead of white-screening.
- 3 new nav items with full en+ru i18n.

**Wizard hygiene (PRD §17.1, §17.6)**
- Existing-`.env` guard: `helyx setup` re-run prompts
  overwrite/skip/cancel with literal `yes` confirmation before
  destroying secrets.
- `chmod 600 .env` on every wizard write — file is no longer
  world-readable.
- 4 new agent-runtime prompts (driver, coding-runtime,
  default-agents, planner-reviewer) with API provider sub-flow.
- Per-project coder + planner/reviewer/orchestrator instance
  bootstrap. DeepSeek quick-setup auto-seeds `model_providers` +
  `model_profiles`.

**Security hardening (PRD §20)**
- Shell-injection closures across `tmux-driver`: `tmuxSession`,
  `runtimeType`, `command` override, `text` input, `snapshot.lines`
  all validated/escaped. 5 new tests on attack vectors.
- SSRF guard on `/api/providers/:id/test`: Ollama localhost-only
  allowlist; non-Ollama require https + public allowlisted host
  (anthropic / openai / openrouter / google / deepseek / groq);
  RFC-1918, link-local, loopback rejected.
- Upstream API response bodies sanitized before storage in
  `api_request_stats.error_message`: `sk-/pk-/Bearer/api_key`
  patterns stripped, length capped at 500 bytes.
- All new `/api/*` endpoints behind the existing JWT gate.

**Database**
- 8 new migrations (v22 → v29): provider/profile tables, agent
  tables, runtime_type column, `agent_events`, hot-path indexes,
  standalone-llm role definitions.
- v28 indexes: `idx_agent_events_task_event (task_id, event_type)`
  composite + `idx_agent_definitions_capabilities` GIN — both
  inside the `FOR UPDATE` hot path of `handleFailure`.

**Test growth**: 289 unit tests (was ~100). New suites:
runtime-driver (36 tests, shell-injection vectors), orchestrator
(17 tests, transaction contracts), llm-fallback (11 tests,
retry classifier).

**Deferred to follow-up**: §22 E2E suite (Telegram-mock + Playwright
infra), §9.3 pty-driver / §9.5 docker-driver (PRD §18 marks Phase 5
as optional), 4 architecture refactors from the review pass
(F-005..F-008 — RuntimeManager → agent_* boundary leak,
LLM-client/agent coupling, single-source-of-truth for runtime types).

## v1.31.0

### fix: security hardening + concurrency correctness (full project review)

Comprehensive review of 58 files (4009 insertions since v1.24.0) produced 6 blockers
and 18 major findings — all fixed in this release.

**Security:**
- `handleMonitorCallback` now checks `TELEGRAM_CHAT_ID` before queuing Docker/daemon
  restarts — matches the guard already present in `handleSupervisorCallback`
- `scan_project_knowledge` MCP tool validates the target path is within
  `HOST_PROJECTS_DIR` / `HOME` to prevent path traversal
- `cli.ts` `helyx add` / `helyx remove`: allowlist regex validation + LIKE wildcard
  escaping (`%`, `_`, `\`) — `helyx remove %` no longer deletes all projects
- Dashboard restart buttons now require `window.confirm()` before firing
- Dashboard mutation errors (restart daemon / restart container) now surface to the
  user instead of being silently swallowed

**Concurrency:**
- All 5 supervisor `setInterval` loops now carry in-flight guards
  (`sessionCheckRunning`, `queueCheckRunning`, `voiceCheckRunning`,
  `broadcastRunning`, `idleCheckRunning`) — prevents overlapping executions that
  caused duplicate `proj_start` commands and duplicate Telegram alerts
- `tgPost` 429-retry now creates a fresh `AbortSignal.timeout(10_000)` instead of
  reusing the already-elapsed one from the first request — all retries actually fire
- `writeProcessHealth`: in-flight guard + `timeout 10 docker ps` to prevent DB pool
  starvation when Docker daemon is hung
- `admin-daemon` startup: reset `admin_commands` rows stuck at `status='processing'`
  (crash-recovery for commands lost between TX commit and `setImmediate` dispatch)

**Data integrity:**
- `checkIdleSessions`: `forceSummarize` return value checked before deleting messages
  — no more data loss when summary quality check skips trivial content
- `checkIdleSessions`: `deleteBefore` timestamp captured before `forceSummarize` call
  — messages arriving during the 30s Ollama call are not deleted
- `IDLE_COMPACT_MIN`: minimum bound `Math.max(10, ...)` prevents accidental compaction
  of all sessions when env var is empty or zero
- `voiceStatusId` race fixed: `INSERT INTO voice_status_messages` is now `await`-ed
  before `enqueueForTopic` — `clearVoiceStatus()` always has a valid ID; removed
  redundant explicit calls on early-return paths (only `finally` runs cleanup now)

**Correctness:**
- `updateDiff` recursive self-call on Telegram edit failure replaced with direct
  non-recursive `sendTelegramMessage` — eliminates stack overflow risk
- `diffMessages` key now includes `message_thread_id` via `diffKey(chatId, extra)` —
  prevents key collision across multiple forum topics sharing the same `chatId`
- `handleMonitor` refresh: `handleMonitor(ctx)` called before `deleteMessage()` so
  the old message stays intact if the new send fails
- `gemma4:e4b` hardcode replaced with
  `OLLAMA_CHAT_MODEL ?? SUMMARIZE_MODEL ?? "gemma4:e4b"` in both `supervisor.ts`
  and `supervisor-actions.ts` — no more 10s hang on installs without that model
- `sendStatusBroadcast` success log: `console.error` → `console.log`

---

## v1.30.0

### feat: Supervisor idle auto-compact + SUMMARIZE_MODEL + summary quality validation

- **feat(supervisor)**: idle session auto-compact after `IDLE_COMPACT_MIN` minutes
  (default 60) with ≥10 messages — calls `forceSummarize`, clears cache + DB
- **feat(memory)**: `SUMMARIZE_MODEL` env var — use local Ollama model for
  summarization (`SUMMARIZE_MODEL=gemma4:e4b`), falls back to main LLM on failure
- **feat(memory)**: summary quality validation before saving — rejects trivial
  summaries (`< 50 chars`, matches "nothing significant" patterns); pre-check skips
  summarization for sessions with avg message length < 25 chars
- **feat(setup)**: Ollama detection in setup wizard — prompts to configure
  `EMBEDDING_MODEL` and `SUMMARIZE_MODEL` when Ollama is available

---

## v1.29.0

### feat: Supervisor LLM diagnosis with Ollama + /status in supervisor topic

- **feat(supervisor)**: switched to `gemma4:e4b` via Ollama `/api/chat` with
  `think: false` (~3.2s vs 7.6s for thinking models)
- **feat(supervisor)**: any message in supervisor topic returns live status + LLM
  assessment of system health, scoped to Helyx monitoring context
- **feat(supervisor)**: recovery verification — polls `active_status_messages` for
  60s after `proj_start`; sends ✅ or ⛔ result; inline 🔄 retry button on failure
- **feat(supervisor)**: 5-minute status broadcast replaces hourly pulse — deletes
  previous message so new one triggers notification

---

## v1.28.0

### feat: Helyx Supervisor — automated session health monitoring

New `scripts/supervisor.ts` module integrated into `admin-daemon`:

- **Session watchdog**: checks `active_status_messages` every 60s — stale heartbeat
  (> 2 min) triggers `proj_start` via `admin_commands`
- **Queue watchdog**: stuck `message_queue` entries (> 5 min, `delivered=false`)
  surface as inline-button alerts (🔄 Restart / ✅ Ignore)
- **Voice cleanup**: `voice_status_messages` rows > 3 min edited to "bot restarted"
  warning + deleted from DB
- **LLM diagnosis**: every incident includes an Ollama explanation (best-effort,
  10s timeout, skipped gracefully when Ollama unavailable)
- **Telegram notifications**: all alerts → `SUPERVISOR_TOPIC_ID` with 429 retry
- **Idempotency**: 5-minute dedup window prevents duplicate alerts per incident

---

## v1.27.7

### fix(voice): track status messages in DB — recover stale "downloading..." on restart

When the bot restarted mid-download, the "🎤 Voice message — downloading..." Telegram
message was never updated, leaving it visually stuck forever. Fix:
- New `voice_status_messages` table: each in-flight voice download registers its
  Telegram status message ID.
- On bot startup, `recoverStaleVoiceStatusMessages` edits any rows older than 5 min to
  "⚠️ Бот перезапущен — голосовое не обработано. Отправь повторно."
- DB row is deleted via `finally {}` after the queue task completes (success or error).

### fix(voice): explicit file_path null check + error reason in status message

Telegram Bot API omits `file_path` for files >20 MB. Using `file.file_path!` (non-null
assertion) caused a silent TypeError crash. Fix throws a descriptive error
(`"File not accessible via Bot API, possibly >20 MB"`). Download failures now show the
actual reason in the Telegram status message instead of a generic "Failed to download".

### fix(voice): 30 s download timeout + queued/downloading status distinction

`downloadFile` had no timeout on the Telegram CDN fetch — a slow response blocked the
per-topic queue indefinitely. Added `AbortSignal.timeout(30_000)`. Status message now
shows "queued..." when the slot is occupied and updates to "downloading..." when the
task actually starts.

---

## v1.27.6

### fix(tmux-watchdog): auto-confirm dev-channel prompt in ALL windows, not just active sessions

Root cause of the "altsay stuck at Enter to confirm" deadlock: `pollWindows()` only
checked windows with active sessions, but a session can only become active *after*
the startup prompt is confirmed — a circular dependency. Fix adds a global window
scan at the top of each poll cycle that sends Enter to any window showing the
`--dangerously-load-development-channels` warning, regardless of session state.

### fix(channel): heartbeat failure counter — exit after 2 consecutive DB errors

Previous code used `.catch(() => true)` on `renewLease()`, silently treating any
DB error as "lease still held". This meant a channel.ts process whose DB connection
died would keep running indefinitely, holding a zombie session. Fix tracks
consecutive failures; exits after 2 so the session is released and a fresh restart
can recover.

### fix(tts): return audio format from synthesize() — prevent MP3-as-WAV delivery

`synthesize()` previously returned `Buffer | null`; callers always sent
`audio/wav` / `voice.wav`. Yandex and OpenAI return MP3, so Telegram rejected the
audio. Fix changes the return type to `{ buf: Buffer; fmt: "mp3" | "wav" } | null`.
Each provider now tags its output format; `maybeAttachVoice` and `maybeAttachVoiceRaw`
use the correct MIME type and filename (`voice.mp3` vs `voice.wav`).

### fix(message_queue): deduplicate on restart — prevent double delivery after Docker restart

Root cause of duplicate responses after `docker compose up -d`: grammY's long-polling
re-delivers Telegram updates that weren't acknowledged before the process died. The
same message was inserted into `message_queue` twice (no uniqueness constraint), both
rows were dequeued and delivered to Claude, producing two replies.

Fix:
- Migration v19: partial unique index on `message_queue(chat_id, message_id)` excluding
  empty strings and `'tool'` entries.
- `bot/text-handler.ts` and `bot/media.ts`: INSERTs now use
  `ON CONFLICT ... DO NOTHING` so duplicate Telegram updates are silently dropped.

---

## v1.27.5

### fix(status): spinner animates at 1 fps instead of every 5 s

Status message edit interval reduced from 5 000 ms to 1 000 ms so the braille
spinner visibly rotates every second. The edit is cheap — pane snapshot and token
counters are already cached; only the spinner frame and elapsed counter change on
each tick.

---

## v1.27.4

### feat(bot): `/interrupt` command — interrupt running Claude session via Telegram

New `/interrupt` Telegram command (`bot/commands/interrupt.ts`):

- If one active remote session → interrupts immediately, no extra prompts.
- If multiple active sessions → shows inline keyboard with ⚡ button per session.
- Inserts `tmux_send_keys` + `esc` action into `admin_commands` queue.

### fix(admin-daemon): poll-based interrupt confirmation instead of fixed sleep

`tmux_send_keys` with `action: "esc"` now polls for the confirmation dialog
(`Enter to confirm / Esc to cancel`) in a loop (200 ms intervals, 1.5 s deadline)
instead of a fixed 800 ms sleep. Faster on quick machines, reliable on slow ones.
Result message distinguishes confirmed vs. Escape-only.

### feat(status): animated braille spinner with stale indicator

`channel/status.ts` now uses a 10-frame braille spinner (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) instead
of a static ⏳ icon. If no `update_status` call arrives for >60 s, the spinner
shows ⚠️ to indicate the session may be stalled.

### fix(channel/tools): delete status after reply is sent

`reply` tool previously deleted the status message before sending the reply, so
the ✅ completion indicator briefly disappeared before the answer appeared.
Status is now deleted after the reply is confirmed sent.

### fix(run-cli.sh): faster and longer auto-confirm polling

Shell-side "development channels" warning auto-confirmer now polls every 0.5 s
(was 1 s) for up to 120 iterations (60 s, was 30 s). Comment updated to reflect
the actual behaviour.

### fix(tmux-watchdog): fallback dev-channel prompt auto-confirm

Added `detectDevChannelPrompt()` as a watchdog fallback for the startup
`--dangerously-load-development-channels` warning. If `run-cli.sh`'s shell-side
watcher races or times out, the watchdog silently sends Enter on the next poll
cycle. No Telegram notification is generated.

### fix(tmux-monitor): visible-only pane capture; normalize status for comparison

`captureTmux()` now captures only the current visible screen (no `-S` scrollback
lines), eliminating ghost detections from already-answered dialogs and stale tool
calls. `normalizeForComparison()` strips elapsed time and token counters before
diffing, preventing status updates from firing every 5 s just because the timer
incremented.

---

## v1.27.3

### fix(projects): idempotency — suppress duplicate start/stop commands

Double-clicking a project button or rapid retries no longer enqueues duplicate
commands. Both layers are guarded:

- **UI layer** (`bot/commands/projects.ts`): checks `getPendingActions()` before
  enqueuing; answers the callback with "Already starting/stopping…" if one is
  already in flight. Also suppresses the Telegram "message is not modified" error
  (content unchanged → no-op instead of delete-and-resend).
- **Service layer** (`services/project-service.ts`): `ProjectService.action()`
  now skips `INSERT` if a matching `pending`/`processing` row already exists.
  `listAll()` uses a `LATERAL` join to surface the most relevant session
  (active preferred, then most-recently-active).

### fix(admin-daemon): kill ALL matching tmux windows to prevent zombie accumulation

`tmux kill-window -t "bots:<name>"` only kills the first matching window — if
multiple windows share the same name (e.g. after a rapid restart), the extras
survive as zombies. Fixed by looping `kill-window` until none remain:

```bash
while tmux kill-window -t "bots:<name>" 2>/dev/null; do :; done
```

Applied to both the `start` path (before re-creating the window) and the `stop`
path. Stop command now prefers `project_id` over name for the session status update.

### fix(tmux-watchdog): visible-only pane capture for permission prompt detection

Permission prompt detection previously used `capturePane()` which includes
scroll-back history. If a dialog had already been answered and scrolled out of
view, the watchdog would re-detect it as active — causing spurious "still active"
false positives.

**Fix:** added `capturePaneVisible()` (no `-S`/`-E` range → current screen only)
and switched permission detection and polling to use it. Dialogs in scroll-back
are already answered and must not trigger re-detection.

Also added a 1 s delay before the first polling iteration so a very fast
auto-approval doesn't make the dialog disappear before the first check, which
previously caused an immediate false "Resolved in terminal" on the first tick.

### fix(tts): language guard after LLM normalization

`normalizeForSpeech` now receives `isRussian` and injects a `Language: Russian /
English. DO NOT translate. Output in <lang> only.` prefix into the user message,
reducing wrong-language normalization.

Additionally, a post-normalization guard checks whether the script ratio changed
(Cyrillic vs Latin). If the normalizer returned text in the wrong language despite
instructions, the bot falls back to the pre-normalization stripped text so the TTS
model always receives input in the correct language.

### feat(docker): Piper TTS directory mounted into container

`docker-compose.yml` now mounts `./piper` as a read-only volume at `/app/piper`
and passes `PIPER_DIR=/app/piper`. The `piper/` directory is added to `.gitignore`
(binary + voice models are not tracked in git).

---

## v1.27.2

### feat(setup): TTS configuration in setup wizard with Piper voice selection

Setup wizard now includes a full TTS configuration block:

- **Provider selection**: auto / Piper / Yandex SpeechKit / Kokoro / OpenAI / Groq / Disable
- **Piper voice multi-select**: choose languages to download (English required); voices downloaded automatically from HuggingFace
  - English: `en_US-lessac-medium` (male)
  - Russian: `ru_RU-irina-medium` (female), `ru_RU-denis-medium` (male)
  - German, Spanish, French available
- **Piper language-aware model selection**: `PIPER_MODEL_EN` / `PIPER_MODEL_RU` env vars; Piper now picks the right model per detected language
- **Yandex SpeechKit**: API key, Folder ID, voice (alena/filipp/jane/omazh/zahar), language
- **Kokoro**: dtype and voice selection
- **OpenAI**: API key

Also:
- `config.ts`: `TTS_PROVIDER` enum extended with `"piper"`, `"openai"`, `"groq"`, `"none"`
- `utils/tts.ts`: language-aware Piper model selection; English auto-mode now tries Piper first before Kokoro

Setup wizard (`bun cli.ts setup`) now includes a full TTS configuration block:

- **Provider selection**: auto / Piper / Yandex SpeechKit / Kokoro / OpenAI / Groq / Disable
- **Piper**: configure custom `PIPER_DIR` and voice model filename
- **Yandex SpeechKit**: API key, Folder ID, voice (alena/filipp/jane/omazh/zahar), language
- **Kokoro**: dtype (q4/q8/fp16/fp32) and voice selection
- **OpenAI**: API key

All settings are written to `.env` automatically.

Also:
- `config.ts`: `TTS_PROVIDER` enum extended with `"piper"`, `"openai"`, `"groq"`, `"none"`
- `utils/tts.ts`: `PIPER_MODEL` now configurable via `PIPER_MODEL` env var; added `none`/`openai`/`groq` provider handling

---

## v1.27.1

### fix(channel): prevent duplicate replies on Stop/Start restart

When a Claude Code process was killed between a successful Telegram send and the
`UPDATE pending_replies SET delivered_at = NOW()` call, the `deliverPendingReplies`
recovery on next startup would resend the already-delivered message — causing
duplicate replies.

**Fix:** `delivered_at` is now set *before* the Telegram send, not after. This
gives at-most-once delivery semantics: if the process dies mid-send, recovery
won't retry (the message may be lost), but it won't send duplicates.

### fix(status): less alarmist response guard message

The 5-minute "no reply" guard message was reworded from "сессия могла упасть
или зависнуть" to "возможно думает над задачей или сессия зависла" — Claude
might simply be running extended thinking, not crashed.

---

## v1.27.0

### Live pane snapshots for all sessions in split-pane mode

Tmux watchdog now captures terminal output for every active session, including
projects running as panes inside a shared tmux window (i.e. `helyx up -s`).

Previously only sessions that had their own dedicated tmux window received
`pane_snapshot` updates — in split-pane mode all projects share window 0
("helyx"), so the watchdog couldn't find them by window name.

**Fix:** watchdog now falls back to matching sessions by `project_path` against
`pane_current_path` from `tmux list-panes -a`. If no window matches by name,
the matching pane (e.g. `0.3`) is used as the tmux target for both pane capture
and permission-prompt interactions.

Also in this release:
- **fix(permissions):** expire all pending permission requests on bot startup
  (previously only requests older than 2 min were expired, leaving orphaned
  pending rows when the bot restarted quickly)
- **fix(callbacks):** `.catch(() => {})` on `answerCallbackQuery` /
  `editMessageText` to silence "query is too old" errors after restart

---

## v1.26.0

### DB as single source of truth for projects

`tmux-projects.json` is removed. The `projects` DB table is now the only registry.

- `helyx add` — writes to `projects` table via `psql` (same as `/project_add` in bot)
- `helyx up` / `helyx ps` / `helyx remove` — all read from DB
- `/project_add` in bot — unchanged, already wrote to DB
- Adding a project via bot now automatically shows up in `helyx up` without any manual JSON editing

This eliminates the dual-registry problem where projects added via `/project_add` (bot) were invisible to `helyx up` (CLI).

---

## v1.25.0

### Process Monitor — Dashboard & WebApp

Process health dashboard now available in both the web dashboard and the Telegram WebApp.

#### Web dashboard (`/monitor` page)

New sidebar page (Monitor → `Activity` icon) with three sections:
- **admin-daemon** — PID, uptime, stale heartbeat warning (>90 s), `🔄 Restart daemon` button
- **Docker containers** — per-container status from `docker ps`, `🔄 Restart bot` button for the bot container
- **tmux sessions** — active session count from DB

Auto-refreshes every 15 s; restart buttons optimistically queue `admin_commands` and re-poll after a brief delay.

#### Telegram WebApp (`🖥 Procs` tab)

New fifth tab in the WebApp bottom nav, styled with Telegram CSS variables. Shows the same three sections (admin-daemon, Docker, tmux sessions) with restart buttons. Available even when no session is selected (host-level view).

#### API

- `GET /api/process-health` — returns `process_health` rows + active session count
- `POST /api/process-health/restart-daemon` — queues `restart_admin_daemon` admin command
- `POST /api/process-health/restart-docker` — queues `docker_restart {container}` admin command

#### Files

- `dashboard/src/pages/Monitor.tsx` — new dashboard page
- `dashboard/webapp/src/components/ProcessHealth.tsx` — new WebApp component
- `mcp/dashboard-api.ts` — `handleGetProcessHealth`, `handleProcessAction` handlers
- `dashboard/src/api/client.ts` — `ProcessHealthRow`, `ProcessHealthResponse` types + API methods
- `dashboard/webapp/src/api.ts` — `processHealth`, `restartDaemon`, `restartDockerContainer` methods
- `dashboard/src/i18n.ts` — `nav.monitor` translations (EN/RU)

---

## v1.24.0

### tmux Watchdog — Session Health Monitoring & External MCP Permissions

Host-side watchdog that polls active Claude Code sessions every 5 s and routes problems to Telegram with actionable buttons.

#### Permission routing for external MCP tools

Claude Code's built-in `permission_request` channel only covers native tools (Bash, Edit, Read). External MCP tools (docker, github, etc.) show an interactive dialog in the terminal. The watchdog intercepts these and routes them to Telegram with the same **✅ Yes / ✅ Always / ❌ No** buttons. User response is fed back via `tmux send-keys`. The **Always** action writes the tool to `settings.local.json` for permanent auto-approval.

#### Stall detection

Detects when a session shows a spinner but `last_active` hasn't been updated for 2.5+ min — the definitive signal of a hung MCP transport. Alert includes **[⚡ Interrupt]** button that sends `Escape` + auto-confirms the interrupt prompt. Cooldown: 10 min.

#### Editor detection

Detects vim/nano opened in the pane (e.g. from `git commit` without `-m`). Alert includes **[📝 Force close]** button that sends `:q!` `Enter`. Cooldown: 5 min, resets when editor closes.

#### Credential prompt detection

Detects `Password:`, passphrase, or git https Username prompts blocking the session. Informational alert. Cooldown: 5 min.

#### Crash / restart detection

Detects `[run-cli] Exited with code N` from the auto-restart wrapper. Informational alert; `run-cli.sh` restarts automatically. Cooldown: 3 min.

#### Architecture

- `scripts/tmux-watchdog.ts` — replaces `tmux-permission-watcher.ts`; all detectors in one file
- `scripts/admin-daemon.ts` — starts the watchdog; adds `tmux_send_keys` command handler
- `bot/commands/tmux-actions.ts` — new `tmux:ACTION:PROJECT` callback handler
- `bot/callbacks.ts` — registers `tmux:` prefix
- `memory/db.ts` — migration v16: `tmux_target TEXT` column on `permission_requests`
- `docs/tmux-watchdog.md` — architecture and detector reference
- `tests/unit/tmux-watchdog.test.ts` — 64 unit tests for all pure detection functions

Only windows with `status = 'active'` DB sessions are polled; idle projects are skipped entirely.

#### Telegram timeout fix (v1.23.x backport)

- `channel/telegram.ts` — `FETCH_TIMEOUT_MS = 10 s` + `MAX_TOTAL_MS = 60 s` total deadline on all Telegram API calls; prevents infinite hang on network stall (root cause of 37-min session freezes)
- `channel/permissions.ts` — fast-fail auto-deny when `sendTelegramMessage` fails instead of silently polling for 10 min

---

## v1.23.0

### Admin Daemon Auto-Start

- **`helyx up` now starts admin-daemon** — `ensureAdminDaemon()` is called after tmux windows are launched; checks `pgrep` and spawns `admin-daemon.ts` in background if not running. Applies to both fresh start and "already running" branches.
- **`helyx setup` installs systemd service** — copies `scripts/helyx.service` to `/etc/systemd/system/helyx@USER.service` and enables it so `helyx up` + admin-daemon auto-start on boot. Gracefully skips with manual instructions if sudo is unavailable.
- **`/projects` ▶️ Start button now works out of the box** — previously required admin-daemon to be started manually; now guaranteed to be running after any `helyx up`.

## v1.22.0

### UX Improvements

- **Voice to disconnected topic** — early exit before Whisper transcription; user sees a clear error with `/standalone` hint instead of a silent failure
- **Better "session not active" message** — shows project path, explains auto-reconnect, links to `/standalone` and `/sessions`
- **Typing indicator refresh** — typing action re-sent every 4s during long responses; correctly targets forum topic via `message_thread_id`
- **Queue depth feedback** — "⏳ In queue (#N)..." message when a request is waiting behind another in the per-topic queue
- **`/quickstart` command** — 5-step onboarding guide: forum group → project add → Claude Code launch
- **Session crash notifications** — forum topic receives a message when a session terminates unexpectedly
- **`escapeHtml()` utility** — shared in `bot/format.ts`; all user-supplied strings in HTML messages are now properly escaped
- **N+1 SQL eliminated** in `sessions/manager.ts` — `project_path` merged into existing SELECTs in `disconnect()` and `markStale()`

## v1.21.0

### Interactive Polls

Claude can ask clarifying questions as native Telegram polls (`send_poll` MCP tool). You tap answers, press **Submit ✅**, and results flow back automatically as a user message. Supports forum topic routing, 24h expiry, and vote retraction. See [Interactive Polls guide](guides/polls.md).

### Read Receipts

👀 reaction when the bot receives your message, ⚡ when Claude Code picks it up and starts working.

### Codex Code Review

OpenAI Codex CLI integration for AI-powered code review. Authenticate headlessly via `/codex_setup` (device flow, no terminal needed). Trigger via `/codex_review` or natural language. Falls back silently to Claude's native review on quota or auth errors. See [Codex Review guide](guides/codex.md).

### `/forum_clean` command

Scans all projects with a `forum_topic_id`, validates each against the Telegram API, and nulls out IDs that correspond to deleted topics. Run `/forum_sync` afterward to recreate missing topics.

## v1.20.0

### Forum Topics — One Topic Per Project

The primary UX model is now a **Telegram Forum Supergroup** where each project has a dedicated topic:

- `/forum_setup` — run once in the General topic; bot creates one topic per registered project and stores the group ID in `bot_config`
- `/project_add` — automatically creates a forum topic for the new project when forum is configured
- **Message routing** — `sessions/router.ts` resolves `message_thread_id` → project → active session; General topic (thread ID = 1) is control-only
- **Status messages** — `StatusManager` in `channel/status.ts` sends all status updates to the project topic; project name prefix suppressed (the topic already identifies the project)
- **Permission requests** — `PermissionHandler` in `channel/permissions.ts` sends Allow/Always/Deny buttons to the correct project topic
- **`reply` and `update_status` MCP tools** — automatically include `message_thread_id` when called from a forum session
- **Forum cache** — `bot/forum-cache.ts` lazy-loads `forum_chat_id` from DB with invalidation on setup/sync
- **DB migration v13** — `forum_topic_id INTEGER` column on `projects`, `bot_config` table for runtime settings
- **34 new unit tests** — `tests/unit/forum-topics.test.ts` covers routing logic, icon color rotation, `replyInThread`, StatusManager forum target, PermissionHandler forum target, migration schema shape
- **Backward compatible** — if `/forum_setup` was never run, the bot operates in DM mode unchanged

## v1.19.0

### Lease-Based Session Ownership
Replaced `pg_advisory_lock` with a `lease_owner` + `lease_expires_at` column in the `sessions` table (migration v12). The lease is renewed every 60 seconds; if the channel process crashes, the lease auto-expires after 3 minutes and another process can take over. Eliminates orphaned locks and connection-scope issues from PostgreSQL pool reconnects.

### Session State Machine
`sessions/state-machine.ts` defines valid status transitions and enforces them atomically. Invalid transitions (e.g., `terminated → active`) are blocked with a warning log. All disconnects in `sessions/manager.ts` and `channel/session.ts` now route through `transitionSession()`.

### File Intent Prompt

Files and photos received without a caption now trigger a prompt: `📎 filename saved. What should I do with it?`. The bot waits up to 5 minutes for the user's reply, then forwards the file to Claude with that text as the caption. Files with a caption still forward immediately.

### MessageService & SummarizationService
`services/message-service.ts` and `services/summarization-service.ts` wrap short-term memory and summarizer functions with a clean typed API, including `queue()` with attachments support and `pendingCount()`.

### Centralized Telegram API Client
`channel/telegram.ts` now exposes a unified `telegramRequest()` with automatic retry on 429 (respects `retry_after`) and 5xx errors (3 retries with backoff). All tool calls and status updates route through it.

### Cleanup Jobs with Dry-Run
`cleanup/jobs.ts` exposes `runAllCleanupJobs(dryRun)` with per-job row counts. `handleCleanup` in the bot and `helyx cleanup --dry-run` in the CLI use it to preview or apply cleanup.

### Security Fail-Fast
Bot exits immediately at startup if `ALLOWED_USERS` is empty and `ALLOW_ALL_USERS=true` is not set. No silent open-access deployments.

### Anthropic CLI Usage Tracking

Claude Code (Anthropic) model usage is now visible in the dashboard Stats page and the Telegram Mini App session monitor. When a CLI session response completes, the token count captured from the tmux/output monitor is recorded in `api_request_stats` with `provider=anthropic` and model from the session's `cli_config`. The "By model" table in both UIs now shows Sonnet/Opus/Haiku usage alongside standalone providers (Google AI, OpenRouter, Ollama).

### Media Forwarding

Photos, documents, and videos forwarded to Claude via MCP channel with structured `attachments` field (`base64` for images ≤5 MB, `path` for larger files). Migration v11 adds `attachments JSONB` to `message_queue`.

## v1.18.0

### Service Layer

`services/` directory introduces typed, testable wrappers over raw SQL for all domain operations. `ProjectService.create()` atomically handles INSERT + remote session registration. `PermissionService.transition()` enforces the state machine — `pending → approved | rejected | expired` — and rejects re-transitions into terminal states.

### Structured Logging (Pino)

All `console.log/error/warn` replaced with Pino structured logging. `logger.ts` exports two loggers: `logger` (stdout) and `channelLogger` (stderr fd 2, safe for MCP stdio). Every log entry carries structured fields (`sessionId`, `chatId`, `messageCount`) — searchable with any JSON log aggregator. Set `LOG_LEVEL=debug` in `.env` for verbose output.

### Channel Adapter — 7 Modules

The `channel.ts` monolith is now `channel/` with focused modules: `session.ts`, `permissions.ts`, `tools.ts`, `status.ts`, `poller.ts`, `telegram.ts`, `index.ts`. Each module owns one concern; the entrypoint wires them together.

### Environment Validation (Zod)

`config.ts` validates all env vars with Zod at startup. Missing required variables produce a clear error and immediate exit instead of a runtime crash on first use. `ALLOWED_USERS` is now required — `ALLOW_ALL_USERS=true` must be set explicitly for open access.

### Unit Test Suite

43 pure unit tests with no DB, no network, no Telegram: `tests/unit/session-lifecycle.test.ts`, `tests/unit/permission-flow.test.ts`, `tests/unit/memory-reconciliation.test.ts`. Run with `bun test tests/unit/` — completes in ~24ms.

## v1.17.0

See [ROADMAP](docs/ROADMAP.md) for earlier version history.

## v1.14.0

### Google AI Provider in Setup Wizard

Re-added Google AI (Gemma 4) as an interactive option in `helyx setup`. The wizard now presents all four supported providers: Anthropic / Google AI / OpenRouter / Ollama. Selecting Google AI prompts for `GOOGLE_AI_API_KEY` and `GOOGLE_AI_MODEL` (default: `gemma-4-31b-it`).

### MCP Tools: react and edit_message in Channel Adapter

Added `react` (set emoji reaction) and `edit_message` (edit a bot message) to the `channel.ts` stdio MCP adapter. Both tools were already available in the HTTP MCP server — now they work in all connection modes.

## v1.13.0

### Telegram Mini App — Claude Dev Hub

A mobile-first WebApp accessible via the **Dev Hub** button in Telegram. Features:
- **Git browser** — file tree, commit log, status, diff viewer
- **Permission manager** — Allow / Deny / Always Allow from mobile
- **Session monitor** — live session status (working/idle/inactive), API stats by model (including Anthropic Claude usage from CLI sessions), token totals with cost estimate, permission history with tool breakdown, recent tool calls

See [Mini App Guide](guides/webapp.md) for full feature description and auth details. Full technical spec: [`dashboard/webapp/SPEC.md`](dashboard/webapp/SPEC.md)

## v1.12.0

### Local Session Management

- **Delete local sessions from Telegram** — `/sessions` now shows `🗑 Delete` inline buttons for local sessions that are not active; clicking deletes all session data and refreshes the list
- **Delete local sessions from dashboard** — Sessions table gains a `Delete` action column; button is visible only for `source=local` + non-active rows; uses `useMutation` with query invalidation
- **`source` field in sessions API** — `GET /api/sessions` and `GET /api/overview` now return `source` (`remote` | `local` | `standalone`); added to `Session` TypeScript interface

### Session Source Refactoring

Three distinct modes now instead of two:

| `CHANNEL_SOURCE` env | Mode | DB behavior |
|---|---|---|
| `remote` | `helyx up` / tmux | One persistent session per project; reattaches on reconnect |
| `local` | `helyx start` | New temporary session each run; work summary on exit |
| _(not set)_ | Plain `claude` | No DB registration (`sessionId = null`), no polling |

Previously, unset `CHANNEL_SOURCE` defaulted to `local`. Now it is a distinct standalone mode that skips DB entirely — preventing phantom sessions when running `claude` without the bot.

### CLI Changes

- **`helyx start`** — no longer invokes `run-cli.sh`; spawns `claude` directly with `CHANNEL_SOURCE=local` (simpler path, no auto-restart loop for local sessions)
- **`helyx restart`** — after rebuild, syncs `TELEGRAM_BOT_TOKEN` from `.env` into `~/.claude.json` MCP server config (`syncChannelToken`), so channel auth stays in sync without manual edits
- **`run()` helper** — new `stream: true` option pipes stdout/stderr directly to terminal (used in restart for real-time build output)

## v1.11.0

### Dashboard Project Management
- **Projects page** — create, start, and stop projects directly from the web dashboard (previously Telegram-only)
- **SSE notifications** — `GET /api/events` streams `session-state` events to dashboard via Server-Sent Events
- **Browser notifications** — dashboard requests Notification permission and shows push notifications on session state changes
- **Projects API** — `GET/POST /api/projects`, `POST /api/projects/:id/start|stop`, `DELETE /api/projects/:id`

### Memory TTL per Type
- **Per-type retention** — each memory type has its own TTL: `fact` 90d, `summary` 60d, `decision` 180d, `note` 30d, `project_context` 180d
- **Hourly cleanup** — expired memories deleted automatically based on `created_at`
- **Configurable** — override via `MEMORY_TTL_FACT_DAYS`, `MEMORY_TTL_SUMMARY_DAYS`, etc.
- **DB migration v9** — `archived_at` column + partial index on `memories` table

## v1.10.0

### Smart Memory Reconciliation
- **LLM deduplication** — `/remember` and work summaries no longer blindly insert; similar memories are found via vector search, then `claude-haiku` decides ADD / UPDATE / DELETE / NOOP
- **Updated replies** — `/remember` now shows `Saved (#N)` / `Updated #N` / `Already known (#N)` based on what actually happened
- **project_context deduplication** — session exit summaries update existing project context instead of accumulating duplicates
- **Graceful fallback** — Ollama or Claude API unavailable → falls back to plain insert, no data loss
- **New config** — `MEMORY_SIMILARITY_THRESHOLD` (default `0.35`) and `MEMORY_RECONCILE_TOP_K` (default `5`)

## v1.9.0

### Session Management Redesign
- **Persistent Projects** — `projects` DB table, `/project_add` saves to DB (not JSON file)
- **Remote/Local Sessions** — one remote session per project (persistent), multiple local (temporary per process)
- **Work Summary on Exit** — local session exit triggers AI summary of work done ([DECISIONS][FILES][PROBLEMS][PENDING][CONTEXT]), vectorized to long-term memory
- **Session Switch Briefing** — switching sessions shows last project context summary, injected as system context
- **Semantic Search** — `search_project_context` MCP tool + `search_context` command
- **Archival TTL** — messages and permission_requests archived on summarize, deleted after `ARCHIVE_TTL_DAYS` (default 30)
- **Status vocab** — `active | inactive | terminated` (was `active | disconnected`)
- **DB migrations v6-v8** — projects table, archived_at columns, project_id FK, unique remote-per-project

## v1.8.0

### Skills & Commands Integration
- **`/skills`** — Interactive skill browser with inline buttons (reads from `~/.claude/skills/`)
- **`/commands`** — Custom command launcher (reads from `~/.claude/commands/`)
- **`/hooks`** — View configured Hookify rules
- **Deferred input** — Tools requiring args prompt user then enqueue
- **Icon support** — 38+ emojis for quick visual identification

### Session Management Commands
- **`/add`** — Register project as Claude Code session (prompts for path, auto-switches)
- **`/model`** — Select Claude model via inline buttons (stored in `cli_config.model`)
- **Adapter pattern** — `adapters/ClaudeAdapter` (message_queue), extensible registry
- **Session router** — `sessions/router.ts` typed routing: standalone / cli / disconnected

### CLI Refactoring
- **`start [dir]`** — Register + launch project in current terminal (replaces old start = docker-only)
- **`docker-start`** — New command for `docker compose up -d` (old `start` behavior)
- **`add [dir]`** — Now registration-only (saves to config + bot DB, no launch)
- **`run [dir]`** — New command to launch registered project in terminal
- **`attach [dir]`** — New command to add window to running tmux `bots` session
- **tmux session renamed** — `claude` → `bots` (hosts both claude and opencode windows)

### Database Improvements
- **JSONB normalization** — Safe PostgreSQL storage with explicit casting
- **Read-merge-write** — Concurrent-safe provider config updates
