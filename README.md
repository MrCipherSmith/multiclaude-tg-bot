# Claude Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Build](https://github.com/MrCipherSmith/multiclaude-tg-bot/actions/workflows/build.yml/badge.svg)](https://github.com/MrCipherSmith/multiclaude-tg-bot/actions)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-3178c6)](https://www.typescriptlang.org)

> **Control Claude Code from Telegram.** Multi-session bot with dual-layer memory, voice transcription, image analysis, and real-time CLI progress monitoring.

Connect multiple Claude Code CLI instances to a single Telegram bot. Switch between projects, send voice messages, approve CLI permissions, and see what Claude is doing — all from your phone.

<!-- TODO: Add screenshot or GIF of bot in action -->

## Features

### Core
- **Multi-Session MCP Server** — multiple Claude Code CLI instances connect via HTTP, each as a named session
- **Session Switching** — `/switch` between CLI sessions and standalone mode, with context summary and last messages
- **One Session Per Project** — reconnecting CLIs reuse existing sessions, preserving ID and memory
- **Channel Adapter** — stdio bridge that forwards Telegram messages to Claude Code as channel notifications

### AI & Media
- **Standalone Mode** — bot responds directly via LLM API (Anthropic / OpenRouter / Ollama)
- **Voice Messages** — transcription via Groq whisper-large-v3 (free, ~200ms) with local Whisper fallback
- **Image Analysis** — photos analyzed by Claude in CLI sessions; standalone mode with Anthropic API
- **Auto-Summarization** — idle conversations are summarized to long-term memory after 15 min

### Memory
- **Short-Term** — sliding window of recent messages per session (in-memory cache + PostgreSQL)
- **Long-Term** — semantic search via pgvector embeddings powered by Ollama (nomic-embed-text, 768 dims)
- **Per-Session Binding** — memories are scoped to the session that created them

### Telegram UX
- **Markdown Rendering** — responses formatted with HTML (bold, italic, code blocks with syntax highlighting, links)
- **Live Status Updates** — real-time progress from CLI via tmux monitoring ("Explore: Find files", "Bash: git status")
- **Permission Forwarding** — CLI permission requests as inline buttons (Allow / Always / Deny), synced with terminal
- **Statistics & Logging** — `/stats` for API usage and tokens, `/logs` for per-session request logs

### Operations
- **Health Endpoint** — `GET /health` with DB status, uptime, active sessions
- **Auto-Cleanup** — hourly cleanup of old queue messages, logs, and stats
- **CLI Tool** — interactive setup wizard, session management, backup, monitoring
- **Docker-First** — bot + PostgreSQL in Docker Compose, Ollama on host

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

### Message Flows

**CLI mode:**
1. Telegram message → bot saves to `messages` + inserts into `message_queue`
2. `channel.ts` polls queue → sends channel notification to Claude CLI
3. Status message appears in Telegram with live timer and tmux progress
4. Permission requests forwarded as inline buttons (Allow / Always / Deny)
5. CLI responds via `reply` → HTML-formatted message in Telegram

**Standalone mode:**
1. Telegram message → compose prompt (short-term context + long-term memory recall)
2. Stream LLM response with periodic message edits
3. Final edit applies Markdown → HTML formatting
4. Auto-summarization after 15 min inactivity

**Session switching while CLI is working:**
Background sessions prefix messages with `[session-name]` so you can distinguish sources.

## Quick Start

```bash
git clone https://github.com/MrCipherSmith/multiclaude-tg-bot.git
cd multiclaude-tg-bot
bun install
bun cli.ts setup
```

The interactive wizard configures everything: Telegram token, LLM provider, Docker services, MCP registration, CLAUDE.md.

### Connect a Project

```bash
cd /path/to/your-project
claude-bot connect . --tmux
```

The session appears in Telegram `/sessions`. Send messages, voice, photos — Claude CLI processes them.

### CLI Commands

```bash
claude-bot status             # Bot health, uptime, docker status
claude-bot sessions           # List active sessions
claude-bot logs               # Follow bot logs
claude-bot start / stop       # Docker compose up/down
claude-bot restart            # Rebuild and restart
claude-bot backup             # Database backup
claude-bot prune              # Remove stale sessions (interactive)
claude-bot cleanup            # Clean old queue, logs, stats
claude-bot connect [dir] -t   # Start CLI in tmux (recommended)
claude-bot remote             # Connect laptop to remote server
claude-bot mcp-register       # Re-register MCP servers
```

