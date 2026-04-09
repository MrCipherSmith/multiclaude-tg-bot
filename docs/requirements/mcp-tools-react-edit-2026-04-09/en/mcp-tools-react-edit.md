# PRD: Add react and edit_message to Channel Adapter

## Overview

Add `react` (set emoji reaction) and `edit_message` (edit a previously sent message) to the `channel.ts` stdio MCP adapter, so these tools are available in all connection modes — not just the HTTP MCP server.

## Current State

**Already implemented in HTTP MCP server (`mcp/server.ts` + `mcp/tools.ts`):**
- `react` — registered as tool (lines 109–130 of `mcp/server.ts`), implemented via `bot.api.setMessageReaction` (lines 296–315 of `mcp/tools.ts`)
- `edit_message` — same: registered and implemented via `bot.api.editMessageText`

**Missing from channel adapter (`channel.ts`):**
- `ListToolsRequestSchema` handler (lines 522–609) does not include `react` or `edit_message`
- `CallToolRequestSchema` switch (lines 620–828) has no `case "react"` or `case "edit_message"`

**README impact:** The tools are marked as `_(planned)_` in the README but they ARE implemented — just only in the HTTP MCP server. The channel adapter is the gap.

## Goals

- Add `react` and `edit_message` to `channel.ts` tool list and handler switch
- Make both tools available when connecting via channel adapter (stdio)
- Remove `_(planned)_` markers from README after implementation

## Non-Goals

- Changing the HTTP MCP server implementation (already correct)
- Adding new tools beyond these two
- Changing the Telegram API call logic

## Implementation Notes

`channel.ts` has no `bot` instance — it communicates with Telegram via direct fetch to the Bot API (same pattern as `reply` which uses `TELEGRAM_BOT_TOKEN` from env). The `react` and `edit_message` handlers should follow this pattern.

**`react` tool:** `POST https://api.telegram.org/bot{TOKEN}/setMessageReaction`
- Parameters: `chat_id`, `message_id`, `reaction` (array with emoji)

**`edit_message` tool:** `POST https://api.telegram.org/bot{TOKEN}/editMessageText`
- Parameters: `chat_id`, `message_id`, `text`, `parse_mode` (optional, default HTML)

Tool schemas to add to `ListToolsRequestSchema`:
```json
{
  "name": "react",
  "description": "Set an emoji reaction on a Telegram message",
  "inputSchema": {
    "type": "object",
    "properties": {
      "message_id": { "type": "number" },
      "emoji": { "type": "string", "description": "Single emoji character" }
    },
    "required": ["message_id", "emoji"]
  }
}
```
```json
{
  "name": "edit_message",
  "description": "Edit a previously sent bot message",
  "inputSchema": {
    "type": "object",
    "properties": {
      "message_id": { "type": "number" },
      "text": { "type": "string" }
    },
    "required": ["message_id", "text"]
  }
}
```

## Acceptance Criteria

```gherkin
Scenario: react tool available in channel adapter
  Given Claude CLI is connected via channel adapter
  When I call tool "react" with message_id and emoji
  Then the Telegram message receives the emoji reaction

Scenario: edit_message tool available in channel adapter
  Given Claude CLI is connected via channel adapter
  When I call tool "edit_message" with message_id and new text
  Then the original bot message is updated with new text

Scenario: HTTP MCP server behavior unchanged
  Given Claude CLI connects via HTTP MCP server
  Then react and edit_message work as before
```
