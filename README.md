# Claude Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Build](https://github.com/MrCipherSmith/multiclaude-tg-bot/actions/workflows/build.yml/badge.svg)](https://github.com/MrCipherSmith/multiclaude-tg-bot/actions)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-3178c6)](https://www.typescriptlang.org)

[Dashboard](examples/dashboard.md) | [Usage Patterns](examples/usage-patterns.md) | [Cloudflare Tunnel](guides/cloudflare-tunnel-setup.md) | [Remote Laptop Setup](guides/remote-laptop-setup.md) | [CLAUDE.md Guide](CLAUDE_MD_GUIDE.md)

> **Control Claude Code from Telegram.** Multi-session bot with persistent projects, dual-layer memory, voice transcription, image analysis, and real-time CLI progress monitoring.

Connect multiple Claude Code CLI instances to a single Telegram bot. Switch between projects with automatic context briefing, send voice messages, approve CLI permissions, and see what Claude is doing — all from your phone.

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

### Dashboard

![Overview](examples/screenshots/overview.jpg)
![Stats](examples/screenshots/stats.jpg)

See all dashboard pages: [Overview, Sessions, Stats, Logs, Memory](examples/dashboard.md)

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
- **Standalone Mode** — bot responds directly via LLM API (Anthropic / Google AI / OpenRouter / Ollama) with automatic retry on 429/5xx
- **Voice Messages** — transcription via Groq whisper-large-v3 (free, ~200ms) with local Whisper fallback
- **Image Analysis** — photos analyzed by Claude in CLI sessions; standalone mode with Anthropic API
- **Auto-Summarization** — idle conversations are summarized to long-term memory after 15 min

### Session Lifecycle
- **Persistent Projects** — `projects` table as permanent registry; added via `/project_add`, never deleted
- **Remote Sessions** — one persistent session per project (`source=remote`), started/stopped from bot or terminal; status: 🟢 active / ⚪ inactive
- **Local Sessions** — temporary, multiple per project, live while Claude process runs; on exit: work summary generated and archived; deletable from Telegram bot (`/sessions`) or dashboard
- **Work Summary on Exit** — AI-optimized structured summary ([DECISIONS][FILES][PROBLEMS][PENDING][CONTEXT]) vectorized and saved to long-term memory; raw messages archived with TTL
- **Switch Briefing** — switching to a session shows its last project-context summary and injects it as system context for the next message

### Memory
- **Short-Term** — sliding window of recent messages per session (in-memory cache + PostgreSQL)
- **Long-Term** — semantic search via pgvector embeddings powered by Ollama (nomic-embed-text, 768 dims)
- **Smart Reconciliation** — `/remember` and work summaries use LLM-based deduplication: new facts are compared against similar existing memories and the system decides ADD / UPDATE / DELETE / NOOP instead of always inserting
- **Project-Scoped** — memories and project context shared across all sessions in the same project
- **Cross-Session History** — new CLI sessions automatically load prior conversation context from previous sessions in the same project
- **Auto-Summarization** — remote session conversations summarized on idle/overflow; messages archived with configurable TTL (default 30 days)

### Telegram UX
- **Markdown Rendering** — responses formatted with HTML (bold, italic, code blocks with syntax highlighting, links)
- **Live Status Updates** — real-time progress from CLI via tmux monitoring ("Explore: Find files", "Bash: git status")
- **Permission Forwarding** — CLI permission requests as inline buttons (Allow / Always / Deny), with input preview (file path + syntax-highlighted diff), synced with terminal
- **Auto-Approve Permissions** — configure allowed tools in `settings.local.json` (`permissions.allow` patterns like `"Edit(*)"`, `"Bash(*)"`) to skip Telegram approval for trusted operations
- **Statistics & Logging** — `/stats` for API usage and tokens, `/logs` for per-session request logs
- **Web Dashboard** — real-time stats (by provider, project, operation, session), token charts, cost estimation, error drill-down with slide panel, log viewer with full message detail; **Projects page** for creating, starting, and stopping projects from the browser
- **Telegram Mini App** — mobile WebApp (Dev Hub button) with git browser (files/log/status/diffs), permission manager (Allow/Deny/Always), and session monitor; auto-themed to Telegram's light/dark mode

