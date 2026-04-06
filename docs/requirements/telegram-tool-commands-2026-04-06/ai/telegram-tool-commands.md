# PRD: telegram-tool-commands
version: 1.0.0
date: 2026-04-06
status: ready-for-implementation

## SCOPE
feature: telegram-tool-commands
change_type: UI + state logic + integration
modules:
  - bot/commands/tools.ts (NEW)
  - bot/handlers.ts (MODIFY: register commands + callback handler)
  - main.ts (MODIFY: add /api/tools/* endpoints)
  - utils/tools-reader.ts (NEW: frontmatter parser + requiresArgs resolver)

## ENTITIES
- Skill: { name: string, description: string, requiresArgs: boolean }
- Command: { name: string, description: string, requiresArgs: boolean }
- Hook: { event: string, matcher?: string, command: string }
- ToolInvocation: { type: 'skill'|'cmd'|'hook', name: string, args?: string }

## ENDPOINTS (host, main.ts)
GET /api/tools/skills
  response: Skill[]
  source: ~/.claude/skills/*/SKILL.md (parse frontmatter: name, description, user-invocable)
  filter: user-invocable: true OR no field (include all)

GET /api/tools/commands
  response: Command[]
  source: ~/.claude/commands/*.md (parse frontmatter: name, description, allowed-tools)

GET /api/tools/hooks
  response: Hook[]
  source: ~/.claude/settings.json → hooks[event][*]

## requiresArgs RESOLUTION
priority:
  1. frontmatter has `args: none` → false
  2. file body contains `## Arguments` section → true
  3. frontmatter has `args:` with content → true
  4. name in NO_ARGS_LIST → false
  5. default → true (safe fallback)

NO_ARGS_LIST: [commit, push, clean-gone, hookify-list, hookify-configure, hookify-help, pr, changelog, security-audit, perf-check]

## BOT COMMANDS
/skills → handler: showToolsList(ctx, 'skills')
/commands → handler: showToolsList(ctx, 'commands')
/hooks → handler: showToolsList(ctx, 'hooks')

showToolsList(ctx, type):
  1. GET /api/tools/{type}
  2. on error: ctx.reply("Failed to load: service unavailable")
  3. on success: sendMixedUI(ctx, type, items)

sendMixedUI(ctx, type, items):
  text: "{emoji} {Type}\n{count} available"
  reply_markup.inline_keyboard: items.map(item => [{
    text: "{item.name} — {item.description.slice(0,60)}",
    callback_data: "{type_prefix}:{item.name}"  // skill:hookify | cmd:commit
  }])
  layout: 1 button per row

## CALLBACK HANDLER
callback_data patterns:
  skill:<name> → handleToolInvoke(ctx, 'skill', name)
  cmd:<name>   → handleToolInvoke(ctx, 'cmd', name)
  hook:<index> → handleToolInvoke(ctx, 'hook', index)

handleToolInvoke(ctx, type, name):
  1. resolve requiresArgs for (type, name)
  2. if !requiresArgs:
     → enqueueToSession(chatId, "/{name}")
     → ctx.answerCallbackQuery("✅ Sent")
  3. if requiresArgs:
     → ctx.reply("Enter arguments for /{name}:")
     → pendingToolInput.set(chatId, { type, name, expiresAt: now+5min })
     → ctx.answerCallbackQuery()

## PENDING INPUT STATE
storage: Map<chatId, { type: string, name: string, expiresAt: number }>
location: bot/handlers.ts (alongside existing pendingInput Map)

text-handler.ts integration:
  BEFORE routing check:
    const pending = pendingToolInput.get(chatId)
    if (pending && Date.now() < pending.expiresAt):
      pendingToolInput.delete(chatId)
      enqueueToSession(chatId, `/${pending.name} ${text}`)
      return
    if (pending && Date.now() >= pending.expiresAt):
      pendingToolInput.delete(chatId)
      // fall through to normal routing

## enqueueToSession(chatId, prompt)
  1. const route = await routeMessage(chatId)
  2. if route.mode !== 'cli': reply warning "No active CLI session. /switch to connect."
  3. else: INSERT INTO message_queue(session_id, chat_id, from_user, content, message_id)

## ACCEPTANCE CRITERIA (Gherkin)

```gherkin
Feature: Telegram tool commands

  Scenario: Skills list renders
    Given authenticated user
    When sends /skills
    Then GET /api/tools/skills called
    And message contains header with emoji and count
    And inline_keyboard has 1 button per row
    And each button text matches "{name} — {description≤60}"

  Scenario: No-args tool invocation
    Given skills list shown
    When taps button for skill with requiresArgs=false (e.g. "commit")
    Then message_queue INSERT with content="/commit" and session_id=active_session
    And answerCallbackQuery "✅ Sent"

  Scenario: Args-required tool invocation
    Given skills list shown
    When taps button for skill with requiresArgs=true (e.g. "hookify")
    Then bot replies "Enter arguments for /hookify:"
    And pendingToolInput.get(chatId).name = "hookify"
    When user sends "block commits without tests"
    Then message_queue INSERT with content="/hookify block commits without tests"

  Scenario: Pending input timeout
    Given pendingToolInput set for chatId with expiresAt=past
    When user sends any message
    Then pendingToolInput cleared
    And message routed normally (not as tool args)

  Scenario: Endpoint error
    Given /api/tools/skills returns 500
    When /skills command sent
    Then bot replies error message (not crash)

  Scenario: No active session
    Given route.mode = "standalone" or "disconnected"
    When tool invoked (no-args or after args input)
    Then bot replies "No active CLI session. Use /switch to connect."
    And no message_queue insert
```

## CONSTRAINTS
- callback_data max 64 bytes: "skill:" + name ≤ 64 → max name length = 58 chars
- Telegram inline_keyboard max 100 buttons total
- No DB writes for pending state (in-memory only)
- Endpoint must be accessible from Docker: use BOT_API_URL env var (already exists)

## FILES TO CREATE/MODIFY
NEW:  bot/commands/tools.ts
NEW:  utils/tools-reader.ts  
MOD:  bot/handlers.ts  (register /skills, /commands, /hooks; add pendingToolInput Map)
MOD:  main.ts  (add GET /api/tools/skills, /commands, /hooks routes)
MOD:  bot/text-handler.ts  (check pendingToolInput before routing)

## VERIFICATION
- psql: SELECT * FROM message_queue ORDER BY created_at DESC LIMIT 5;
- logs: grep "tools" in appendLog output
- Telegram: visual check of button layout and descriptions
