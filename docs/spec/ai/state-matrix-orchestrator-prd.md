# PRD: State Matrix Orchestrator for Helyx

**Status:** Draft  
**Owner:** Helyx  
**Created:** 2026-05-04  
**Target:** Helyx feature branch `feature/state-matrix-orchestrator-prd`

## 1. Summary

State Matrix Orchestrator adds a deterministic validation layer to Helyx so that AI-generated outputs are checked against project-specific rules before they are accepted, sent to the user, or allowed to execute as tool actions.

The feature must preserve Helyx's existing execution model:

- In CLI mode, Claude Code remains the active agent runtime. Helyx does not directly call Claude for every turn. Helyx routes Telegram messages through `message_queue`, receives Claude's final output through MCP tools such as `reply`, and receives permission requests through the channel permission flow.
- In standalone mode, Helyx already owns the LLM call through `generateResponse` / streaming APIs and can run a direct generate-validate-correct loop.

The orchestrator is therefore not a replacement for Claude Code. It is a project-scoped policy and validation layer around Helyx's existing message, status, permission, memory, and skills systems.

## 2. Problem

Today Helyx can route work to Claude Code and provide excellent visibility through status messages, tmux monitoring, permissions, and memory. However, it does not have a deterministic gate that can reject AI outputs that violate project-specific architectural constraints.

Examples of failures this feature should prevent or control:

- Claude proposes or performs a file edit outside allowed project paths.
- Claude requests a dangerous command such as a Docker restart without explicit user confirmation.
- Claude sends a final answer claiming work is complete while required verification has not happened.
- Claude produces JSON/config output that is structurally invalid.
- Claude ignores project conventions that are known and enforceable.

Prompting alone is not sufficient because the model can forget or reinterpret instructions. A deterministic validation layer is needed.

## 3. Goals

- Add a project-scoped State Matrix file that defines deterministic validation rules.
- Validate final replies before they are sent to Telegram.
- Validate tool and permission requests before they are approved or shown as normal user actions.
- Support automatic self-correction loops up to a configured maximum attempt count.
- Keep the user informed through the existing status message lifecycle.
- Keep raw validation errors out of Telegram when automatic correction succeeds.
- Persist orchestration state so long-running correction loops survive restarts and permission waits.
- Integrate `goodai-base` as an optional knowledge source for skills and rules without treating prompt-only skills as validation authority.

## 4. Non-Goals

- Do not replace Claude Code as the CLI-mode runtime.
- Do not make the validator an LLM judge.
- Do not auto-fix artifacts inside the validator.
- Do not bypass existing Telegram permission buttons.
- Do not restart Docker containers or services automatically.
- Do not require all projects to adopt State Matrix on day one.
- Do not copy all of `goodai-base` into the Helyx repository.

## 5. Concepts

### 5.1 State Matrix

The State Matrix is a deterministic project policy file, stored in the project root by default:

```text
<project>/.matrix.json
```

It defines what artifacts are allowed, blocked, required, or conditionally accepted.

### 5.2 Artifact

An artifact is any model-produced object that can affect user-visible state or project state.

Initial artifact types:

- `reply`: final text sent to the user.
- `tool_request`: Bash/Edit/Write/Read/Grep permission request.
- `file_patch`: proposed or previewed file change.
- `json`: structured output that must satisfy a schema.
- `plan`: implementation or execution plan.

### 5.3 Matrix Validator

The validator is a deterministic judge. It only reads an artifact and returns typed violations. It never edits files, rewrites commands, repairs JSON, or decides based on model preference.

### 5.4 Self-Correction Loop

When validation fails, Helyx returns a correction prompt to the active model context. The model must regenerate or revise the artifact. The loop stops when the artifact is valid, the attempt limit is reached, or user permission is required.

### 5.5 Skills and Rules

Skills and rules from `goodai-base` improve generation quality. They may be referenced by the matrix, injected as context, or used to select workflows. They cannot mark an artifact valid. Only deterministic validators can do that.

## 6. Existing Helyx Architecture Constraints

The design must fit these existing Helyx flows:

