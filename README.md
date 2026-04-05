# Claude Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Build](https://github.com/MrCipherSmith/multiclaude-tg-bot/actions/workflows/build.yml/badge.svg)](https://github.com/MrCipherSmith/multiclaude-tg-bot/actions)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-3178c6)](https://www.typescriptlang.org)

> **Control Claude Code from Telegram.** Multi-session bot with dual-layer memory, voice transcription, image analysis, and real-time CLI progress monitoring.

Connect multiple Claude Code CLI instances to a single Telegram bot. Switch between projects, send voice messages, approve CLI permissions, and see what Claude is doing — all from your phone.

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/multiclaude-tg-bot/main/install.sh | bash
```

The installer checks prerequisites, clones the repo, installs dependencies, sets up the `claude-bot` CLI, and launches the setup wizard.

Then connect any project:
```bash
cd your-project && claude-bot connect . --tmux
```

Done. Open Telegram, type `/sessions` — your project is there.

<!-- TODO: Add screenshots/GIF showing: /sessions list, voice transcription, CLI progress status, permission buttons -->

## Why MCP?

This bot is a full **[Model Context Protocol](https://modelcontextprotocol.io) server**. Claude Code CLI connects to it via MCP — the same protocol used by VS Code, Cursor, and other AI tools.

**What this means:**
- Any Claude Code instance (terminal, VS Code, SSH) can connect and receive Telegram messages
- The bot exposes MCP tools: `reply`, `remember`, `recall`, `update_status` — Claude uses them like native capabilities
- Permission requests flow through MCP channel protocol — approve Bash/Read/Edit from your phone
- Multiple CLIs share the same memory and session state through the MCP server

**For agent builders:** This bot can serve as a human-in-the-loop interface for any MCP-compatible agent system. Send tasks from Telegram, approve actions, monitor progress.

## Features

### Core
- **Multi-Session MCP Server** — multiple Claude Code CLI instances connect via HTTP, each as a named session
- **Session Switching** — `/switch` between CLI sessions and standalone mode, with context summary and last messages
- **One Session Per Project** — reconnecting CLIs reuse existing sessions, preserving ID and memory
- **Channel Adapter** — stdio bridge that forwards Telegram messages to Claude Code as channel notifications, with session lock retry, advisory locking, and graceful shutdown on stdin close
- **Auto-Named Sessions** — CLI sessions automatically named after the project directory, with source labels (tmux/cli)

### AI & Media
- **Standalone Mode** — bot responds directly via LLM API (Anthropic / OpenRouter / Ollama)
- **Voice Messages** — transcription via Groq whisper-large-v3 (free, ~200ms) with local Whisper fallback
- **Image Analysis** — photos analyzed by Claude in CLI sessions; standalone mode with Anthropic API
- **Auto-Summarization** — idle conversations are summarized to long-term memory after 15 min

### Memory
- **Short-Term** — sliding window of recent messages per session (in-memory cache + PostgreSQL)
- **Long-Term** — semantic search via pgvector embeddings powered by Ollama (nomic-embed-text, 768 dims)
- **Project-Scoped** — memories are shared across all sessions in the same project directory
- **Cross-Session History** — new CLI sessions automatically load prior conversation context from previous sessions in the same project
- **Auto-Summarization** — conversations are summarized on session disconnect and after 15 min idle

### Telegram UX
- **Markdown Rendering** — responses formatted with HTML (bold, italic, code blocks with syntax highlighting, links)
- **Live Status Updates** — real-time progress from CLI via tmux monitoring ("Explore: Find files", "Bash: git status")
- **Permission Forwarding** — CLI permission requests as inline buttons (Allow / Always / Deny), with input preview (file path + syntax-highlighted diff), synced with terminal
- **Auto-Approve Permissions** — configure allowed tools in `settings.local.json` (`permissions.allow` patterns like `"Edit(*)"`, `"Bash(*)"`) to skip Telegram approval for trusted operations
- **Statistics & Logging** — `/stats` for API usage and tokens, `/logs` for per-session request logs

### Operations
- **Health Endpoint** — `GET /health` with DB status, uptime, active sessions
- **Auto-Cleanup** — hourly cleanup of old queue messages, logs, stats, and all disconnected sessions
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
4. Permission requests forwarded as inline buttons with input preview (file path + syntax-highlighted diff)
5. CLI responds via `reply` → HTML-formatted message in Telegram

**Standalone mode:**
1. Telegram message → compose prompt (short-term context + long-term memory recall)
2. Stream LLM response with periodic message edits
3. Final edit applies Markdown → HTML formatting
4. Auto-summarization after 15 min inactivity

**Session switching while CLI is working:**
Background sessions prefix messages with `[session-name]` so you can distinguish sources.

## Installation

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/multiclaude-tg-bot/main/install.sh | bash
```