### Operations
- **Health Endpoint** — `GET /health` with DB status, uptime, active sessions
- **Auto-Cleanup** — hourly cleanup of old queue messages, logs, stats, and all disconnected sessions
- **CLI Tool** — interactive setup wizard, session management, backup, monitoring
- **Docker-First** — bot + PostgreSQL in Docker Compose, Ollama on host

## Architecture

```
                          ┌──────────────────────────────────────────────────┐
                          │      Host / Laptop / Any terminal                │
                          │                                                  │
  ┌─────────────┐ stdio   │  ┌───────────┐  ┌───────────┐  ┌───────────┐   │
  │ channel.ts  │◀═══════▶│  │ Claude CLI│  │ Claude CLI│  │ Claude CLI│   │
  │ (per-session│  MCP    │  │ project-a │  │ project-b │  │ general   │   │
  │  adapter)   │         │  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  │
  └──────┬──────┘         │        │   Bash/Read/Edit/Write       │         │
         │ polls           │        ▼              ▼              ▼          │
         │ message_queue   │  ┌──────────────────────────────────────────┐   │
         │                 │  │           Project Files (host)           │   │
         │                 │  └──────────────────────────────────────────┘   │
         │                 │                                                  │
         │                 └──────────────────────────────────────────────────────┘
         │                            ▲
         │                 ┌──────────┴───────────────────────────────────────┐
         │                 │              Docker                              │
         │  direct DB      │                                                  │
         ├────────────────▶│  ┌──────────────────────────────────────────┐   │
         │                 │  │  Bot (main.ts)                    :3847  │   │
         │                 │  │                                          │   │
         │                 │  │  Telegram polling ◀──▶ Telegram API      │   │
         │                 │  │  HTTP MCP server  ◀──▶ Claude CLIs      │   │
         │                 │  │                                          │   │
         │                 │  │  adapters/                               │   │
         │                 │  │  └─ ClaudeAdapter → message_queue        │   │
         │                 │  │                                          │   │
         │                 │  │  sessions/router.ts (standalone/cli/disc)│   │
         │                 │  │  Standalone LLM   ──▶ Google AI/Openrtr  │   │
         │                 │  │  Voice transcribe ──▶ Groq API           │   │
         │                 │  │  Markdown → HTML  ──▶ Telegram           │   │
         │                 │  │  /health, /stats, cleanup timers         │   │
         │                 │  └──────────────┬────────────────────────────┘  │
         │                 │                 │                                │
         │                 │                 ▼                                │
         │                 │  ┌──────────────────────────────────────────┐   │
         │                 │  │  PostgreSQL + pgvector            :5433  │   │
         │                 │  │                                          │   │
         │                 │  │  sessions (cli_type, cli_config)         │   │
         │                 │  │  message_queue      permission_requests  │   │
         │                 │  │  messages           api_request_stats    │   │
         │                 │  │  memories (vector)  transcription_stats  │   │
         │                 │  │  chat_sessions      request_logs         │   │
         │                 │  └──────────────────────────────────────────┘   │
         │                 └──────────────────────────────────────────────────┘
         │
         │                 ┌───────────────────────┐
         └────────────────▶│  Ollama (host)  :11434│
                           │  nomic-embed-text     │
               embeddings  │  (768 dims)           │
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
  2. Google AI (Gemma 4 models, free tier available)
  3. OpenRouter (many models, free & paid)
  4. Ollama (local, free)
```

This is for **standalone mode** (when no CLI session is active). Choose **Google AI** for Gemma 4 models, **OpenRouter** for variety, or **Ollama** for fully local.

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
claude-bot docker-start

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
claude-bot docker-start
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
ssh user@server -t "tmux attach -t bots"
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

See [Remote Laptop Setup](guides/remote-laptop-setup.md) for a full walkthrough of both connection methods (SSH tunnel and HTTP-only), manual setup steps, and troubleshooting.

### CLI Commands

