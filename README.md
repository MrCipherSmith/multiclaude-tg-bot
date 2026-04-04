# Claude Bot

A Telegram bot with Claude AI integration, dual-layer memory (short-term + long-term semantic search), and multi-session MCP server for Claude Code CLI.

## Features

- **Telegram Bot** — receive and send messages via Telegram
- **Dual-Layer Memory**
  - Short-term: sliding window of recent messages per session (in-memory cache + PostgreSQL)
  - Long-term: semantic search via pgvector embeddings (powered by Ollama)
- **Multi-Session MCP Server** — multiple Claude Code CLI instances connect via HTTP, each as a named session
- **Channel Adapter** — stdio bridge that forwards Telegram messages into Claude Code as channel notifications
- **Session Switching** — switch between CLI sessions and standalone mode from Telegram, with context summary
- **One Session Per Project** — reconnecting CLIs reuse existing sessions by project path, preserving ID and memory
- **Voice Messages** — transcription via Groq (whisper-large-v3) with local Whisper fallback
- **Image Analysis** — photos analyzed by Claude in CLI sessions; standalone mode with Anthropic API
- **Markdown Rendering** — responses formatted with HTML in Telegram (bold, italic, code blocks, links)
- **Statistics & Logging** — API usage, token tracking, transcription stats, per-session request logs (`/stats`, `/logs`)
- **Live Status Updates** — real-time progress in Telegram while CLI processes messages ("Думаю... 5с", "Читаю: file.ts")
- **Permission Forwarding** — CLI permission requests sent as inline buttons (Allow / Always / Deny), terminal approvals synced back
- **Health Endpoint** — `GET /health` with DB status, uptime, active sessions
- **Auto-Cleanup** — hourly cleanup of old queue messages, logs, and stats
- **Standalone Mode** — bot responds directly via LLM API (Anthropic / OpenRouter / Ollama)
- **CLI Mode** — forward Telegram messages to a connected Claude Code session via channel notifications

## Architecture

```
                          ┌─────────────────────────────────────────────────┐
                          │      Host / Laptop / Any terminal              │
                          │                                                 │
  ┌─────────────┐ stdio   │  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
  │ channel.ts  │◀═══════▶│  │ Claude CLI│  │ Claude CLI│  │ Claude CLI│  │
  │ (per-session│  MCP     │  │ project-a │  │ project-b │  │ general   │  │
  │  adapter)   │         │  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  │
  └──────┬──────┘         │        │              │              │         │
         │ polls           │        │   Bash/Read/Edit/Write     │         │
         │ message_queue   │        ▼              ▼              ▼         │
         │                 │  ┌──────────────────────────────────────────┐  │
         │                 │  │           Project Files (host)           │  │
         │                 │  └──────────────────────────────────────────┘  │
         │                 └─────────────────────────────────────────────────┘
         │
         │                 ┌─────────────────────────────────────────────────┐
         │                 │              Docker                             │
         │  direct DB      │                                                 │
         ├────────────────▶│  ┌──────────────────────────────────────────┐  │
         │                 │  │  Bot (main.ts)                    :3847  │  │
         │                 │  │                                          │  │
         │                 │  │  Telegram polling ◀──▶ Telegram API      │  │
         │                 │  │  HTTP MCP server  ◀──▶ Claude CLIs      │  │
         │                 │  │  Standalone LLM   ──▶ OpenRouter/Ollama │  │
         │                 │  │  Voice transcribe ──▶ Groq API          │  │
         │                 │  │  Markdown → HTML  ──▶ Telegram          │  │
         │                 │  │  /health, /stats, cleanup timers        │  │
         │                 │  └──────────────┬───────────────────────────┘  │
         │                 │                 │                               │
         │                 │                 ▼                               │
         │                 │  ┌──────────────────────────────────────────┐  │
         │                 │  │  PostgreSQL + pgvector            :5433  │  │
         │                 │  │                                          │  │
         │                 │  │  sessions          message_queue         │  │
         │                 │  │  messages           permission_requests  │  │
         │                 │  │  memories (vector)  api_request_stats    │  │
         │                 │  │  chat_sessions      transcription_stats  │  │
         │                 │  │                     request_logs         │  │
         │                 │  └──────────────────────────────────────────┘  │
         │                 └─────────────────────────────────────────────────┘
         │
         │                 ┌───────────────────────┐
         └────────────────▶│  Ollama (host)  :11434│
                           │  nomic-embed-text     │
              embeddings   │  (768 dims)           │
                           └───────────────────────┘

┌──────────┐   messages    ┌──────────────────┐
│ Telegram │◀─────────────▶│  Bot (Docker)    │
│ User     │  voice/photo  │                  │
│          │──────────────▶│  downloads/      │◀──── shared with host CLIs
└──────────┘  permissions  │                  │
              ◀───────────▶│                  │
              inline btns  └──────────────────┘
```