Install the `claude-bot` command:
```bash
ln -sf /path/to/multiclaude-tg-bot/claude-bot ~/.local/bin/claude-bot
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| **Sessions** | |
| `/sessions` | List all sessions |
| `/switch [id]` | Switch session (shows context + last messages) |
| `/session` | Current session info |
| `/standalone` | Switch to standalone mode |
| `/rename <id> <name>` | Rename a session |
| `/remove <id>` | Delete session and all its data |
| `/cleanup` | Remove disconnected and orphaned sessions |
| **Memory** | |
| `/remember [text]` | Save to long-term memory (bound to session) |
| `/recall [query]` | Semantic search through memory |
| `/memories` | List recent memories |
| `/forget [id]` | Delete a memory |
| `/summarize` | Force conversation summarization |
| `/clear` | Clear current session context |
| **Monitoring** | |
| `/stats` | API usage, tokens, transcriptions, per session |
| `/logs [id]` | Request logs for session |
| `/status` | Bot health (DB, Ollama, counts) |
| `/pending` | Pending CLI permission requests |
| **Tools & Knowledge** | |
| `/tools` | Available MCP tools |
| `/skills` | Skills catalog from knowledge base |
| `/rules` | Coding rules from knowledge base |

## MCP Tools

### HTTP Server (port 3847)

| Tool | Description |
|------|-------------|
| `remember` | Save to long-term memory with semantic embedding |
| `recall` | Semantic search through memories |
| `forget` / `list_memories` | Manage memories |
| `reply` | Send message to Telegram chat |
| `react` | Set emoji reaction |
| `edit_message` | Edit bot's message |
| `list_sessions` / `session_info` | Session management |
| `set_session_name` | Name the current session |

### Channel Adapter (stdio, per-session)

| Tool | Description |
|------|-------------|
| `reply` | Send to Telegram with HTML rendering |
| `update_status` | Update live status message |
| `remember` / `recall` / `forget` / `list_memories` | Direct DB memory access |

### Health Endpoint

```
GET http://localhost:3847/health
→ { "status": "ok", "db": "connected", "uptime": 3600, "sessions": 5 }
```

## Setup Guide

### Docker (recommended)

```bash
cp .env.example .env    # Edit with your tokens
docker compose up -d    # Starts PostgreSQL + bot
```

Requires [Ollama](https://ollama.ai) on host:
```bash
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull nomic-embed-text
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | From [@BotFather](https://t.me/BotFather) |
| `ALLOWED_USERS` | Yes | Comma-separated Telegram user IDs |
| `ANTHROPIC_API_KEY` | No | Anthropic API (best quality standalone) |
| `OPENROUTER_API_KEY` | No | OpenRouter API (free models available) |
| `OLLAMA_CHAT_MODEL` | No | Local Ollama model (default: `qwen3:8b`) |
| `GROQ_API_KEY` | No | Voice transcription ([free](https://console.groq.com)) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `OLLAMA_URL` | Yes | Ollama API URL |
| `PORT` | No | Bot port (default: `3847`) |
| `KNOWLEDGE_BASE` | No | Path to knowledge base for `/skills` and `/rules` |

### Manual Setup (without Docker)

Prerequisites: [Bun](https://bun.sh), PostgreSQL 16+ with [pgvector](https://github.com/pgvector/pgvector), [Ollama](https://ollama.ai)

```bash
# Database
psql -U postgres -c "CREATE USER claude_bot WITH PASSWORD 'your_password';"
psql -U postgres -c "CREATE DATABASE claude_bot OWNER claude_bot;"
psql -U postgres -d claude_bot -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Install and run
bun install
cp .env.example .env   # Configure
bun start              # or: bun dev (with auto-reload)
```

### CLAUDE.md Configuration

Add to your project or `~/.claude/CLAUDE.md`:

```markdown
## MCP Integration
When starting a session, call `set_session_name` with:
- name: basename of the current working directory
- project_path: absolute path to the current working directory

## Telegram Status Updates
When responding to Telegram channel messages, call `update_status` before each major step.
```

See [CLAUDE_MD_GUIDE.md](CLAUDE_MD_GUIDE.md) for detailed configuration options.

### Remote Connection (laptop to server)

```bash
claude-bot remote    # Interactive wizard
```

Or manually via SSH tunnel:
```bash
ssh -L 3847:localhost:3847 -L 5433:localhost:5433 user@server
claude-bot connect . --tmux
```

## Production

### Docker Compose
```bash
claude-bot start      # docker compose up -d
claude-bot restart    # rebuild and restart
claude-bot logs       # follow logs
claude-bot stop       # docker compose down
```

### Database Backup
```bash
claude-bot backup     # manual backup
# Or schedule: 0 3 * * * /path/to/scripts/backup-db.sh
```

Backups saved to `~/backups/claude-bot/` (gzipped, last 7 retained).

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | [Bun](https://bun.sh) |
| Telegram | [grammY](https://grammy.dev) |
| AI SDK | [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) |
| MCP | [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) |
| Database | PostgreSQL 16 + [pgvector](https://github.com/pgvector/pgvector) |
| Embeddings | [Ollama](https://ollama.ai) (nomic-embed-text) |
| Voice | [Groq](https://console.groq.com) (whisper-large-v3) |
| DB Client | [postgres](https://github.com/porsager/postgres) |

## Roadmap

- [ ] Vision model support for image analysis in standalone mode
- [ ] Webhook mode for Telegram (instead of polling)
- [ ] Web dashboard for statistics and session management
- [ ] Stream-json output parsing for non-tmux terminals
- [ ] Multi-user support with separate session namespaces

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push and open a Pull Request

For bug reports and feature requests, use [GitHub Issues](https://github.com/MrCipherSmith/multiclaude-tg-bot/issues).

## License

[MIT](LICENSE)
