# MCP Tools Reference

Helyx exposes MCP (Model Context Protocol) tools to Claude CLI. These tools are available in two configurations depending on how you connect.

---

## HTTP Server Tools

Available when Claude CLI connects via `helyx` HTTP MCP server (`http://localhost:3847/mcp`).

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
| `react` | `chat_id`, `message_id`, `emoji` | Set an emoji reaction on a Telegram message. |
| `edit_message` | `chat_id`, `message_id`, `text` | Edit a previously sent bot message. |

---

## Channel Adapter Tools

Available when Claude CLI connects via `helyx-channel` stdio MCP server. The channel adapter (`channel/`) is a 7-module stdio bridge: `session.ts` (lifecycle), `permissions.ts` (Telegram forwarding), `tools.ts` (MCP dispatch), `poller.ts` (queue polling), `status.ts` (live status), `telegram.ts` (formatting), `index.ts` (entrypoint).

These tools run in the context of a specific session and have direct database access.

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

## Permission State Machine

Permission requests flow through a formal state machine enforced by `PermissionService`:

```
pending → approved
        → rejected
        → expired
```

Terminal states (`approved`, `rejected`, `expired`) cannot transition again — duplicate Telegram callback deliveries are silently ignored. The bot replies "Already handled" to deduplicated callbacks.

Auto-approve rules stored in `settings.local.json`:
```json
{
  "permissions": {
    "allow": ["Edit(*)", "Bash(*)", "mcp__helyx__reply"]
  }
}
```

Pattern format:
- Native tools: `ToolName(*)` (e.g., `Edit(*)`, `Bash(*)`)
- MCP tools: exact tool name (e.g., `mcp__helyx__reply`)

---

## Health Endpoint

Not an MCP tool, but useful for monitoring:

```bash
GET http://localhost:3847/health
→ { "status": "ok", "db": "connected", "uptime": 3600, "sessions": 5 }
```

---

## Registration

MCP servers are registered in Claude Code via `helyx setup` or `helyx mcp-register`. You can also register manually:

```bash
# HTTP server
claude mcp add --transport http -s user helyx http://localhost:3847/mcp

# Channel adapter (per-session stdio)
claude mcp add-json -s user helyx-channel '{
  "type": "stdio",
  "command": "bun",
  "args": ["/path/to/helyx/channel.ts"],
  "env": {
    "DATABASE_URL": "postgres://helyx:helyx_secret@localhost:5433/helyx",
    "TELEGRAM_BOT_TOKEN": "your-bot-token"
  }
}'
```

To use the channel adapter, launch Claude with:
```bash
claude --dangerously-load-development-channels server:helyx-channel
```
