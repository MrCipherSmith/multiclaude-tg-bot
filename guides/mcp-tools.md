# MCP Tools Reference

Claude Bot exposes MCP (Model Context Protocol) tools to Claude CLI. These tools are available in two configurations depending on how you connect.

---

## HTTP Server Tools

Available when Claude CLI connects via `claude-bot` HTTP MCP server (`http://localhost:3847/mcp`).

These tools work in any Claude session — with or without the channel adapter.

### Memory

| Tool | Parameters | Description |
|---|---|---|
| `remember` | `text`, `type?`, `sessionId?` | Save a fact to long-term memory with semantic embedding. Types: `fact`, `decision`, `note`. Uses smart reconciliation — won't duplicate existing memories. |
| `recall` | `query`, `limit?` | Semantic search through project memories using pgvector. Returns ranked results by similarity. |
| `forget` | `id` | Delete a memory by ID. |
| `list_memories` | `limit?`, `type?` | List recent memories for the current project. |
| `search_project_context` | `query`, `limit?` | Semantic search specifically over project work summaries and prior session context. |

### Sessions

| Tool | Parameters | Description |
|---|---|---|
| `list_sessions` | — | List all sessions with status (active/inactive/terminated), source (remote/local/standalone), project, and last active time. |
| `session_info` | `sessionId?` | Get details for a specific session or the current one. |
| `set_session_name` | `name`, `projectPath` | Set the session name and register the project path. Called automatically by channel.ts on startup. |

### Communication

| Tool | Parameters | Description |
|---|---|---|
| `reply` | `text`, `chatId?` | Send a message to the Telegram chat. Supports HTML formatting (bold, italic, code blocks, links). |
| `react` | `messageId`, `emoji` | Set an emoji reaction on a Telegram message. _(planned)_ |
| `edit_message` | `messageId`, `text` | Edit a previously sent bot message. _(planned)_ |

---

## Channel Adapter Tools

Available when Claude CLI connects via `claude-bot-channel` stdio MCP server. These tools run in the context of a specific session and have direct database access.

All HTTP server tools are also available through the channel adapter, plus:

| Tool | Parameters | Description |
|---|---|---|
| `update_status` | `status`, `chatId`, `diff?` | Update the live status message shown in Telegram while processing. Automatically deleted when `reply` is called. Optionally include a `diff` code block as a separate message. |

### update_status usage

Call `update_status` before each major operation to keep the user informed:

```typescript
// Before reading files
update_status({ chatId, status: "Reading files..." })

// Before running commands
update_status({ chatId, status: "Running tests..." })

// Before analysis
update_status({ chatId, status: "Analyzing..." })

// With a diff block
update_status({
  chatId,
  status: "Editing code...",
  diff: "```diff\n- old line\n+ new line\n```"
})
```

Keep status messages under 50 characters. The status is automatically deleted when `reply` is called.

### Sub-agent progress updates

When launching multiple parallel agents, update status with a progress tree:

```
Running 3 agents...
├─ Agent name 1 — done
├─ Agent name 2 — done
└─ Agent name 3 — working...
```

---

## Health Endpoint

Not an MCP tool, but useful for monitoring:

```bash
GET http://localhost:3847/health
→ { "status": "ok", "db": "connected", "uptime": 3600, "sessions": 5 }
```

---

## Registration

MCP servers are registered in Claude Code via `claude-bot setup` or `claude-bot mcp-register`. You can also register manually:

```bash
# HTTP server
claude mcp add --transport http -s user claude-bot http://localhost:3847/mcp

# Channel adapter (per-session stdio)
claude mcp add-json -s user claude-bot-channel '{
  "type": "stdio",
  "command": "bun",
  "args": ["/path/to/claude-bot/channel.ts"],
  "env": {
    "DATABASE_URL": "postgres://claude_bot:claude_bot_secret@localhost:5433/claude_bot",
    "TELEGRAM_BOT_TOKEN": "your-bot-token"
  }
}'
```

To use the channel adapter, launch Claude with:
```bash
claude --dangerously-load-development-channels server:claude-bot-channel
```