**Message flow (CLI mode):**
1. Telegram message arrives → bot saves to `messages` + inserts into `message_queue`
2. `channel.ts` polls queue → sends `notifications/claude/channel` to Claude CLI
3. Bot sends `⏳ Думаю...` status message to Telegram (with live timer)
4. Claude CLI processes: reads files, runs commands, analyzes images
5. Permission requests (Bash/Edit) forwarded to Telegram as inline buttons
6. CLI responds via `reply` MCP tool → message sent to Telegram with HTML formatting
7. Status message deleted, typing indicator stopped

**Message flow (Standalone mode):**
1. Telegram message → bot composes prompt (short-term context + long-term memory recall)
2. Streams LLM response to Telegram with periodic message edits
3. Final edit applies Markdown→HTML formatting
4. Idle timer starts → auto-summarization after 15 min inactivity

## Quick Start

The fastest way — interactive setup wizard:

```bash
git clone https://github.com/MrCipherSmith/multiclaude-tg-bot.git
cd multiclaude-tg-bot
bun install
bun cli.ts setup
```

The wizard will ask for your Telegram token, LLM provider, and other settings, then configure everything automatically.

### CLI Management Commands

```bash
bun cli.ts status         # Bot health, uptime, docker status
bun cli.ts sessions       # List active sessions with activity time
bun cli.ts logs           # Follow bot logs
bun cli.ts start          # Start bot (docker compose up)
bun cli.ts stop           # Stop bot
bun cli.ts restart        # Rebuild and restart
bun cli.ts backup         # Run database backup
bun cli.ts prune          # Remove stale/duplicate sessions (interactive)
bun cli.ts cleanup        # Clean old queue, logs, stats
bun cli.ts connect [dir]  # Start CLI session for a project
bun cli.ts remote         # Connect laptop to remote bot server
bun cli.ts mcp-register   # Re-register MCP servers in Claude Code
```

Sessions are automatically marked as `disconnected` after 1 hour of inactivity. Use `prune` to interactively review and remove stale or duplicate sessions.

## Manual Setup (Docker)

If you prefer to configure manually. Docker Compose starts PostgreSQL (with pgvector) and the bot. Ollama must be installed on the host:

```bash
git clone https://github.com/MrCipherSmith/multiclaude-tg-bot.git
cd multiclaude-tg-bot

cp .env.example .env
# Edit .env — set at minimum:
#   TELEGRAM_BOT_TOKEN  — from @BotFather
#   ALLOWED_USERS       — your Telegram user ID
#   GROQ_API_KEY        — (optional) for voice message transcription

docker compose up -d
```