- Telegram text enters through `bot/text-handler.ts`.
- CLI mode routes messages into `message_queue`.
- `channel/poller.ts` delivers queue rows to Claude Code via MCP notification.
- Claude Code sends final output through `reply` in `channel/tools.ts`.
- Claude Code emits permission requests handled by `channel/permissions.ts`.
- `StatusManager` in `channel/status.ts` owns live status messages, response guard, tmux/output snapshots, recovery heartbeats, and completion summaries.
- Standalone mode uses `composePrompt`, `streamToTelegram`, and `claude/client.ts`.
- Memory and project context are persisted through the existing memory subsystem.

The orchestrator must work with these boundaries instead of introducing a competing message runtime.

## 7. Proposed Architecture

```text
User Message
  -> Helyx Router
    -> CLI Mode
      -> message_queue
      -> Claude Code
      -> MCP reply/tool_request
      -> State Matrix Gate
        -> valid: send/apply/ask permission
        -> invalid: correction prompt back to message_queue

    -> Standalone Mode
      -> generateResponse
      -> State Matrix Gate
        -> valid: stream/send final response
        -> invalid: generate correction attempt
```

## 8. Components

### 8.1 Matrix Loader

Responsibilities:

- Resolve the matrix path for a project.
- Load `.matrix.json`.
- Validate the matrix file against Helyx's matrix schema.
- Cache matrix content by project path and matrix hash.
- Support missing matrix behavior.

Missing matrix behavior:

- Default MVP behavior: `disabled`.
- Optional future modes: `warn`, `global-default`, `strict-required`.

### 8.2 Matrix Schema Validator

Validates the matrix file itself before it can be used.

Example matrix:

```json
{
  "version": 1,
  "mode": "auto_correct",
  "maxCorrectionAttempts": 5,
  "paths": {
    "allowed": ["src/**", "tests/**", "docs/**"],
    "forbidden": [".env", "node_modules/**", "dist/**"]
  },
  "commands": {
    "forbidden": ["rm -rf", "docker compose down"],
    "requiresExplicitConfirmation": [
      "docker compose restart",
      "docker compose up",
      "docker compose down"
    ]
  },
  "replies": {
    "requireVerificationForCodeTasks": true,
    "forbidRawValidationErrors": true
  },
  "skills": {
    "source": "goodai-base",
    "preferred": ["context-collector", "code-verifier", "prd-creator"],
    "rules": ["git-rules", "security-baseline"]
  }
}
```

### 8.3 Artifact Normalizer

Converts Helyx events into a common validation shape.

Examples:

```ts
type MatrixArtifact =
  | { type: "reply"; text: string; sessionId: number; projectPath: string }
  | { type: "tool_request"; tool: string; input: Record<string, unknown>; projectPath: string }
  | { type: "file_patch"; path: string; diff: string; projectPath: string }
  | { type: "json"; schemaId: string; value: unknown; projectPath: string };
```

### 8.4 Validators

Initial validator set:

- `PathValidator`: allowed paths, forbidden paths, project-root containment.
- `CommandValidator`: forbidden commands, confirmation-required commands, command allowlist.
- `ReplyValidator`: empty reply, raw validation leakage, required verification summary.
- `JsonSchemaValidator`: validates structured outputs against schemas referenced by the matrix.
- `PermissionValidator`: validates permission requests before user approval flow proceeds.

Future validators:

- `GitDiffValidator`: requires tests for source changes.
- `DependencyValidator`: blocks package manager changes unless allowed.
- `SecretValidator`: blocks accidental secret exposure.
- `StatusValidator`: ensures long-running loops update status heartbeat.

### 8.5 Correction Prompt Builder

Turns typed violations into a model-facing correction message.

Requirements:

- Include enough detail for Claude to correct the artifact.
- Avoid leaking sensitive values.
- Avoid sending raw validator internals to Telegram.
- Include attempt count and max attempts.
- Include the relevant matrix rules or rule IDs.

Example:

```text
State Matrix validation failed.
Attempt: 2/5.

Violations:
- COMMAND_REQUIRES_CONFIRMATION: docker compose restart requires explicit user confirmation.

Revise your next action so it complies with the State Matrix. Do not ask Helyx to execute the blocked command unless the user explicitly confirms it.
```

### 8.6 Orchestration Run Store

Persist orchestration state in PostgreSQL.

Suggested tables:

- `orchestration_runs`
- `orchestration_attempts`
- `matrix_violations`

Minimum fields:

- `id`
- `session_id`
- `chat_id`
- `thread_id`
- `project_path`
- `matrix_hash`
- `status`
- `phase`
- `attempt`
- `max_attempts`
- `created_at`
- `updated_at`
- `completed_at`

