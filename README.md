# Claude Bot

A Telegram bot with Claude AI integration, dual-layer memory (short-term + long-term semantic search), and multi-session MCP server for Claude Code CLI.

## Features

- **Telegram Bot** — receive and send messages via Telegram
- **Dual-Layer Memory**
  - Short-term: sliding window of recent messages per session (in-memory cache + PostgreSQL)
  - Long-term: semantic search via pgvector embeddings (powered by Ollama)
- **Multi-Session MCP Server** — multiple Claude Code CLI instances connect via HTTP, each as a named session
- **Channel Adapter** — stdio bridge that forwards Telegram messages into Claude Code as channel notifications
- **Session Switching** — switch between CLI sessions and standalone mode from Telegram
- **Session Adoption** — reconnecting CLIs reuse existing named sessions, preserving ID and memory
- **Standalone Mode** — bot responds directly via Claude API (requires API key)
- **CLI Mode** — forward Telegram messages to a connected Claude Code session via channel notifications

## Architecture

```
┌──────────────┐  stdio (channel)    ┌──────────────────┐
│ Claude CLI 1 │◀═══════════════════▶│ channel.ts       │──┐
│ (keryx)      │                     │ (polls queue)    │  │
└──────────────┘  HTTP (MCP tools)   └──────────────────┘  │
       │                                                   │
       ├──────────────────────────┐                        │
       ▼                         ▼                         ▼
┌──────────────────────────────────┐     ┌────────────────────┐
│   Bot (Bun daemon)               │────▶│ PostgreSQL         │
│                                  │     │ + pgvector         │
│  HTTP MCP: memory + session tools│     │                    │
│  Telegram polling                │     │ tables:            │
│  message_queue writer            │     │  sessions          │
│                                  │     │  messages          │
┌──────────────┐                   │     │  memories (vector) │
│ Telegram     │◀─────────────────▶│     │  message_queue     │
│ User         │                   │     └────────────────────┘
└──────────────┘                   │            │
                                   │     ┌──────┴─────────┐
                                   │     │ Ollama         │
                                   └─────│ nomic-embed-   │
                                         │ text (768d)    │
                                         └────────────────┘
```

**How it works:**
1. Telegram message arrives → bot puts it in `message_queue` (PostgreSQL)
2. `channel.ts` (stdio adapter) polls the queue and sends `notifications/claude/channel` to Claude Code
3. Claude Code processes the message and responds via MCP `reply` tool
4. Reply goes back to Telegram

## Prerequisites

- [Bun](https://bun.sh) runtime
- PostgreSQL 16+ with [pgvector](https://github.com/pgvector/pgvector) extension
- [Ollama](https://ollama.ai) with an embedding model (default: `nomic-embed-text`)
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- (Optional) Anthropic API key for standalone mode

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/MrCipherSmith/multiclaude-tg-bot.git
cd multiclaude-tg-bot
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

### 5. Run the bot

```bash
bun start
# or for development with auto-reload:
bun dev
```

### 6. Connect Claude Code CLI

**Step 1:** Register the HTTP MCP server (memory & session tools):

```bash
claude mcp add --transport http -s user claude-bot http://localhost:3847/mcp
```

**Step 2:** Register the stdio channel adapter (Telegram message forwarding):

```bash
claude mcp add-json -s user claude-bot-channel '{
  "type": "stdio",
  "command": "bun",
  "args": ["/path/to/multiclaude-tg-bot/channel.ts"],
  "env": {
    "DATABASE_URL": "postgres://claude_bot:your_password@localhost:5432/claude_bot",
    "OLLAMA_URL": "http://localhost:11434",
    "TELEGRAM_BOT_TOKEN": "your_bot_token"
  }
}'
```

**Step 3:** Launch Claude Code with the channel:

```bash
cd your-project
claude --dangerously-load-development-channels server:claude-bot-channel
```

Now Telegram messages routed to this session will appear as prompts in Claude Code.

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

### HTTP MCP Server (port 3847)

Available to all Claude Code sessions:

**Memory:**
- `remember` — save to long-term memory with semantic embedding
- `recall` — semantic search through memories
- `forget` — delete a memory
- `list_memories` — list with filters

**Sessions:**
- `list_sessions` — list all sessions
- `session_info` — session details
- `set_session_name` — name the current session (auto-called from CLAUDE.md)

**Telegram:**
- `reply` — send message to a chat
- `react` — set emoji reaction
- `edit_message` — edit bot's message

### Channel Adapter (stdio)

The channel adapter (`channel.ts`) provides:
- `reply` — send message to Telegram (uses Bot API directly)
- `remember`, `recall`, `forget`, `list_memories` — same memory tools via direct DB access

## Auto-Naming Sessions

Add this to your project's `CLAUDE.md` so Claude Code automatically names its session on startup:

```markdown
## MCP Integration

When starting a session, call `set_session_name` with:
- name: basename of the current working directory
- project_path: absolute path to the current working directory
```

When a CLI reconnects and calls `set_session_name` with an existing name, the bot **adopts** the old session — preserving its ID, history, and memory associations.

## Multi-Session Workflow

1. Start the bot: `bun start` (in tmux or systemd)
2. Launch Claude Code in each project with the channel adapter
3. In Telegram, use `/sessions` to see all connected CLIs
4. Use `/switch <id>` to route your Telegram messages to a specific CLI
5. Messages you send are forwarded to that CLI as prompts
6. Claude Code responds via the `reply` tool back to Telegram
7. Switch between projects anytime — context is preserved per session

## Running in Production

Use tmux or systemd to keep the bot running:

```bash
# tmux
tmux new-session -d -s bot -c /path/to/multiclaude-tg-bot 'bun main.ts'

# systemd (create /etc/systemd/system/claude-bot.service)
[Unit]
Description=Claude Telegram Bot
After=network.target postgresql.service

[Service]
Type=simple
User=your_user
WorkingDirectory=/path/to/multiclaude-tg-bot
ExecStart=/path/to/.bun/bin/bun main.ts
Restart=always
EnvironmentFile=/path/to/multiclaude-tg-bot/.env

[Install]
WantedBy=multi-user.target
```

## Tech Stack

- **Runtime:** [Bun](https://bun.sh)
- **Telegram:** [grammY](https://grammy.dev)
- **AI:** [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript)
- **MCP:** [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) (StreamableHTTPServerTransport + StdioServerTransport)
- **Database:** PostgreSQL 16 + [pgvector](https://github.com/pgvector/pgvector)
- **Embeddings:** [Ollama](https://ollama.ai) (nomic-embed-text, 768 dims)
- **PostgreSQL client:** [postgres](https://github.com/porsager/postgres)

## License

MIT
