# Claude Bot

A Telegram bot with Claude AI integration, dual-layer memory (short-term + long-term semantic search), and multi-session MCP server for Claude Code CLI.

## Features

- **Telegram Bot** — receive and send messages via Telegram
- **Dual-Layer Memory**
  - Short-term: sliding window of recent messages per session (in-memory cache + PostgreSQL)
  - Long-term: semantic search via pgvector embeddings (powered by Ollama)
- **Multi-Session MCP Server** — multiple Claude Code CLI instances connect via HTTP, each as a named session
- **Session Switching** — switch between CLI sessions and standalone mode from Telegram
- **Standalone Mode** — bot responds directly via Claude API (requires API key)
- **CLI Mode** — forward Telegram messages to a connected Claude Code session

## Architecture

```
┌──────────────┐
│ Claude CLI 1 │──┐
└──────────────┘  │  HTTP (MCP)
                  ├────────────────┐
┌──────────────┐  │                ▼
│ Claude CLI 2 │──┘     ┌──────────────────────────┐     ┌────────────┐
└──────────────┘        │   Bot (Bun daemon)       │────▶│ PostgreSQL │
                        │                          │     │ + pgvector │
┌──────────────┐        │  MCP over HTTP:          │     └────────────┘
│ Telegram     │◀──────▶│   memory + telegram +    │           │
│ User         │        │   session tools          │     ┌─────┴──────┐
└──────────────┘        │                          │     │   Ollama   │
                        │  Telegram polling        │     │  nomic-    │
                        └──────────────────────────┘     │  embed-text│
                                                         └────────────┘
```

## Prerequisites

- [Bun](https://bun.sh) runtime
- PostgreSQL 16+ with [pgvector](https://github.com/pgvector/pgvector) extension
- [Ollama](https://ollama.ai) with an embedding model (default: `nomic-embed-text`)
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- (Optional) Anthropic API key for standalone mode

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/claude-bot.git
cd claude-bot
bun install
```

### 2. Set up the database

```bash
# Create database and enable pgvector
psql -U postgres -c "CREATE USER claude_bot WITH PASSWORD 'your_password';"
psql -U postgres -c "CREATE DATABASE claude_bot OWNER claude_bot;"
psql -U postgres -d claude_bot -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### 3. Set up Ollama

```bash
ollama pull nomic-embed-text
```

### 4. Configure environment

```bash
cp .env.example .env
# Edit .env with your values:
#   TELEGRAM_BOT_TOKEN  — from @BotFather
#   ALLOWED_USERS       — comma-separated Telegram user IDs
#   DATABASE_URL        — PostgreSQL connection string
#   ANTHROPIC_API_KEY   — (optional) for standalone mode
```

### 5. Run

```bash
bun start
# or for development with auto-reload:
bun dev
```

### 6. Connect Claude Code CLI

Add the MCP server globally:

```bash
claude mcp add --transport http -s user claude-bot http://localhost:3847/mcp
```

Or per-project via `.mcp.json`:

```json
{
  "mcpServers": {
    "claude-bot": {
      "type": "http",
      "url": "http://localhost:3847/mcp"
    }
  }
}
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/help` | Show help |
| `/sessions` | List all sessions |
| `/switch [id]` | Switch to a session (interactive if no ID) |
| `/standalone` | Switch to standalone mode |
| `/session` | Current session info |
| `/rename <id> <name>` | Rename a session |
| `/remember [text]` | Save to long-term memory |
| `/recall [query]` | Semantic search through memory |
| `/memories` | List recent memories |
| `/forget [id]` | Delete a memory |
| `/clear` | Clear current session context |
| `/cleanup` | Remove stale sessions |
| `/status` | Bot status (DB, Ollama, counts) |

## MCP Tools

Available to Claude Code CLI when connected:

**Memory:**
- `remember` — save to long-term memory with semantic embedding
- `recall` — semantic search through memories
- `forget` — delete a memory
- `list_memories` — list with filters

**Telegram:**
- `reply` — send message to a chat
- `react` — set emoji reaction
- `edit_message` — edit bot's message

**Sessions:**
- `list_sessions` — list all sessions
- `session_info` — session details
- `set_session_name` — name the current session

## Auto-Naming Sessions

Add this to your project's `CLAUDE.md` so Claude Code automatically names its session on startup:

```markdown
## MCP Integration

When starting a session, call `set_session_name` with:
- name: basename of the current working directory
- project_path: absolute path to the current working directory
```

## Running in Production

Use tmux or systemd to keep the bot running:

```bash
# tmux
tmux new-session -d -s bot -c /path/to/claude-bot 'bun main.ts'

# systemd (create /etc/systemd/system/claude-bot.service)
[Unit]
Description=Claude Telegram Bot
After=network.target

[Service]
Type=simple
User=your_user
WorkingDirectory=/path/to/claude-bot
ExecStart=/path/to/.bun/bin/bun main.ts
Restart=always
EnvironmentFile=/path/to/claude-bot/.env

[Install]
WantedBy=multi-user.target
```

## Tech Stack

- **Runtime:** Bun
- **Telegram:** grammY
- **AI:** @anthropic-ai/sdk
- **MCP:** @modelcontextprotocol/sdk (StreamableHTTPServerTransport)
- **Database:** PostgreSQL + pgvector
- **Embeddings:** Ollama (nomic-embed-text, 768 dims)
- **PostgreSQL client:** postgres (porsager/postgres)

## License

MIT