Statuses:

- `running`
- `validating`
- `correcting`
- `waiting_permission`
- `valid`
- `failed`
- `cancelled`

### 8.7 Status Integration

The orchestrator must use the existing `StatusManager` as the user-visible progress layer.

Status phases:

```text
Thinking
Validating output
Matrix violation detected, correcting attempt 1/5
Re-validating corrected output
Waiting for permission
Finalizing
Done
Failed validation after 5 attempts
```

Rules:

- Do not delete the active status when validation fails.
- Keep response guard active during validation and correction.
- Reset response guard whenever validation, correction, permission, or model activity occurs.
- Show sanitized progress in Telegram.
- Store detailed violations in DB/logs.
- On success, close the status with the existing summary behavior.

## 9. CLI Mode Behavior

### 9.1 Final Reply Gate

Current behavior:

```text
Claude Code -> reply tool -> Telegram
```

Target behavior:

```text
Claude Code -> reply tool -> MatrixValidator
  -> valid -> Telegram
  -> invalid -> correction prompt -> message_queue -> Claude Code
```

Acceptance rule:

- In matrix-enabled sessions, no final `reply` is sent to Telegram until `ReplyValidator` passes or the run fails visibly.

### 9.2 Tool and Permission Gate

Current behavior:

```text
Claude Code -> permission_request -> Telegram inline buttons
```

Target behavior:

```text
Claude Code -> permission_request -> MatrixValidator
  -> valid and requires user decision -> Telegram inline buttons
  -> valid and auto-approved by existing rules -> allow
  -> invalid but correctable -> correction prompt
  -> invalid and user decision required -> explicit user checkpoint
```

Examples:

- `Edit` on `src/foo.ts`: allowed.
- `Write` to `.env`: blocked.
- `docker compose restart`: requires explicit user confirmation.
- `rm -rf`: blocked.

### 9.3 Correction Delivery

In CLI mode, correction messages are delivered through `message_queue` as channel system messages.

Requirements:

- Preserve original chat/session metadata.
- Mark correction messages so they do not look like ordinary user messages.
- Avoid message deduplication conflicts with Telegram `message_id`.
- Ensure correction messages do not recursively trigger unrelated user UX such as reactions.

## 10. Standalone Mode Behavior

Standalone mode can use a direct loop:

```text
composePrompt -> generateResponse -> validate -> correction prompt -> generateResponse
```

Requirements:

- Prefer non-streaming generation while validation is active, because streaming invalid text to Telegram would violate the gate.
- Only stream/send the final response after validation passes.
- If matrix is disabled, keep current standalone streaming behavior.

## 11. Validation Basis

Validation is based on four inputs:

1. Project matrix from `.matrix.json`.
2. Artifact type and normalized artifact payload.
3. Helyx project/session context.
4. Global Helyx safety policies.

The validator must not ask an LLM whether an artifact is valid.

Examples of deterministic checks:

- Glob path match.
- JSON schema validation.
- Command pattern match.
- Required field presence.
- Confirmation-required command classification.
- Reply text constraints.
- Project-root containment.

## 12. goodai-base Integration

Helyx should use `goodai-base` as an external knowledge source.

Configuration:

```text
GOODAI_BASE_PATH=/Users/tsaitler.aleksandr/goodea/goodai-base
```

Capabilities:

- Load `GOODAI_BASE_PATH/rules.json`.
- Load `GOODAI_BASE_PATH/skills/<name>/SKILL.md`.
- Load `GOODAI_BASE_PATH/rules/core/<name>.mdc`.
- Inject matched skill/rule hints into Claude turns.
- Allow `.matrix.json` to reference skill IDs and rule IDs.
- Store `goodai-base` version/hash with the orchestration run.

Constraints:

- Do not copy all `goodai-base` content into Helyx.
- Do not treat skills as deterministic validation.
- Do not let missing `goodai-base` break matrix validation unless the matrix explicitly requires it.

## 13. User Experience

### 13.1 Normal Success

User sees:

```text
Thinking...
Validating output...
Finalizing...
Done summary
```

Then the final reply.

### 13.2 Auto-Correction

User sees:

```text
Thinking...
Validating output...
Matrix violation detected, correcting attempt 1/5...
Re-validating corrected output...
Finalizing...
```

