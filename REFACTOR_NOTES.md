# Agent Runtime — Refactor Notes

Snapshot of the work between **v1.32.0** (Kesha voice kit baseline) and
**v1.45.0** (full Pattern A+B+C orchestrator pipeline). Captured here
because main was reset to v1.32.0 on **2026-04-28** to start the
agent-runtime architecture fresh — every release in this branch is
preserved on origin as a tag, but the PRD direction was sound enough
to merge fast and crooked enough to refactor.

## Releases that landed

| Tag | One-line summary |
|---|---|
| v1.33.0 | Agent runtime baseline (agent_definitions, agent_instances, agent_tasks, agent_events) |
| v1.34.0 | Architecture cleanup |
| v1.34.1 | **CRITICAL** jsonb cast fix (capability routing) + DeepSeek V4 |
| v1.35.0 | Multi-instance tmux + AGENT_INSTANCE_ID env (PRD §17.4) |
| v1.36.0 | Capability test, state recovery sweeps, model_tier override |
| v1.37.0 | **CRITICAL** systemic jsonb cast fix (14 sites) + v32 data migration |
| v1.38.0 | `/agent_create` + `/agent_delete` Telegram commands |
| v1.39.0 | Per-instance prompts + project context injection + topic routing + 12 default templates |
| v1.40.0 | **Pattern B**: orchestrator auto-dispatch |
| v1.41.0 | **Pattern C wiring**: Claude Code system prompt forwarding + 5 execution templates |
| v1.42.0 | **Pattern A**: topic-bound text routing |
| v1.42.1 | Review follow-ups (perf index, defensive guards) |
| v1.42.2 | **CRITICAL** orchestrator recursion guard (post-smoke discovery) |
| v1.43.0 | code-reviewer cc template + topic inheritance via parent chain |
| v1.44.0 | **Pattern C tools**: `take_next_task` / `complete_task` / `fail_task` |
| v1.45.0 | `get_task_result` MCP tool — claude-code reads prior work |

## What the architecture looked like at v1.45.0

Three composable patterns:

```
A (v1.42.0): plain text in forum topic → bot routes to bound agent_instance via forum_topic_id
B (v1.40.0): orchestrator agent emits Decomposition JSON → auto-dispatcher creates subtasks via selectAgent(capabilities)
C (v1.44.0): claude-code agent pulls subtasks via take_next_task MCP tool, completes via complete_task with topic-inheriting result router
```

Combined: text in topic → orchestrator plan → auto-fanout to specialists → specialists complete → results post back to inherited topic.

## Smoked end-to-end (verified)

- Pattern A: text in topic 1157 → instance 550 (review-orchestrator) received task #442 → emitted plan → posted to topic.
- Pattern B + recursion guard: subtasks 443/444 routed to code-reviewer (740), subtask 445 (consolidate, capabilities `[orchestrate,plan]`) correctly excluded from re-routing back to 550 → landed unassigned (no candidate).
- Pattern C: claude-code in instance 740 called `take_next_task` (claimed task 443), processed via Bash/Read/Grep tools, called `complete_task` → result-router walked parent chain → posted findings to topic 1157.

## Pain points / open questions for refactor

These came up live and were not fully resolved before the reset:

1. **Two runtime worlds** (`standalone-llm` vs `claude-code`) require two parallel mechanisms for everything: separate worker, separate context injection, separate task pickup model (poll vs MCP pull). Worth questioning whether the split is essential or if a single unified runtime adapter could simplify.
2. **No autonomous claude-code task pickup**. Pattern C requires the operator (or a `/loop`-like cron) to prompt claude with "use take_next_task". Real autonomy needs a watcher that nudges claude when its pending queue grows — or a runtime that polls on its behalf.
3. **22 agent_definitions seed** (8 specialists + 4 orchestrators + 6 cc execution + 4 generic-default). Operationally heavy to keep prompts tuned. Maybe a smaller curated set or skill-as-data references to goodai-base instead of inline prompts.
4. **systemPromptOverride and forumTopicId on agent_instances** — two add-ons that cover real cases but feel ad-hoc. A typed "instance config" schema with named fields might generalize better.
5. **Auto-dispatcher recursion guard** required two levels of defense (capability exclusion + depth cap) because orchestrator output regularly emitted "consolidate" subtasks with `[orchestrate]` capability. Either the prompt design needs a "terminal" subtask convention or the schema needs a structural marker for non-recursive steps.
6. **Topic inheritance** worked but parent-chain traversal in `getEffectiveForumTopicId` is a hop loop with up to 6 SQL roundtrips per result post. CTE or denormalized `effective_topic_id` could be cleaner.
7. **`get_task_result`** added as a hotfix when the implementer needed prior review content. The pattern of "agent reads prior task to decide next action" probably warrants a structured task-graph view, not ad-hoc per-tool fetches.
8. **No quota / cost guardrails**. Pattern B's recursion guard prevents infinite loops, but a single fan-out with deeply specialized agents could still burn many DeepSeek/Claude tokens unintentionally. Per-orchestrator-task token budget?
9. **No reset/quarantine flow for misbehaving agents**. When the recursion happened in smoke, manual `desired_state=stopped` + DB UPDATE was needed. A `/agent quarantine <id>` command would make incident response cleaner.
10. **Test isolation conflicts with running smoke instances**. Recursion-guard tests had to use RUN_TAG-scoped capabilities to avoid being matched by real orchestrator-capable instances in the DB. Test-DB or fixtures might be cleaner than live-DB integration.

