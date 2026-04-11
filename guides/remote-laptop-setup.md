# Remote Laptop Setup

Connect your laptop to a helyx instance running on a remote server. This lets you use Claude CLI locally while the bot, database, and Telegram integration live on the server.

---

## Overview

```
  Your Laptop                        Remote Server
  ─────────────────────              ─────────────────────────────
  Claude CLI                         Docker: bot (port 3847)
    └─ MCP: helyx (HTTP) ──────▶ /mcp endpoint
    └─ MCP: helyx-channel        Docker: PostgreSQL (port 5433)
         └─ channel.ts (local) ──────▶ DB via SSH tunnel
              ▲
              │ polls message_queue
              │
         Telegram messages arrive on server → stored in DB → channel.ts picks them up
```

`channel.ts` runs **on your laptop** but connects to the server's PostgreSQL through an SSH tunnel. This means Telegram messages flow to the server, get queued in the DB, and are delivered to your local Claude CLI in real time.

---

## Prerequisites

- SSH access to the server where the bot is running
- `bun` installed on your laptop (`curl -fsSL https://bun.sh/install | bash`)
- The helyx repository cloned on your laptop (for `channel.ts`)
- Claude CLI installed on your laptop

---

## Method A: SSH Tunnel (Full Features) — Recommended

Full integration: real-time Telegram messages, memory, reply, status updates, permission forwarding.

### Step 1: Run the setup wizard

```bash
helyx remote
```

The wizard asks:

| Prompt | Default | Description |
|---|---|---|
| Server hostname or IP | — | e.g. `192.168.1.10` or `myserver.com` |
| SSH user | `$USER` | Your SSH username on the server |
| Bot port on server | `3847` | The port the bot HTTP API listens on |
| PostgreSQL port on server | `5433` | The port PostgreSQL is mapped to on the server |
| Telegram Bot Token | — | Same token as configured on the server |
| Path to helyx on server | `/home/<user>/bots/helyx` | Where the repo lives on the server |
| Connection method | — | Choose **SSH tunnel** |

### Step 2: Start the SSH tunnel

Open a **separate terminal** and keep it running:

```bash
ssh -L 3847:localhost:3847 -L 5433:localhost:5433 user@your-server
```

This forwards:
- `localhost:3847` → bot HTTP API on the server
- `localhost:5433` → PostgreSQL on the server

### Step 3: Register MCP servers (wizard does this automatically)

If you chose "Register now" during the wizard, two MCP servers are registered in Claude Code:

**1. `helyx` — HTTP transport**

```bash
claude mcp add --transport http -s user helyx http://localhost:3847/mcp
```

Provides tools: `reply`, `remember`, `recall`, `list_sessions`, `session_info`, `set_session_name`, `search_project_context`, `update_status`, etc.

**2. `helyx-channel` — stdio (channel adapter)**

```bash
claude mcp add-json -s user helyx-channel '{
  "type": "stdio",
  "command": "bun",
  "args": ["/path/to/helyx/channel.ts"],
  "env": {
    "DATABASE_URL": "postgres://helyx:helyx_secret@localhost:5433/helyx",
    "OLLAMA_URL": "http://localhost:11434",
    "TELEGRAM_BOT_TOKEN": "<your-token>"
  }
}'
```

`channel.ts` runs locally, connects to the server's PostgreSQL through the tunnel, and delivers Telegram messages to Claude CLI.

> **Note:** `bun` and the `channel.ts` file must exist on your laptop. If you only have the bot running on the server, clone the repo locally too — you only need it for `channel.ts`, no need to run the full bot.

### Step 4: Connect a project

```bash
cd your-project
claude --dangerously-load-development-channels server:helyx-channel
```

Open Telegram — your session appears in `/sessions`. Messages, voice, photos all work.

---

## Method B: HTTP Only (Simple)

No `channel.ts`, no real-time Telegram push. Claude CLI can use MCP tools (`reply`, `recall`, etc.) manually, but Telegram messages won't appear automatically in the CLI.

### Step 1: Make the bot port accessible

Either via SSH tunnel:
```bash
ssh -L 3847:localhost:3847 user@your-server
```

Or by opening the port on the server (less secure).

### Step 2: Run the wizard and choose "HTTP only"

```bash
helyx remote
```

Registers only:
```bash
claude mcp add --transport http -s user helyx http://localhost:3847/mcp
```

### Step 3: Use Claude normally

```bash
cd your-project
claude
```

Available MCP tools: `reply`, `remember`, `recall`, `list_sessions`, `session_info`, `update_status`, `search_project_context`.

---

## Manual Setup (without the wizard)

If you prefer to configure everything by hand:

```bash
# 1. Start SSH tunnel (keep running in background or separate terminal)
ssh -L 3847:localhost:3847 -L 5433:localhost:5433 user@your-server

# 2. Remove old registrations (if any)
claude mcp remove helyx -s user
claude mcp remove helyx-channel -s user

# 3. Register HTTP MCP server
claude mcp add --transport http -s user helyx http://localhost:3847/mcp

# 4. Register channel adapter
claude mcp add-json -s user helyx-channel '{
  "type": "stdio",
  "command": "bun",
  "args": ["/home/you/bots/helyx/channel.ts"],
  "env": {
    "DATABASE_URL": "postgres://helyx:helyx_secret@localhost:5433/helyx",
    "OLLAMA_URL": "http://localhost:11434",
    "TELEGRAM_BOT_TOKEN": "your-bot-token"
  }
}'

# 5. Connect your project
cd your-project
claude --dangerously-load-development-channels server:helyx-channel
```

---

## Troubleshooting

**`channel.ts` can't connect to DB**
- Check that the SSH tunnel is running and port 5433 is forwarded
- Verify `DATABASE_URL` uses `localhost:5433` (not the server's internal address)

**MCP server not found**
- Run `claude mcp list` to confirm registrations
- Re-run `helyx remote` to re-register

**Messages not appearing in CLI**
- Confirm the SSH tunnel is active (`ssh -L ...` process is running)
- Check that `bun` is in `$PATH` on your laptop (`which bun`)
- Ensure the `channel.ts` path in the MCP config is correct

**Bot port unreachable**
- Verify the tunnel is forwarding port 3847
- Run `curl http://localhost:3847/health` — should return `{"status":"ok",...}`