This starts PostgreSQL (with pgvector) and the bot. Requires [Ollama](https://ollama.ai) running on the host with the embedding model:

```bash
# Install Ollama (if not installed)
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull nomic-embed-text
```

The bot runs on port 3847. PostgreSQL is available at `localhost:5433` for debugging.

### Voice Transcription Setup

Voice messages are transcribed using **Groq** (free, fast, whisper-large-v3) as the primary provider, with local Whisper ASR as fallback.

1. Go to https://console.groq.com and sign up (Google/GitHub)
2. Go to **API Keys** → **Create API Key**
3. Add to `.env`:
   ```
   GROQ_API_KEY=gsk_your_key_here
   ```

Free tier: 7,000 requests/day. If Groq is unavailable, the bot falls back to the local Whisper container (if enabled in docker-compose).

## Manual Setup

If you prefer to run without Docker (or already have PostgreSQL/Ollama):

### Prerequisites

- [Bun](https://bun.sh) runtime
- PostgreSQL 16+ with [pgvector](https://github.com/pgvector/pgvector) extension
- [Ollama](https://ollama.ai) with an embedding model (default: `nomic-embed-text`)
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- (Optional) Anthropic API key for standalone mode

### 1. Clone and install

```bash
git clone https://github.com/MrCipherSmith/multiclaude-tg-bot.git
cd multiclaude-tg-bot
bun install
```

### 2. Set up the database

```bash
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
# Edit .env:
#   TELEGRAM_BOT_TOKEN  — from @BotFather
#   ALLOWED_USERS       — comma-separated Telegram user IDs
#   DATABASE_URL        — postgres://claude_bot:password@localhost:5432/claude_bot
#   OLLAMA_URL          — http://localhost:11434
#   GROQ_API_KEY        — (optional) for voice transcription (free: https://console.groq.com)
#   ANTHROPIC_API_KEY   — (optional) for standalone mode
```

### 5. Run the bot

```bash
bun start
# or for development with auto-reload:
bun dev
```

## Ubuntu Server Setup (from scratch)

Complete setup on a fresh Ubuntu 22.04+ server:

```bash
# 1. Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# 2. Install PostgreSQL 16 + pgvector
sudo apt update
sudo apt install -y postgresql-16 postgresql-16-pgvector

# 3. Create database
sudo -u postgres psql -c "CREATE USER claude_bot WITH PASSWORD 'your_password';"
sudo -u postgres psql -c "CREATE DATABASE claude_bot OWNER claude_bot;"
sudo -u postgres psql -d claude_bot -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 4. Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull nomic-embed-text

# 5. Clone and install
git clone https://github.com/MrCipherSmith/multiclaude-tg-bot.git
cd multiclaude-tg-bot
bun install

# 6. Configure
cp .env.example .env
nano .env
# Set:
#   TELEGRAM_BOT_TOKEN=your_token
#   ALLOWED_USERS=your_telegram_id
#   DATABASE_URL=postgres://claude_bot:your_password@localhost:5432/claude_bot
#   OLLAMA_URL=http://localhost:11434

# 7. Run (choose one)
bun start                           # foreground
tmux new -d -s bot 'bun main.ts'    # tmux (survives SSH disconnect)
```

### Optional: Run as systemd service

```bash
sudo tee /etc/systemd/system/claude-bot.service > /dev/null <<EOF
[Unit]
Description=Claude Telegram Bot
After=network.target postgresql.service ollama.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
ExecStart=$(which bun) main.ts
Restart=always
RestartSec=5
EnvironmentFile=$(pwd)/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now claude-bot
sudo systemctl status claude-bot
```

### Install Claude Code CLI

```bash
# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Register MCP servers
claude mcp add --transport http -s user claude-bot http://localhost:3847/mcp

claude mcp add-json -s user claude-bot-channel '{
  "type": "stdio",
  "command": "bun",
  "args": ["'$(pwd)'/channel.ts"],
  "env": {
    "DATABASE_URL": "postgres://claude_bot:your_password@localhost:5432/claude_bot",
    "OLLAMA_URL": "http://localhost:11434",
    "TELEGRAM_BOT_TOKEN": "your_token"
  }
}'

# Launch with Telegram channel
cd your-project
claude --dangerously-load-development-channels server:claude-bot-channel
```

## Connecting Claude Code CLI

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
| `/switch [id]` | Switch to a session (shows context summary) |
| `/standalone` | Switch to standalone mode |
| `/session` | Current session info |
| `/rename <id> <name>` | Rename a session |
| `/remember [text]` | Save to long-term memory |
| `/recall [query]` | Semantic search through memory |
| `/memories` | List recent memories |
| `/forget [id]` | Delete a memory |
| `/clear` | Clear current session context |
| `/summarize` | Force conversation summarization to long-term memory |
| `/cleanup` | Remove stale sessions |
| `/status` | Bot status (DB, Ollama, counts) |
| `/stats` | Statistics: API usage, tokens, transcriptions, per session |
| `/logs [id]` | Request logs for current or specified session |
| `/pending` | Show pending CLI permission requests |
| `/tools` | List available MCP tools for current session |
| `/skills` | List skills from knowledge base (requires `KNOWLEDGE_BASE`) |
| `/rules` | List coding rules from knowledge base (requires `KNOWLEDGE_BASE`) |

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
- `reply` — send message to Telegram (with Markdown→HTML rendering)
- `update_status` — update the live status message in Telegram
- `remember`, `recall`, `forget`, `list_memories` — same memory tools via direct DB access

### Health Endpoint

```
GET http://localhost:3847/health
```

Returns JSON with database status, uptime, and active session count. Used by Docker healthcheck.

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

1. Start the bot: `docker compose up -d` (or `bun start` for local dev)
2. Launch Claude Code in each project with the channel adapter
3. In Telegram, use `/sessions` to see all connected CLIs
4. Use `/switch <id>` to route your Telegram messages to a specific CLI
5. Messages you send are forwarded to that CLI as prompts
6. Claude Code responds via the `reply` tool back to Telegram
7. Switch between projects anytime — context is preserved per session

### Connecting CLI Sessions

Any Claude Code instance can connect — from a local laptop terminal, VS Code, SSH session, or a server tmux session. The only requirements are the registered MCP servers (`claude-bot` and `claude-bot-channel`) and network access to the bot.

**From any terminal (laptop, desktop, SSH):**

```bash
cd /path/to/your-project
claude --dangerously-load-development-channels server:claude-bot-channel
```

The session appears in Telegram `/sessions` immediately. When you close the terminal, the session disconnects but its data (messages, memory) is preserved. Reconnecting from the same project auto-adopts the old session.

### Persistent CLI Sessions (server, survives SSH disconnect)

Use tmux on a server to keep CLI sessions running permanently:

```bash
# Create a tmux session for each project
tmux new-session -d -s myproject -c /path/to/myproject
tmux send-keys -t myproject 'claude --dangerously-load-development-channels server:claude-bot-channel' Enter

# General session (no specific project)
tmux new-session -d -s general -c ~
tmux send-keys -t general 'claude --dangerously-load-development-channels server:claude-bot-channel' Enter

# List / attach / detach
tmux ls
tmux attach -t myproject      # view session
# Ctrl+B, D                   # detach (session keeps running)
```

For auto-restart on crash:

```bash
tmux new-session -d -s myproject -c /path/to/myproject
tmux send-keys -t myproject '/path/to/multiclaude-tg-bot/scripts/run-cli.sh /path/to/myproject' Enter
```

Each CLI session auto-names itself from the working directory via `CLAUDE.md` → `set_session_name`.

**One session per project:** Each project directory gets exactly one session. Reconnecting from the same path reuses the existing session — preserving its ID, messages, and memory. No duplicate sessions are created.

**Context on switch:** When you `/switch` to a session in Telegram, the bot shows the session status, project path, and a preview of recent messages so you know the current context.

### Remote Connection (laptop → server)

If the bot runs on a server and you want to connect from your laptop:

```bash
# On your laptop — clone the repo and run remote setup wizard
git clone https://github.com/MrCipherSmith/multiclaude-tg-bot.git
cd multiclaude-tg-bot
bun install
bun cli.ts remote
```

The wizard offers two connection methods:

**SSH Tunnel (recommended, full features):**
```bash
# Terminal 1: open tunnel
ssh -L 3847:localhost:3847 -L 5433:localhost:5433 user@server

# Terminal 2: connect your project
cd your-project
claude --dangerously-load-development-channels server:claude-bot-channel
```

Channel notifications, memory, reply — everything works through the tunnel. `channel.ts` runs locally on your laptop but connects to the server's database via the tunnel.

**HTTP Only (simple, limited):**
```bash
# Open tunnel for bot port only
ssh -L 3847:localhost:3847 user@server

# Use Claude Code with MCP tools (no channel adapter)
cd your-project
claude
```

MCP tools (reply, remember, recall) work, but Telegram messages won't auto-push to your CLI. You interact with the bot through tool calls only.

## Running in Production

### Using Docker Compose (recommended)

```bash
# Start the bot (PostgreSQL + bot)
docker compose up -d

# View bot logs
docker compose logs bot -f

# Restart the bot (e.g. after code changes)
docker compose up -d --build bot

# Stop everything
docker compose down
```

### Using tmux (without Docker)

```bash
# Start the bot in a background tmux session
tmux new-session -d -s bot -c /path/to/multiclaude-tg-bot 'bun main.ts'
```

### Managing the bot (tmux)

```bash
# View bot logs (attach to tmux session)
tmux attach -t bot

# Inside tmux:
#   Ctrl+C        — stop the bot
#   bun main.ts   — start the bot again
#   Ctrl+B, D     — detach from tmux (bot keeps running)

# Restart without attaching
tmux send-keys -t bot C-c Enter
tmux send-keys -t bot 'bun main.ts' Enter

# Check if the bot process is running
ps aux | grep 'bun main.ts' | grep -v grep
```

### Using systemd (without Docker)

```bash
sudo tee /etc/systemd/system/claude-bot.service > /dev/null <<EOF
[Unit]
Description=Claude Telegram Bot
After=network.target postgresql.service

[Service]
Type=simple
User=your_user
WorkingDirectory=/path/to/multiclaude-tg-bot
ExecStart=/path/to/.bun/bin/bun main.ts
Restart=always
RestartSec=5
EnvironmentFile=/path/to/multiclaude-tg-bot/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now claude-bot

# Managing with systemd:
sudo systemctl status claude-bot    # check status
sudo systemctl restart claude-bot   # restart
sudo systemctl stop claude-bot      # stop
sudo journalctl -u claude-bot -f    # view logs
```

## Database Backup

Daily backups with rotation (keeps last 7):

```bash
# Run manually
./scripts/backup-db.sh

# Set up daily cron (3 AM)
crontab -e
# Add: 0 3 * * * /path/to/multiclaude-tg-bot/scripts/backup-db.sh
```

Backups are saved to `~/backups/claude-bot/` as gzipped SQL dumps.

## Knowledge Base (optional)

If you have a directory with an `AGENTS.md` file containing skills and rules catalogs, you can connect it to the bot for `/skills` and `/rules` commands.

Add to `.env`:
```
KNOWLEDGE_BASE=/app/knowledge-base
KNOWLEDGE_BASE_PATH=/path/to/your/knowledge-base
```

And uncomment the volume mount in `docker-compose.yml` or set `KNOWLEDGE_BASE_PATH` to your directory. The `AGENTS.md` file should follow the format with `## Skills Catalog` and `## Core Rule Catalog` sections.

Without these variables, `/skills` and `/rules` commands are disabled.

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