## Code organization at v1.45.0

| Path | Purpose | Pain |
|---|---|---|
| `agents/orchestrator.ts` | Task CRUD, decomposeTask, selectAgent, handleFailure | Big — 800 LOC; `selectAgent` tightly coupled to schema details |
| `agents/agent-manager.ts` | Definition+instance CRUD, state transitions | Reasonable — close to a repository pattern |
| `agents/auto-dispatcher.ts` | Pattern B logic | Defensible single-purpose module |
| `agents/result-router.ts` | Topic post + chain walk | Defensible single-purpose module |
| `agents/context-injector.ts` | Project facts + recent messages → system prompt | Defensible |
| `agents/task-mcp-bridge.ts` | take_next_task / complete_task / fail_task / get_task_result | Defensible |
| `agents/tier-resolver.ts` | per-task model_tier override | Tiny utility, good |
| `runtime/runtime-manager.ts` | Reconciler driving driver.start/stop/health | Mixed responsibility (reconcile + state, would benefit from split) |
| `runtime/drivers/tmux-driver.ts` | Tmux runtime implementation | Solid; multi-instance + sanitization done |
| `runtime/state-recovery.ts` | Startup sweeps for stuck transient states | Tiny utility, good |
| `scripts/standalone-llm-worker.ts` | Per-instance worker process | Well-structured; the runtime-type fork is clean |
| `scripts/admin-daemon.ts` | Host process orchestrating reconciler | Already had a lot of unrelated responsibilities pre-v1.33 |
| `bot/text-handler.ts` | Pattern A entry point | Minimal addition for v1.42.0 |
| `bot/commands/agent-create.ts` | `/agent_create` + `/agent_delete` | Operator UI |
| `bot/commands/agents-catalog.ts` | `/agents_catalog` | Operator UI |
| `channel/tools.ts` | MCP tool registry & dispatch | Big switch — fine for now |

## DB schema changes (migrations v32 → v38)

- v32: parse-back JSONB string-cast bug fix (data migration)
- v33: `agent_instances.system_prompt_override`, `agent_instances.forum_topic_id`
- v34: 8 standalone-llm skill seeds
- v35: 4 standalone-llm orchestrator seeds
- v36: 5 claude-code execution templates
- v37: `idx_agent_instances_forum_topic` (perf)
- v38: 1 claude-code review template

The schema additions are backward-compatible (all new columns nullable, all new tables independent). Reverting the **code** doesn't require reverting the schema — old code just doesn't see the extra columns.

## How to revisit this

```bash
git checkout experiment/agent-runtime-pre-refactor
git log v1.32.0..HEAD --oneline   # 14 squash-merged PRs
git diff v1.32.0..HEAD --stat     # cumulative footprint
```

Each release tag (v1.33.0 through v1.45.0) is independently checkout-able; useful for bisecting which iteration to keep / discard during refactor.

## Recovery context

Main was reset to v1.32.0 on **2026-04-28**. As part of that reset, an
operator running `TRUNCATE agent_events, agent_tasks, agent_instances,
agent_definitions CASCADE` on the live DB caused a cascade through
`projects`, `sessions`, `memories`, `messages`, `chat_sessions`,
`message_queue`, `api_request_stats`, `transcription_stats`,
`request_logs`, `poll_sessions` — all wiped. No backup existed; the
in-repo `scripts/backup-db.sh` was never wired to cron.

**Recovered by hand**:
- 8 `projects` rows from prior conversation knowledge of name/path/forum_topic_id.

**Lost permanently**:
- All `memories` (project facts, decisions accumulated over months).
- All `messages` history.
- Session metadata.

**Lessons baked into the repo afterward** (on main, post-reset):
- `scripts/backup-db.sh` rewritten to use `docker exec` so host
  doesn't need `postgres-client` and an empty `gzip` doesn't claim "OK".
- Cron entry added: `0 3 * * * /home/altsay/bots/helyx/scripts/backup-db.sh`.
- `set -o pipefail` and a min-size sanity check now guard against silent failures.

If a future refactor wants to delete-cascade like this again: use
`DELETE FROM x WHERE …` (respects FKs honestly), OR snapshot first
with `pg_dump` and verify the gz is non-trivial before dropping.
