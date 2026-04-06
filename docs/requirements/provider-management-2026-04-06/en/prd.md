# PRD: Provider Management — /add, /model, /connections

## 1. Overview

Add three Telegram commands for managing AI provider connections per session: `/add` to register a project with a chosen provider, `/model` to view and switch the active model, and `/connections` to list and configure provider API keys.

---

## 2. Context

- **Product:** Claude Bot (Telegram → Claude Code / OpenCode bridge)
- **Module:** `bot/commands/add.ts`, `bot/commands/model.ts`, `bot/commands/connections.ts`
- **Trigger:** Need to support multiple CLI backends (Claude Code + OpenCode) from a single bot
- **Implemented:** commit 0959fae

---

## 3. Problem Statement

The bot originally supported only Claude Code sessions. Adding OpenCode as a second backend introduced the need for:
1. A way to register a project directory with a specific provider
2. A way to switch models without touching config files
3. A way to check and configure provider API key status from Telegram

---

## 4. Goals

- Allow registering a project session with `claude` or `opencode` provider from Telegram
- Allow switching model on-the-fly for both provider types
- Show provider API key status and guide configuration for OpenCode providers
- Keep registration consistent with CLI (`claude-bot add --provider`)

---

## 5. Non-Goals

- Supporting providers beyond `claude` and `opencode`
- Managing multiple API keys per provider
- Storing API keys in bot database (provider secrets live in opencode/claude config)
- Bulk registration of multiple projects

---

## 6. Functional Requirements

### /add

**FR-1:** `/add` sends an inline keyboard with two choices: `[Claude Code] [opencode]`

**FR-2:** If the active session has a `projectPath`, pre-fill it: `Register /path/to/project with which provider?`

**FR-3:** If no active session (standalone mode), prompt user to enter an absolute path after provider selection

**FR-4:** Path validation — must start with `/`, reject relative paths

**FR-5:** On confirmation, call `sessionManager.register()` with:
- `clientId`: `<provider>-<basename>-<timestamp>`
- `name`: `<basename> · <provider>`
- `cliType`: `"claude"` | `"opencode"`
- `cliConfig`: `{}` for claude; `{ port: 4096, autostart: false }` for opencode

**FR-6:** After registration, auto-switch to the new session via `sessionManager.switchSession()`

**FR-7:** Reply with session ID, name, path, and startup instructions:
- Claude Code: `claude --channels "bun /path/to/channel.ts"`
- OpenCode: `opencode serve` (port 4096) and hint to use `/model` for autostart

### /model

**FR-8:** `/model` requires an active CLI session; reply with instructions if standalone/disconnected

**FR-9:** For `claude` sessions — show hardcoded model list from `CLAUDE_MODELS` constant:
```
claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5-20251001,
claude-opus-4-20250514, claude-sonnet-4-20250514
```

**FR-10:** For `opencode` sessions — fetch live model list from `opencodeAdapter.listModels(cliConfig)` (GET `/v1/models` on opencode serve)

**FR-11:** If opencode is not running, reply with error and startup hint instead of crashing

**FR-12:** Show current model with `✓` prefix in button list (max 20 models)

**FR-13:** `set_model:<name>` callback calls `sessionManager.updateCliConfig(sessionId, { model })` and confirms the change

### /connections

**FR-14:** `/connections` only available for `opencode` sessions; for `claude` sessions reply with explanation

**FR-15:** Fetch providers from `opencodeAdapter.listProviders(cliConfig)` (GET `/v1/providers` on opencode serve)

**FR-16:** If opencode is not running, reply with error and startup hint

**FR-17:** Display each provider with status badge: `✅ Anthropic (anthropic)` or `❌ OpenAI (openai)`

**FR-18:** For unconfigured providers, show `[Configure <Name>]` inline button

**FR-19:** `configure_provider:<id>` callback shows instructions: `opencode auth <id>` command

---

## 7. Non-Functional Requirements

**NFR-1:** `/add` must complete registration in < 2s (DB write only, no network calls)

**NFR-2:** `/model` model list fetch from opencode must time out gracefully if opencode is not running

**NFR-3:** `callback_data` format: `add_provider:<type>`, `set_model:<name>`, `configure_provider:<id>` — all ≤ 64 bytes

**NFR-4:** All three commands must work without requiring bot restart

**NFR-5:** `cliConfig` stored as sanitized JSONB — only known safe fields (`port`, `autostart`, `tmuxSession`, `model`)

---

## 8. Constraints

- Provider types limited to `"claude"` and `"opencode"` (validated server-side in `/api/sessions/register`)
- Port for opencode fixed at `4096` (configurable via `cliConfig.port`)
- Model names passed as-is — no validation (opencode API is the source of truth)
- `sessionManager.updateCliConfig()` uses read-merge-write to avoid overwriting other fields

---

## 9. Data Model

### sessions table — relevant fields

| Column | Type | Notes |
|--------|------|-------|
| `cli_type` | varchar | `'claude'` or `'opencode'` |
| `cli_config` | jsonb | `{ port, autostart, tmuxSession, model, opencodeSessionId }` |

---

## 10. Edge Cases

- User taps provider button but session was deleted between command and callback → re-check and report
- `/model` list is empty (opencode running but no models loaded) → show current model + error hint
- Model name > 64 chars → truncate `callback_data` key to stay within Telegram limit
- `/connections` called while opencode is starting up (0 providers) → treat as "not running" error

---

## 11. Acceptance Criteria (Gherkin)

```gherkin
Feature: Provider management commands

  Scenario: Register project with Claude Code
    Given user has no active session
    When user sends /add
    And taps "Claude Code"
    And enters "/home/user/my-project"
    Then bot registers session with cliType=claude
    And switches to the new session
    And replies with Claude Code startup command

  Scenario: Register project with OpenCode from active session
    Given user is in session with projectPath=/home/user/api
    When user sends /add
    And taps "opencode"
    Then bot registers session for /home/user/api with cliType=opencode
    And cliConfig contains { port: 4096, autostart: false }
    And bot switches to new session and shows opencode startup hint

  Scenario: Switch model for Claude session
    Given active session with cliType=claude
    When user sends /model
    Then bot shows inline keyboard with CLAUDE_MODELS list
    And current model has ✓ prefix
    When user taps "claude-sonnet-4-6"
    Then cli_config.model is updated to "claude-sonnet-4-6"

  Scenario: List OpenCode models
    Given active session with cliType=opencode
    And opencode serve is running at :4096
    When user sends /model
    Then bot fetches /v1/models from opencode
    And shows up to 20 models as inline buttons

  Scenario: OpenCode not running for /model
    Given active session with cliType=opencode
    And opencode serve is NOT running
    When user sends /model
    Then bot replies with error and "Start opencode: opencode serve"

  Scenario: View connections for OpenCode session
    Given active session with cliType=opencode and opencode running
    When user sends /connections
    Then bot shows list of providers with ✅/❌ status
    And unconfigured providers have [Configure] button

  Scenario: /connections unavailable for Claude session
    Given active session with cliType=claude
    When user sends /connections
    Then bot replies "/connections is only available for opencode sessions"
```

---

## 12. Related Documents

- `docs/requirements/opencode-integration-2026-04-06/` — PRD for full OpenCode TUI integration
- `docs/requirements/readme-update-2026-04-06/` — Documentation gap analysis
- `adapters/opencode.ts` — `listModels()`, `listProviders()` implementations
- `sessions/manager.ts` — `register()`, `updateCliConfig()`, `switchSession()`