```
Setup:
  claude-bot setup              Interactive installation wizard
  claude-bot remote             Connect laptop to remote server
  claude-bot mcp-register       Re-register MCP servers

Manage:
  claude-bot docker-start       Start Docker containers (docker compose up -d)
  claude-bot stop               Stop Docker + tmux
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
  claude-bot add [dir] [--name] [--provider]  Register project in config + bot DB (no launch)
  claude-bot run [dir]              Launch project in current terminal
  claude-bot attach [dir]           Add window to running tmux session (bots)
  claude-bot remove <name>          Remove project from config

Connect:
  claude-bot start [dir]            Launch Claude Code in current terminal
  claude-bot connect [dir] [-t]     Start single CLI session
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| **Sessions** | |
| `/start` | Welcome message and quick help |
| `/help` | Show available commands |
| `/sessions` | List all sessions (🟢 active / ⚪ inactive / 💀 terminated) |
| `/switch [id]` | Switch session — shows project context briefing + last messages |
| `/session` | Current session info |
| `/standalone` | Switch to standalone mode |
| `/rename <id> <name>` | Rename a session |
| `/remove <id>` | Delete session and all its data |
| `/cleanup` | Remove terminated and orphaned sessions |
| **Projects** | |
| `/projects` | List projects with status and Start/Stop buttons |
| `/project_add` | Add project to persistent registry (creates remote session) |
| `/remote_control` | tmux bots status with Kill/Start/Refresh controls |
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
| `/skills` | Skills catalog — inline buttons with descriptions, click to run |
| `/commands` | Custom commands — inline buttons, click to execute |
| `/hooks` | Configured Hookify rules (event matchers + commands) |
| `/rules` | Coding rules from knowledge base |
| `/add` | Register project as Claude Code session (prompts for path if not in session) |
| `/model` | Select Claude model for current session (inline buttons) |

## Skills, Commands & Hooks

The bot integrates with your local Claude Code configuration:

### `/skills` — AI Assistant Skills
Displays all skills from `~/.claude/skills/` (e.g., `code-review`, `feature-dev`, `deploy`).

- **Inline buttons** with skill name and short description
- **Click to run** — no-args skills execute immediately, args-required skills prompt for input
- **Scanned from**: `HOST_CLAUDE_CONFIG` (docker mount of ~/.claude)
- **Example skills**: code-ai-review, feature-analyzer, job-orchestrator, task-implementer, etc.

### `/commands` — Custom Commands
Displays commands from `~/.claude/commands/*.md` with YAML frontmatter.

Example command file (`~/.claude/commands/my-review.md`):
```markdown
---
description: "Run full code review with fixes"
args: "optional"
---
# My Review Script
...
```

- **Callback routing** — click button → `cmd:<name>` callback
- **Deferred input** — if args required, bot prompts user then enqueues on next message
- **5-minute timeout** for pending input

### `/hooks` — Hookify Rules
Lists configured hooks from `settings.json`:
```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "matcher": "Bash.*npm",
      "command": "echo 'Running npm...'"
    }
  ]
}
```

**Events supported:**
- `PreToolUse` — before any tool runs
- `PostToolUse` — after any tool completes
- `Stop` — when agent stops
- `Notification` — on bot notification

## Session Management

### `/add` — Register Project

Register a directory as a Claude Code session. If you're in an active session, the project path is auto-detected. Otherwise the bot prompts for the path.

Registered sessions are immediately switchable via `/switch`. To launch the Claude Code CLI, use `claude-bot start <path>` from the terminal.

### `/model` — Select Model

Shows inline keyboard with available Claude models (opus/sonnet/haiku). Selected model stored in `cli_config.model` on the session and passed to Claude Code on next launch.

### Adapter Architecture

The bot uses a registry-based adapter pattern (`adapters/`):

```
CliAdapter interface
└── ClaudeAdapter — message_queue INSERT → channel.ts picks up → MCP notify
```

Adapters are registered at startup (`adapters/index.ts`). The `sessions/router.ts` resolves the active session to one of three modes: `standalone`, `cli`, or `disconnected`.

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
| `search_project_context` | Semantic search over project work summaries and prior session context |

### Channel Adapter (stdio, per-session)

| Tool | Description |
|------|-------------|
| `reply` | Send to Telegram with HTML rendering |
| `update_status` | Update live status message |
| `remember` / `recall` / `forget` / `list_memories` | Direct DB memory access |
| `search_project_context` | Semantic search over long-term project context |

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
| `GOOGLE_AI_API_KEY` | No | Google AI API ([aistudio.google.com](https://aistudio.google.com/apikey)) |
| `GOOGLE_AI_MODEL` | No | Google AI model (default: `gemma-4-31b-it`) |
| `OPENROUTER_API_KEY` | No | OpenRouter API (many models available) |
| `OLLAMA_CHAT_MODEL` | No | Local Ollama model (default: `qwen3:8b`) |
| `GROQ_API_KEY` | No | Voice transcription ([free](https://console.groq.com)) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `POSTGRES_PASSWORD` | Yes | PostgreSQL password (required in docker-compose) |
| `OLLAMA_URL` | Yes | Ollama API URL |
| `PORT` | No | Bot port (default: `3847`) |
| `JWT_SECRET` | No | JWT signing secret (auto-derived from bot token if not set) |
| `SECURE_COOKIES` | No | Force Secure flag on cookies (`true`/`false`, auto-detected) |
| `KNOWLEDGE_BASE` | No | Path to knowledge base for `/skills` and `/rules` |
| `HOST_CLAUDE_CONFIG` | No | Mount point for ~/.claude in Docker (default: `/host-claude-config`) |
| `ARCHIVE_TTL_DAYS` | No | Days before archived messages/permissions are deleted (default: `30`) |
| `MEMORY_SIMILARITY_THRESHOLD` | No | Cosine distance threshold for memory reconciliation (default: `0.35`) |
| `MEMORY_RECONCILE_TOP_K` | No | Number of similar memories checked before LLM reconciliation (default: `5`) |
| `MEMORY_TTL_FACT_DAYS` | No | Retention days for `fact` memories (default: `90`) |
| `MEMORY_TTL_SUMMARY_DAYS` | No | Retention days for `summary` memories (default: `60`) |
| `MEMORY_TTL_DECISION_DAYS` | No | Retention days for `decision` memories (default: `180`) |
| `MEMORY_TTL_NOTE_DAYS` | No | Retention days for `note` memories (default: `30`) |
| `MEMORY_TTL_PROJECT_CONTEXT_DAYS` | No | Retention days for `project_context` memories (default: `180`) |

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

See [CLAUDE_MD_GUIDE.md](CLAUDE_MD_GUIDE.md) for detailed configuration options and [Usage Patterns](examples/usage-patterns.md) for practical examples (status updates, sub-agent progress trees, file diffs, memory).

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
claude-bot docker-start   # docker compose up -d
claude-bot restart        # rebuild and restart
claude-bot logs           # follow logs
claude-bot stop           # tmux down + docker compose down
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
| Dashboard | [React](https://react.dev) + [Tailwind CSS](https://tailwindcss.com) + [Vite](https://vite.dev) |

## Recent Changes (v1.13.0)

### Telegram Mini App — Claude Dev Hub

A mobile-first WebApp embedded in the bot, accessible via the **Dev Hub** menu button in Telegram.

**Git Browser (📁):**
- Hierarchical file tree with collapsible folders (sorted: dirs first, then files alphabetically)
- File icons by extension (VSCode Material style — TS/JS/JSON/MD/PY/GO/RS + emoji for special files)
- Current branch displayed in header (⎇ branch-name)
- Live search/filter — matches anywhere in path, auto-expands matching folders
- File viewer with syntax highlighting via `highlight.js` (12 languages), line numbers, dark theme
- Commit log (`git log`) with author, relative date, short hash, one-click diff viewer
- Working tree status (`git status`) with status badges (M/A/D/R) and per-file diffs
- Color-coded unified diff view (green add / red remove / blue hunk headers)

**Permission Manager (🔑):**
- Real-time list of pending Claude permission requests (auto-polls every 3s)
- ✅ Allow / ❌ Deny / ♾️ Always Allow per request
- Always Allow writes pattern to `settings.local.json` directly from mobile

**Session Monitor (📊):**
- Live status: Working (pulsing) / Idle / Inactive based on `last_active`
- Session detail: project, source, path, connected time
- Pending permission count at a glance

**Session Sidebar:**
- All sessions listed with source badge (remote/local) and status dot
- **Switch** button — changes the bot's active session for this user (calls `POST /api/sessions/:id/switch`)
- **Delete** button — visible only for `source=local` non-active sessions

**Auth:** Telegram `initData` HMAC-SHA256 verification. JWT returned in response body and sent as `Authorization: Bearer` header on all requests (Telegram WebView does not reliably persist cookies).

**Infrastructure:**
- Separate Vite app (`dashboard/webapp/`) built to `dashboard/webapp/dist/`, served at `/webapp/`
- `/telegram/webapp/*` redirects to `/webapp/*` for BotFather URL compatibility
- `${HOME}:/host-home:ro` Docker volume for git access to host project paths; all git commands use `-c safe.directory=*`
- `webapp-build` Dockerfile stage (parallel to dashboard build); `git` installed in production image
- Full specification: [`dashboard/webapp/SPEC.md`](dashboard/webapp/SPEC.md)

## Recent Changes (v1.12.0)

### Local Session Management

- **Delete local sessions from Telegram** — `/sessions` now shows `🗑 Delete` inline buttons for local sessions that are not active; clicking deletes all session data and refreshes the list
- **Delete local sessions from dashboard** — Sessions table gains a `Delete` action column; button is visible only for `source=local` + non-active rows; uses `useMutation` with query invalidation
- **`source` field in sessions API** — `GET /api/sessions` and `GET /api/overview` now return `source` (`remote` | `local` | `standalone`); added to `Session` TypeScript interface

### Session Source Refactoring (channel.ts)

Three distinct modes now instead of two:

| `CHANNEL_SOURCE` env | Mode | DB behavior |
|---|---|---|
| `remote` | `claude-bot up` / tmux | One persistent session per project; reattaches on reconnect |
| `local` | `claude-bot start` | New temporary session each run; work summary on exit |
| _(not set)_ | Plain `claude` | No DB registration (`sessionId = null`), no polling |

Previously, unset `CHANNEL_SOURCE` defaulted to `local`. Now it is a distinct standalone mode that skips DB entirely — preventing phantom sessions when running `claude` without the bot.

### CLI Changes

- **`claude-bot start`** — no longer invokes `run-cli.sh`; spawns `claude` directly with `CHANNEL_SOURCE=local` (simpler path, no auto-restart loop for local sessions)
- **`claude-bot restart`** — after rebuild, syncs `TELEGRAM_BOT_TOKEN` from `.env` into `~/.claude.json` MCP server config (`syncChannelToken`), so channel auth stays in sync without manual edits
- **`run()` helper** — new `stream: true` option pipes stdout/stderr directly to terminal (used in restart for real-time build output)

## Recent Changes (v1.11.0)

### Dashboard Project Management
- **Projects page** — create, start, and stop projects directly from the web dashboard (previously Telegram-only)
- **SSE notifications** — `GET /api/events` streams `session-state` events to dashboard via Server-Sent Events
- **Browser notifications** — dashboard requests Notification permission and shows push notifications on session state changes
- **Projects API** — `GET/POST /api/projects`, `POST /api/projects/:id/start|stop`, `DELETE /api/projects/:id`

### Memory TTL per Type
- **Per-type retention** — each memory type has its own TTL: `fact` 90d, `summary` 60d, `decision` 180d, `note` 30d, `project_context` 180d
- **Hourly cleanup** — expired memories deleted automatically based on `created_at`
- **Configurable** — override via `MEMORY_TTL_FACT_DAYS`, `MEMORY_TTL_SUMMARY_DAYS`, etc.
- **DB migration v9** — `archived_at` column + partial index on `memories` table

## Recent Changes (v1.10.0)

### Smart Memory Reconciliation
- **LLM deduplication** — `/remember` and work summaries no longer blindly insert; similar memories are found via vector search, then `claude-haiku` decides ADD / UPDATE / DELETE / NOOP
- **Updated replies** — `/remember` now shows `Saved (#N)` / `Updated #N` / `Already known (#N)` based on what actually happened
- **project_context deduplication** — session exit summaries update existing project context instead of accumulating duplicates
- **Graceful fallback** — Ollama or Claude API unavailable → falls back to plain insert, no data loss
- **New config** — `MEMORY_SIMILARITY_THRESHOLD` (default `0.35`) and `MEMORY_RECONCILE_TOP_K` (default `5`)

## Recent Changes (v1.9.0)

### Session Management Redesign
- **Persistent Projects** — `projects` DB table, `/project_add` saves to DB (not JSON file)
- **Remote/Local Sessions** — one remote session per project (persistent), multiple local (temporary per process)
- **Work Summary on Exit** — local session exit triggers AI summary of work done ([DECISIONS][FILES][PROBLEMS][PENDING][CONTEXT]), vectorized to long-term memory
- **Session Switch Briefing** — switching sessions shows last project context summary, injected as system context
- **Semantic Search** — `search_project_context` MCP tool + `search_context` command
- **Archival TTL** — messages and permission_requests archived on summarize, deleted after `ARCHIVE_TTL_DAYS` (default 30)
- **Status vocab** — `active | inactive | terminated` (was `active | disconnected`)
- **DB migrations v6-v8** — projects table, archived_at columns, project_id FK, unique remote-per-project

## Recent Changes (v1.8.0)

### Skills & Commands Integration
- **`/skills`** — Interactive skill browser with inline buttons (reads from `~/.claude/skills/`)
- **`/commands`** — Custom command launcher (reads from `~/.claude/commands/`)
- **`/hooks`** — View configured Hookify rules
- **Deferred input** — Tools requiring args prompt user then enqueue
- **Icon support** — 38+ emojis for quick visual identification

### Session Management Commands
- **`/add`** — Register project as Claude Code session (prompts for path, auto-switches)
- **`/model`** — Select Claude model via inline buttons (stored in `cli_config.model`)
- **Adapter pattern** — `adapters/ClaudeAdapter` (message_queue), extensible registry
- **Session router** — `sessions/router.ts` typed routing: standalone / cli / disconnected

### CLI Refactoring
- **`start [dir]`** — Register + launch project in current terminal (replaces old start = docker-only)
- **`docker-start`** — New command for `docker compose up -d` (old `start` behavior)
- **`add [dir]`** — Now registration-only (saves to config + bot DB, no launch)
- **`run [dir]`** — New command to launch registered project in terminal
- **`attach [dir]`** — New command to add window to running tmux `bots` session
- **tmux session renamed** — `claude` → `bots` (hosts both claude and opencode windows)

### Database Improvements
- **JSONB normalization** — Safe PostgreSQL storage with explicit casting
- **Read-merge-write** — Concurrent-safe provider config updates

## Roadmap

- [x] Vision model support for image analysis in standalone mode
- [x] Webhook mode for Telegram (instead of polling)
- [x] Stream-json output parsing for non-tmux progress monitoring
- [x] Web dashboard for statistics and session management
- [x] Skills & commands integration from local Claude config
- [x] Session management commands (/add, /model) with model selection
- [x] Persistent projects with remote/local session lifecycle
- [x] Work summary on session exit with vectorized long-term memory
- [x] Session switch briefing from project context
- [x] Semantic search via MCP tool and bot command
- [x] Smart memory reconciliation — LLM-based dedup and update (mem0 approach)
- [x] Dashboard UI for project and session management (Projects page + SSE notifications)
- [ ] Multi-user support with separate session namespaces
- [ ] Inline mode — respond in any Telegram chat via @bot

## Guides

- [Dashboard](examples/dashboard.md) — overview, sessions, stats, logs, memory pages with screenshots
- [Cloudflare Tunnel Setup](guides/cloudflare-tunnel-setup.md) — domain purchase, tunnel configuration, and webhook activation
- [Usage Patterns](examples/usage-patterns.md) — status updates, sub-agent progress trees, file diffs, memory integration

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, code style, project structure, and PR guidelines.

For bug reports and feature requests, use [GitHub Issues](https://github.com/MrCipherSmith/multiclaude-tg-bot/issues).

## License

[MIT](LICENSE)