This will check prerequisites, clone the repo to `~/bots/claude-bot`, install dependencies, set up the `claude-bot` CLI globally, and launch the setup wizard.

Custom install directory:
```bash
CLAUDE_BOT_DIR=~/my-bot curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/multiclaude-tg-bot/main/install.sh | bash
```

### Manual Install

```bash
git clone https://github.com/MrCipherSmith/multiclaude-tg-bot.git ~/bots/claude-bot
cd ~/bots/claude-bot
bun install
ln -sf ~/bots/claude-bot/cli.ts ~/.local/bin/claude-bot
claude-bot setup
```

### Prerequisites

| Dependency | Required | Install |
|---|---|---|
| **Bun** | Yes | `curl -fsSL https://bun.sh/install \| bash` |
| **Docker** | Yes | [docs.docker.com/engine/install](https://docs.docker.com/engine/install/) |
| **Git** | Yes | `apt install git` / `brew install git` |
| **Claude Code** | For CLI sessions | `npm install -g @anthropic-ai/claude-code` |
| **Ollama** | For embeddings | [ollama.com/download](https://ollama.com/download) |

<details>
<summary><strong>Ubuntu / Debian</strong></summary>

```bash
# Bun
curl -fsSL https://bun.sh/install | bash

# Docker
sudo apt update && sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER && newgrp docker

# Ollama
curl -fsSL https://ollama.com/install.sh | sh
ollama pull nomic-embed-text

# Claude Code (optional)
npm install -g @anthropic-ai/claude-code
```

</details>

<details>
<summary><strong>macOS</strong></summary>

```bash
# Bun
curl -fsSL https://bun.sh/install | bash

# Docker
brew install --cask docker   # Docker Desktop

# Ollama
brew install ollama
ollama pull nomic-embed-text

# Claude Code (optional)
npm install -g @anthropic-ai/claude-code
```

</details>

<details>
<summary><strong>Arch Linux</strong></summary>

```bash
sudo pacman -S bun docker docker-compose git
sudo systemctl enable --now docker
sudo usermod -aG docker $USER && newgrp docker

# Ollama
curl -fsSL https://ollama.com/install.sh | sh
ollama pull nomic-embed-text
```

</details>

### Setup Wizard

Run `claude-bot setup` (or the installer runs it automatically). The wizard asks:

```
Deployment type:
❯ 1. Docker (recommended — PostgreSQL included)
  2. Manual (PostgreSQL + Ollama already installed)
```

Choose **Docker** unless you already have PostgreSQL running.

```
Telegram Bot Token (from @BotFather): 7123456789:AAF...
```

Create a bot via [@BotFather](https://t.me/BotFather) in Telegram: `/newbot` → pick a name → copy the token.

```
Your Telegram User ID: 123456789
```

Get your ID from [@userinfobot](https://t.me/userinfobot): send `/start` → it replies with your numeric ID.

```
LLM Provider for standalone mode:
❯ 1. Anthropic (best quality, requires API key)
  2. OpenRouter (free models available)
  3. Ollama (local, free)
```

This is for **standalone mode** (when no CLI session is active). Choose **OpenRouter** for free or **Ollama** for fully local.

```
Groq API Key for voice (Enter to skip, free at console.groq.com):
```

Optional. Enables fast voice transcription (~200ms). Get a free key at [console.groq.com](https://console.groq.com). Skip if you don't need voice messages.

```
PostgreSQL password [claude_bot_secret]:
Bot port [3847]:
```

Press Enter to accept defaults. The wizard then:
1. Creates `.env` with all settings
2. Installs dependencies
3. Starts Docker containers (PostgreSQL + bot)
4. Runs database migrations
5. Registers MCP servers in Claude Code
6. Sets up global `CLAUDE.md`

### Usage Scenarios

#### Laptop (single project)

The simplest setup — run everything locally, connect one project at a time:

```bash
# 1. Start the bot (if not already running)
claude-bot start

# 2. Open your project and connect
cd ~/my-project
claude-bot connect .
```

That's it. Open Telegram, type `/sessions` — your project is there. Send messages, voice, photos — Claude CLI processes them in the terminal.

You can stop the session with `Ctrl+C` and connect a different project at any time.

> **Note:** Without `--tmux`, you won't see real-time status updates in Telegram, but everything else works — messages, permissions, replies.

#### Laptop with tmux (single project, full monitoring)

Same as above, but with live progress monitoring in Telegram:

```bash
claude-bot start
cd ~/my-project
claude-bot connect . --tmux
```

Telegram will show what Claude is doing in real-time ("Reading files...", "Running tests...", etc.).

#### Server (multiple projects, always-on)

For headless servers where you want multiple projects running 24/7:

```bash
# Add your projects
claude-bot add ~/project-a
claude-bot add ~/project-b
claude-bot add ~/project-c

# Start all at once in tmux (separate windows)
claude-bot up -a

# Or all visible at once as split panes
claude-bot up -a -s
```

Each project runs in its own tmux window (or pane with `-s`) with auto-restart. Connect via SSH anytime:

```bash
ssh user@server -t "tmux attach -t claude"
```

Manage projects:

```bash
claude-bot ps                     # List configured projects
claude-bot up -a                  # Start all + attach (windows)
claude-bot up -a -s               # Start all + attach (split panes)
claude-bot down                   # Stop all + clean DB
claude-bot remove project-b       # Remove from config
```

**Tmux navigation** (press `Ctrl+B`, release, then the key):

| Mode | Key | Action |
|---|---|---|
| Windows | `N` / `P` | Next / previous window |
| Windows | `W` | List all windows |
| Windows | `0-9` | Jump to window by number |
| Panes | `Arrow` | Move to adjacent pane |
| Panes | `Z` | Zoom current pane (toggle fullscreen) |
| Panes | `Q` + digit | Jump to pane by number |
| Both | `D` | Detach from tmux |

#### Remote (laptop → server)

Run the bot on a server, connect from your laptop via SSH tunnel:

```bash
# On your laptop:
claude-bot remote
```

The wizard will guide you through SSH tunnel setup and MCP registration.

### CLI Commands

```
Setup:
  claude-bot setup              Interactive installation wizard
  claude-bot remote             Connect laptop to remote server
  claude-bot mcp-register       Re-register MCP servers

Manage:
  claude-bot start / stop       Docker + tmux up/down
  claude-bot restart            Rebuild and restart bot
  claude-bot status             Bot health, uptime, docker status
  claude-bot logs               Follow bot logs

Data:
  claude-bot sessions           List active sessions
  claude-bot prune              Remove stale sessions (interactive)
  claude-bot backup             Database backup
  claude-bot cleanup            Clean old queue, logs, stats

Tmux:
  claude-bot up [-a] [-s]       Start all projects in tmux (-s split panes)
  claude-bot down               Stop all tmux sessions + clean DB
  claude-bot ps                 List configured projects
  claude-bot add [dir] [--name]  Add project to config (custom name)
  claude-bot remove <name>      Remove project from config

Connect:
  claude-bot connect [dir] -t   Start single CLI session in tmux
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| **Sessions** | |
| `/start` | Welcome message and quick help |
| `/help` | Show available commands |
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
claude-bot stop       # tmux down + docker compose down
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

- [x] Vision model support for image analysis in standalone mode
- [ ] Webhook mode for Telegram (instead of polling)
- [ ] Web dashboard for statistics and session management
- [ ] Stream-json output parsing for non-tmux progress monitoring
- [ ] Multi-user support with separate session namespaces
- [ ] Inline mode — respond in any Telegram chat via @bot

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push and open a Pull Request

For bug reports and feature requests, use [GitHub Issues](https://github.com/MrCipherSmith/multiclaude-tg-bot/issues).

## License

[MIT](LICENSE)
