# PRD: Telegram Bot Commands for Claude Code Skills, Commands & Hooks

## 1. Overview

Add `/skills`, `/commands`, `/hooks` Telegram bot commands that dynamically fetch available tools from the host via HTTP endpoint and display them with a mixed UI (header + inline buttons with descriptions). When a tool requiring arguments is selected, the bot prompts for input, then dispatches the command to the active Claude session.

---

## 2. Context

- **Product:** @GoodeaAIBot (Telegram bot)
- **Module:** `bot/commands/`, `bot/handlers.ts`, `main.ts` (HTTP endpoint)
- **User Role:** Bot owner (single user)
- **Tech Stack:** Bun + TypeScript, grammY, PostgreSQL, Docker
- **Host paths:** Skills — `~/.claude/skills/`, Commands — `~/.claude/commands/`, Hooks — `~/.claude/settings.json`
- **Bot API:** `http://localhost:3847`

---

## 3. Problem Statement

The user has accumulated dozens of skills, commands, and hooks in global Claude Code but cannot quickly invoke them from Telegram — requires memorizing names or checking files on the server.

---

## 4. Goals

- Provide `/skills`, `/commands`, `/hooks` as Telegram entry points
- Show live tool list dynamically (no bot restart required)
- Show brief description from frontmatter alongside each button
- Support interactive argument input before invocation
- Dispatch selected command to active Claude session as a user prompt

---

## 5. Non-Goals

- Managing tools (create, delete, edit skills/commands)
- Multi-user support
- Multiple Claude profiles (`~/.claude`)
- Pagination (> 50 tools out of scope)
- Invocation history log

---

## 6. Functional Requirements

**FR-1: Bot Commands**
- `/skills` — lists skills from `~/.claude/skills/`
- `/commands` — lists commands from `~/.claude/commands/`
- `/hooks` — lists hooks from `~/.claude/settings.json` (hooks section)

**FR-2: Host HTTP Endpoint**
- `GET /api/tools/skills` → `[{ name, description, requiresArgs }]`
- `GET /api/tools/commands` → `[{ name, description, requiresArgs }]`
- `GET /api/tools/hooks` → `[{ event, matcher, command }]`
- Parses frontmatter from `.md` / `SKILL.md` files
- Determines `requiresArgs`: if file has `## Arguments` section or `args:` in frontmatter → `true`; otherwise fallback to hardcoded no-args list (`commit`, `push`, `clean-gone`, `hookify-list`, `hookify-configure`)

**FR-3: Mixed UI**
- Message = category header + inline buttons
- Each button: `<name> — <description (≤60 chars)>`
- Layout: 1 button per row for readability

**FR-4: No-args Invocation**
- If `requiresArgs = false` → bot immediately enqueues `/<name>` to active Claude session via `message_queue`

**FR-5: Args-required Invocation**
- If `requiresArgs = true` → bot replies: `Enter arguments for /<name>:`
- Next user message is treated as arguments
- Bot enqueues `/<name> <arguments>` to active session
- Argument wait timeout: 5 minutes (then reset)

**FR-6: Dynamic Fetching**
- Every `/skills`, `/commands`, `/hooks` call fetches fresh list from endpoint (no cache)

---

## 7. Non-Functional Requirements

**NFR-1:** Endpoint responds in < 500 ms  
**NFR-2:** If endpoint unavailable — bot replies with clear error, does not crash  
**NFR-3:** Inline button `callback_data` ≤ 64 bytes (Telegram limit)  
**NFR-4:** "Awaiting args" state stored in-memory (Map), not in DB  

---

## 8. Constraints

- Bot runs in Docker; host accessible via `host.docker.internal` or direct port binding
- HTTP endpoint added to existing `main.ts` (Hono/Bun)
- Frontmatter parsing: `gray-matter` library or manual regex
- `callback_data` format: `skill:<name>` / `cmd:<name>` / `hook:<index>` (≤ 64 bytes)

---

## 9. Edge Cases

- Skill/command name > 30 chars → truncate in button label
- `requiresArgs` undetermined (no section, not in fallback list) → default `true` (safe fallback)
- No active session (standalone mode) → show warning before invocation
- User presses button, then sends another message before entering args → cancel wait, process new message as normal prompt
- No hooks in `settings.json` → reply "No hooks configured"

---

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Telegram commands for Claude Code tools

  Scenario: View skills list
    Given user is authenticated in the bot
    When user sends /skills
    Then bot calls GET /api/tools/skills
    And displays header "⚡ Skills"
    And shows inline buttons, one per row
    And each button contains name and description ≤ 60 chars

  Scenario: Invoke no-args skill
    Given skills list is displayed
    When user taps button "commit — Create a git commit"
    And requiresArgs = false for "commit"
    Then bot enqueues "/commit" to active Claude session via message_queue

  Scenario: Invoke args-required skill
    Given skills list is displayed
    When user taps button "hookify — Creates Claude Code hooks..."
    And requiresArgs = true for "hookify"
    Then bot replies "Enter arguments for /hookify:"
    When user sends "block commits without tests"
    Then bot enqueues "/hookify block commits without tests" to active session

  Scenario: Endpoint unavailable
    Given host service is not responding
    When user sends /skills
    Then bot replies "Failed to load list: service unavailable"
    And does not throw unhandled error

  Scenario: Argument wait timeout
    Given bot is waiting for arguments for /hookify
    When 5 minutes pass without user response
    Then bot cancels the wait state
    And next user message is processed as a normal prompt
```

---

## 11. Verification

- **Manual:** Send `/skills`, `/commands`, `/hooks` in Telegram — verify buttons and descriptions render correctly
- **Invocation test:** Tap no-args skill button → verify `message_queue` entry via psql
- **Args flow test:** Tap hookify → enter text → verify `message_queue` contains full command
- **Error test:** Stop bot API → call `/skills` → verify clean error message
- **Observability:** Logs in `bot/` on button invocation — `appendLog(sessionId, chatId, "tools", "invoked /hookify")`