User does not see raw violations if correction succeeds.

### 13.3 Permission Required

User sees the existing inline permission UI. The status should show:

```text
Waiting for permission...
```

If the permission request violates the matrix, the user should not see a normal approval prompt unless explicit user confirmation is the required policy.

### 13.4 Failed Convergence

After max attempts:

```text
Unable to produce a matrix-valid result after 5 attempts.
Action needed: review constraints or clarify the task.
```

Detailed violations are available in logs or dashboard, not dumped raw into Telegram by default.

## 14. Security and Safety

- Matrix validation must fail closed for protected paths and dangerous commands.
- Missing or invalid matrix should disable matrix mode or enter configured fail-closed mode; it must not silently apply partial rules.
- Command matching must avoid naive substring-only behavior for high-risk commands.
- The validator must never auto-approve destructive actions.
- Permission waits must pause the correction loop.
- Docker/service restart actions require explicit user confirmation.
- Raw secrets must not appear in correction prompts, logs, or Telegram statuses.

## 15. Observability

Add structured logs for:

- matrix loaded
- matrix load failed
- artifact validation started
- artifact validation passed
- artifact validation failed
- correction attempt started
- correction exhausted
- permission blocked by matrix

Dashboard/API future visibility:

- current orchestration runs
- violations by project
- average correction attempts
- top failing matrix rules
- failed convergence events

## 16. Testing Strategy

### Unit Tests

- Matrix schema validation.
- Path allow/deny rules.
- Command allow/deny/confirmation rules.
- Reply validation rules.
- Correction prompt redaction.
- Missing matrix behavior.
- Invalid matrix behavior.

### Integration Tests

- CLI `reply` is blocked when invalid and sent when valid.
- CLI invalid permission request returns correction instead of approval prompt.
- Standalone mode retries until valid.
- Status remains active during correction.
- Response guard does not fire during active correction updates.
- Orchestration run persists attempt state.

### Regression Tests

- Existing non-matrix projects behave unchanged.
- Existing permission buttons still work.
- Existing status completion summary still works.
- Existing message deduplication is not broken by correction prompts.

## 17. Rollout Plan

### Phase 1: PRD and Design

- Land this PRD.
- Review architecture and matrix schema.
- Decide default missing-matrix behavior.

### Phase 2: Read-Only Matrix Foundation

- Implement MatrixLoader.
- Implement schema validation.
- Add command/path/reply validators.
- Add tests.
- No blocking behavior yet; log-only mode.

### Phase 3: CLI Reply Gate

- Gate `reply` in `channel/tools.ts`.
- Add correction prompt delivery through `message_queue`.
- Integrate status phases.
- Add persistence for orchestration runs.

### Phase 4: Permission Gate

- Validate permission requests in `channel/permissions.ts`.
- Block or checkpoint unsafe actions.
- Preserve existing inline approval flow.

### Phase 5: Standalone Mode

- Add direct generate-validate-correct loop.
- Disable streaming until validation passes when matrix mode is active.

### Phase 6: goodai-base Integration

- Add configurable `GOODAI_BASE_PATH`.
- Load skill/rule registry from configured path.
- Allow matrix references to skill/rule IDs.
- Store registry version/hash per run.

### Phase 7: Dashboard and Metrics

- Surface orchestration runs and validation failures.
- Add per-project matrix status.

## 18. Definition of Done

- Matrix-enabled projects can block invalid final replies.
- Matrix-enabled projects can block invalid tool/permission requests.
- Auto-correction runs up to the configured attempt limit.
- Status messages clearly show validation and correction progress.
- Raw validation details are stored for diagnostics but not shown to the user on successful correction.
- Existing non-matrix behavior is unchanged.
- Tests cover validators, correction flow, status behavior, and permission gating.
- Documentation explains matrix format, limitations, and rollout mode.

## 19. Open Questions

- Should missing `.matrix.json` default to disabled or inherit a global Helyx matrix?
- Should matrix mode be configured per project in DB, in `.matrix.json`, or both?
- How should Helyx distinguish a final answer from an intermediate `reply` such as "I will start now"?
- Should correction prompts be hidden from normal session history or stored as system messages?
- How strict should reply validation be for discussion-only tasks?
- Should matrix violations be visible in the dashboard before they are exposed in Telegram?
- Which `goodai-base` rules should be first-class matrix references?
