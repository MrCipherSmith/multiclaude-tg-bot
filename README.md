# Helyx
![Helyx Banner](https://raw.githubusercontent.com/MrCipherSmith/helyx/main/assets/banner.jpg)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Build](https://github.com/MrCipherSmith/helyx/actions/workflows/build.yml/badge.svg)](https://github.com/MrCipherSmith/helyx/actions)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-3178c6)](https://www.typescriptlang.org)

[Dashboard](examples/dashboard.md) | [Usage Patterns](examples/usage-patterns.md) | [Architecture](guides/architecture.md) | [Cloudflare Tunnel](guides/cloudflare-tunnel-setup.md) | [Remote Laptop Setup](guides/remote-laptop-setup.md) | [Usage Scenarios](guides/usage-scenarios.md) | [Memory](guides/memory.md) | [MCP Tools](guides/mcp-tools.md) | [Shared MCP Services](guides/shared-mcp-services.md) | [Mini App](guides/webapp.md) | [Voice Conversations](guides/voice.md) | [Interactive Polls](guides/polls.md) | [Codex Review](guides/codex.md) | [CLAUDE.md Guide](CLAUDE_MD_GUIDE.md)

> **Control Claude Code from Telegram.** Each project gets its own topic in a Telegram Forum group — no `/switch` needed. Persistent sessions, dual-layer memory, voice transcription, image analysis, and real-time CLI progress monitoring.

Connect multiple Claude Code CLI instances to a single Telegram bot. Each project lives in its own **forum topic** — open the topic, type normally, Claude replies there. Status updates and permission requests appear in the correct topic. No context bleeding, no `/switch` ceremony.

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/helyx/main/install.sh | bash
```

The installer checks prerequisites, clones the repo, installs dependencies, sets up the `helyx` CLI, and launches the setup wizard.

Then connect any project:
```bash
cd your-project && helyx connect . --tmux
```

Done. Open Telegram, run `/forum_setup` in your group — your projects appear as topics.

## Forum Group Setup

The recommended way to use Helyx is with a **Telegram Forum Supergroup** where each project gets its own topic.

### Step 1 — Create a Supergroup

1. In Telegram tap **New Group** → add yourself → set a name (e.g. `🧠 Dev Hub`)
2. Open group **Settings → Group type → Topics** → enable
3. The group becomes a Forum Supergroup with a **General** topic

### Step 2 — Add the bot as admin

1. Open group **⋮ → Manage Group → Administrators → Add Admin**
2. Search your bot (e.g. `@helyx_grace_bot`)
3. Enable **Manage Topics** permission
4. Save

### Step 3 — Run `/forum_setup`

Open the **General** topic and send:

```
/forum_setup
```

The bot will:
- Verify the group has Topics enabled
- Save the group chat ID to `bot_config`
- Create one topic per registered project (`keryx`, `helyx`, `vantage-frontend`, …)
- Pin a **Dev Hub** button in General topic (opens the Mini App WebApp)
- Reply: `✅ Forum configured. N topics created.`

Topics appear in the left sidebar immediately.

### Step 4 — Start working

Open any project topic and type normally:

```
keryx topic:  "add a test for the auth middleware"
              → Claude replies here, status shows here, permissions appear here
```

No `/switch` ever needed. The topic IS the project.

### Daily use

| Action | How |
|--------|-----|
| Talk to keryx | Open **keryx** topic, type normally |
| Talk to helyx | Open **helyx** topic, type normally |
| Check all projects | `/projects` in General topic |
| Add new project | `/project_add /path/to/project` — topic auto-created |
| Re-sync topics | `/forum_sync` in General topic |

### Topic management

```
/topic_rename <name>   — rename the current topic
/topic_close           — close (pause) topic
/topic_reopen          — reopen topic
/forum_sync            — create missing topics, re-sync
```

### Backward compatibility

If you don't run `/forum_setup`, the bot works exactly as before — private DM, `/switch` routing, everything unchanged. Forum mode is **additive**.

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
- **Channel Adapter** — stdio bridge that forwards Telegram messages to Claude Code as channel notifications, with lease-based session ownership (TTL lease in DB, auto-expires on crash), and graceful shutdown on stdin close
- **Auto-Named Sessions** — CLI sessions automatically named after the project directory, with source labels (tmux/cli)

### AI & Media
- **Standalone Mode** — bot responds directly via LLM API (Anthropic / Google AI / OpenRouter / Ollama) with automatic retry on 429/5xx
- **Codex Code Review** — OpenAI Codex CLI integration for AI-powered code review; authenticate headlessly via `/codex_setup` (device flow, no terminal needed); trigger via `/codex_review` or natural language ("review my code"); falls back to Claude's native review on quota/auth errors; model configurable via `CODEX_MODEL` env var
- **Voice Messages** — transcription via Groq whisper-large-v3 with kesha local ONNX ASR (2.5× faster than Whisper on CPU, offline) and local Whisper as final fallback; voice replies via Yandex SpeechKit → Piper → kesha (Kokoro EN / Piper RU, offline) → Groq
- **Interactive Polls** — Claude can ask clarifying questions as native Telegram polls (`send_poll` MCP tool); you tap answers, press **Submit ✅**, and results flow back automatically as a user message; supports forum topic routing, 24h expiry, and vote retraction
- **Image Analysis** — photos analyzed by Claude in CLI sessions; standalone mode with Anthropic API
- **File Forwarding** — photos, documents, and videos forwarded to Claude via MCP with base64 (≤5 MB images) or file path; if sent without caption, bot asks what to do before forwarding
- **Auto-Summarization** — idle conversations are summarized to long-term memory after 15 min

### Session Lifecycle
- **Persistent Projects** — `projects` table as single source of truth; added via `/project_add` (bot) or `helyx add` (CLI) — both write to the same DB; `helyx up` reads from DB directly
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
- **Forum Topics** — each project gets its own topic in a Telegram Forum Supergroup; messages, status updates, and permission requests are scoped to the correct topic; General topic is control-only; `/forum_setup` creates all topics at once; `/project_add` auto-creates a topic for new projects
- **Markdown Rendering** — responses formatted with HTML (bold, italic, code blocks with syntax highlighting, links)
- **Live Status Updates** — real-time progress from CLI via tmux monitoring ("Explore: Find files", "Bash: git status"); status appears in the project topic in forum mode
- **Permission Forwarding** — CLI permission requests as inline buttons (Allow / Always / Deny), with input preview (file path + syntax-highlighted diff), synced with terminal; in forum mode, buttons appear in the project topic
- **Auto-Approve Permissions** — configure allowed tools in `settings.local.json` (`permissions.allow` patterns like `"Edit(*)"`, `"Bash(*)"`) to skip Telegram approval for trusted operations
- **Statistics & Logging** — `/stats` for API usage and tokens, `/logs` for per-session request logs
- **Web Dashboard** — real-time stats (by provider, project, operation, session), token charts, cost estimation including Anthropic CLI sessions, error drill-down with slide panel, log viewer with full message detail; **Projects page** for creating, starting, and stopping projects from the browser
- **Telegram Mini App** — mobile WebApp (Dev Hub button) with git browser (files/log/status/diffs), permission manager (Allow/Deny/Always), and session monitor with API stats (by model, including Anthropic CLI usage); auto-themed to Telegram's light/dark mode

### Operations
- **Health Endpoint** — `GET /health` with DB status, uptime, active sessions
- **Auto-Cleanup** — hourly cleanup of old queue messages, logs, stats, and all disconnected sessions; supports `CLEANUP_DRY_RUN=true` for safe inspection
- **CLI Tool** — interactive setup wizard, session management, backup, monitoring
- **Docker-First** — bot + PostgreSQL in Docker Compose, Ollama on host

### Architecture Quality
- **Service Layer** — `services/` directory with `SessionService`, `ProjectService`, `PermissionService`, `MemoryService`, `MessageService`, `SummarizationService`; typed wrappers over raw SQL with atomic operations
- **Zod Config Validation** — all env vars parsed and validated at startup via `config.ts`; bot exits immediately on missing required vars
- **Structured Logging (Pino)** — JSON-structured logs throughout the codebase; `LOG_LEVEL` env var; `channelLogger` writes to stderr fd 2 for MCP stdio compatibility
- **Unit Test Suite** — 77 pure unit tests in `tests/unit/` covering session lifecycle, permission state machine, memory reconciliation, and forum topic routing; runs in ~30ms with `bun test tests/unit/`
- **Security Defaults** — bot exits immediately at startup if `ALLOWED_USERS` is empty and `ALLOW_ALL_USERS=true` is not set; no silent open-access deployments
- **Session State Machine** — `sessions/state-machine.ts` enforces valid status transitions (`active→inactive`, `active→terminated`, `inactive→active`); invalid transitions are blocked and logged

## Architecture

```
                          ┌──────────────────────────────────────────────────┐
                          │      Host / Laptop / Any terminal                │
                          │                                                  │
  ┌─────────────┐ stdio   │  ┌───────────┐  ┌───────────┐  ┌───────────┐   │
  │ channel/    │◀═══════▶│  │ Claude CLI│  │ Claude CLI│  │ Claude CLI│   │
  │ (7 modules: │  MCP    │  │ project-a │  │ project-b │  │ general   │   │
  │  session,   │         │  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  │
  │  perms,     │         │        │   Bash/Read/Edit/Write       │         │
  │  tools,     │         │        ▼              ▼              ▼          │
  │  poller,    │         │  ┌──────────────────────────────────────────┐   │
  │  status,    │         │  │           Project Files (host)           │   │
  │  telegram)  │         │  └──────────────────────────────────────────┘   │
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
         │                 │  │  services/  (SessionService,             │   │
         │                 │  │             ProjectService,              │   │
         │                 │  │             PermissionService,           │   │
         │                 │  │             MemoryService)               │   │
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

### Voice Replies (TTS)

After every `reply` call, the bot automatically attaches a voice message if:

1. The user sent a voice message (always — regardless of reply length)
2. The reply text is ≥300 characters and not mostly code or diffs

**Provider chain (Russian):** Yandex SpeechKit → Piper (local) → Kesha ru-denis (offline) → Groq  
**Provider chain (English):** Piper (local) → Kokoro-82M (local) → Kesha en-af_heart (offline) → Groq

| Provider | Set in `.env` | Notes |
|---|---|---|
| **Yandex SpeechKit** | `YANDEX_API_KEY`, `YANDEX_FOLDER_ID` | Best Russian quality; service account needs `ai.speechkit.tts` IAM role |
| **Piper** | `PIPER_DIR` | Local offline TTS; binary + voice files in `PIPER_DIR` |
| **Kesha** | `KESHA_TTS_ENABLED=true` | Offline Kokoro-82M (EN) + Piper VITS ru-denis (RU); no API key; models downloaded on first run |
| **Groq** | `GROQ_API_KEY` | Cloud fallback; English-only (Orpheus); free tier: 3600 tokens/day |
| **OpenAI TTS** | `OPENAI_API_KEY` | Good multilingual including Russian; not wired by default |

### Voice Transcription (ASR)

**Provider chain:** Groq whisper-large-v3 → Kesha local ONNX → local Whisper HTTP server

| Provider | Set in `.env` | Notes |
|---|---|---|
| **Groq Whisper** | `GROQ_API_KEY` | Primary; ~200ms, free tier |
| **Kesha ASR** | `KESHA_ENABLED=true` | Offline ONNX, ~2.5× faster than Whisper on CPU, 25 languages; models ~1-2 GB downloaded on first use |
| **Local Whisper** | `WHISPER_URL` | HTTP ASR server (e.g. separate Docker container) |

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
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/helyx/main/install.sh | bash
```

This will check prerequisites, clone the repo to `~/bots/helyx`, install dependencies, set up the `helyx` CLI globally, and launch the setup wizard.

Custom install directory:
```bash
HELYX_DIR=~/my-bot curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/helyx/main/install.sh | bash
```

### Manual Install

```bash
git clone https://github.com/MrCipherSmith/helyx.git ~/bots/helyx
cd ~/bots/helyx
bun install
ln -sf ~/bots/helyx/cli.ts ~/.local/bin/helyx
helyx setup
```

### Prerequisites

| Dependency | Required | Install |
|---|---|---|
| **Bun** | Yes | `curl -fsSL https://bun.sh/install \| bash` |
| **Docker** | Yes | [docs.docker.com/engine/install](https://docs.docker.com/engine/install/) |
| **Git** | Yes | `apt install git` / `brew install git` |
| **Claude Code** | For CLI sessions | `npm install -g @anthropic-ai/claude-code` |
| **Ollama** | Optional (recommended — embeddings, supervisor LLM, summarization) | [ollama.com/download](https://ollama.com/download) |

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

Run `helyx setup` (or the installer runs it automatically). The wizard asks:

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

If Ollama is running on your machine, the wizard detects it automatically and offers to use it for **memory search + summarization**:

```
✓ Ollama detected at localhost:11434
Use Ollama for memory search + summarization?
❯ 1. Yes, use Ollama (recommended — free, offline)
  2. No, use main LLM provider (Claude/Google AI/etc.)

Embedding model [nomic-embed-text]:
Summarization model [gemma4:e4b]:
```

If you select **Yes**, `EMBEDDING_MODEL` and `SUMMARIZE_MODEL` are written to `.env`. If Ollama is not found, it's noted and these settings remain commented out — the main LLM provider is used as fallback.

```
Groq API Key for voice (Enter to skip, free at console.groq.com):
```

Optional. Enables fast voice transcription (~200ms). Get a free key at [console.groq.com](https://console.groq.com). Skip if you don't need voice messages.

```
PostgreSQL password [helyx_secret]:
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

Four ways to run helyx: **Laptop** (simple, single project), **Laptop+tmux** (with live Telegram monitoring), **Server** (multiple projects, always-on tmux), and **Remote** (laptop → server via SSH tunnel).

See [Usage Scenarios](guides/usage-scenarios.md) for full setup instructions and tmux navigation reference.

### CLI Commands

```
Setup:
  helyx setup              Interactive installation wizard
  helyx remote             Connect laptop to remote server
  helyx mcp-register       Re-register MCP servers

Bot (Docker service):
  helyx bot-start          Start Docker containers (docker compose up -d)
  helyx bot-stop           Stop Docker + tmux
  helyx bot-restart        Rebuild and restart bot
  helyx bot-status         Bot health, uptime, docker status
  helyx bot-logs           Follow bot logs
  helyx bounce             Stop tmux + restart (quick reload)

Data:
  helyx sessions           List active sessions
  helyx prune              Remove stale sessions (interactive)
  helyx backup             Database backup
  helyx cleanup [--dry-run]   Clean old queue, logs, stats (--dry-run to preview)

Tmux:
  helyx up [-a] [-s]       Start all projects in tmux (-s split panes) + admin-daemon
  helyx down               Stop all tmux sessions + clean DB
  helyx ps                 List configured projects
  helyx add [dir] [--name] [--provider]  Register project in DB (synced with /project_add)
  helyx run [dir]              Launch project in current terminal
  helyx attach [dir]           Add window to running tmux session (bots)
  helyx remove <name>          Remove project from DB

Connect:
  helyx open [dir]             Launch Claude Code in current terminal
  helyx connect [dir] [-t]     Start single CLI session
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
| `/projects` | List projects with status and Start/Stop buttons (launches tmux window via admin-daemon) |
| `/project_add` | Add project to persistent registry, auto-creates forum topic |
| `/interrupt` | Interrupt running Claude session — sends Escape; if multiple sessions active, shows picker |
| `/remote_control` | tmux bots status with Kill/Start/Refresh controls |
| **Memory** | |
| `/remember [text]` | Save to long-term memory (bound to session) |
| `/recall [query]` | Semantic search through memory |
| `/memories` | List recent memories |
| `/forget [id]` | Delete a memory |
| `/memory_export [project_path]` | Export all memories as a JSON file (optionally filtered by project) |
| `/memory_import` | Import memories from a previously exported JSON file (send file with this caption) |
| `/summarize` | Force conversation summarization |
| `/clear` | Clear current session context |
| **Monitoring** | |
| `/stats` | API usage, tokens, transcriptions, per session |
| `/logs [id]` | Request logs for session |
| `/status` | Bot health (DB, Ollama, counts) |
| `/pending` | Pending CLI permission requests |
| `/permission_stats [days]` | Permission history: allow/deny breakdown by tool (default: 30 days) |
| `/session_export [id]` | Export session as markdown transcript (messages + tool calls chronologically) |
| **Tools & Knowledge** | |
| `/tools` | Available MCP tools |
| `/skills` | Skills catalog — inline buttons with descriptions, click to run |
| `/commands` | Custom commands — inline buttons, click to execute |
| `/hooks` | Configured Hookify rules (event matchers + commands) |
| `/rules` | Coding rules from knowledge base |
| `/add` | Register project as Claude Code session (prompts for path if not in session) |
| `/model` | Select Claude model for current session (inline buttons) |
| **Forum** | |
| `/forum_setup` | Configure forum supergroup — creates one topic per project + pins Dev Hub button, run in General topic |
| `/forum_sync` | Re-sync topics — creates missing topics for new projects, re-pins Dev Hub button |
| `/forum_hub` | Send/re-send pinned Dev Hub WebApp button to General topic |
| `/topic_rename <name>` | Rename current project topic (run from within a project topic) |
| `/topic_close` | Close (pause) current project topic |
| `/topic_reopen` | Reopen current project topic |

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

Registered sessions are immediately switchable via `/switch`. To launch the Claude Code CLI, use `helyx start <path>` from the terminal.

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

Helyx exposes MCP tools via HTTP server (`port 3847`) and the stdio channel adapter. Key tools: `remember`, `recall`, `reply`, `update_status`, `list_sessions`, `search_project_context`.

See [MCP Tools Reference](guides/mcp-tools.md) for the full tool list with parameters and usage examples.

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
| `ALLOWED_USERS` | Yes* | Comma-separated Telegram user IDs. Required unless `ALLOW_ALL_USERS=true` |
| `ALLOW_ALL_USERS` | No | Set to `true` to allow all users (no access control). Dangerous in production. |
| `LOG_LEVEL` | No | Pino log level: `trace`, `debug`, `info`, `warn`, `error` (default: `info`) |
| `ANTHROPIC_API_KEY` | No | Anthropic API (best quality standalone) |
| `CLAUDE_MODEL` | No | Claude model for CLI sessions (default: `claude-sonnet-4-20250514`) |
| `MAX_TOKENS` | No | Max tokens per response (default: `8192`) |
| `GOOGLE_AI_API_KEY` | No | Google AI API ([aistudio.google.com](https://aistudio.google.com/apikey)) |
| `GOOGLE_AI_MODEL` | No | Google AI model (default: `gemma-4-31b-it`) |
| `OPENROUTER_API_KEY` | No | OpenRouter API (many models available) |
| `OLLAMA_CHAT_MODEL` | No | Local Ollama model (default: `qwen3:8b`) |
| `GROQ_API_KEY` | No | Voice transcription ([free](https://console.groq.com)) |
| `KESHA_ENABLED` | No | Enable kesha local ONNX ASR as fallback (default: `false`) |
| `KESHA_TTS_ENABLED` | No | Enable kesha offline TTS (Kokoro EN + Piper RU) as fallback (default: `false`) |
| `KESHA_BIN` | No | Path to kesha-engine binary (default: `kesha-engine` in PATH) |
| `KESHA_BENCHMARK` | No | Run current + kesha pipelines in parallel per message and report stats to Telegram (default: `false`) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `POSTGRES_PASSWORD` | Yes | PostgreSQL password (required in docker-compose) |
| `OLLAMA_URL` | No | Ollama API URL (default: `http://localhost:11434`) |
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
| `CLEANUP_DRY_RUN` | No | Set to `true` to log what cleanup would delete without actually deleting (default: `false`) |

### Manual Setup (without Docker)

Prerequisites: [Bun](https://bun.sh), PostgreSQL 16+ with [pgvector](https://github.com/pgvector/pgvector), [Ollama](https://ollama.ai)

```bash
# Database
psql -U postgres -c "CREATE USER helyx WITH PASSWORD 'your_password';"
psql -U postgres -c "CREATE DATABASE helyx OWNER helyx;"
psql -U postgres -d helyx -c "CREATE EXTENSION IF NOT EXISTS vector;"

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
helyx remote    # Interactive wizard
```

Or manually via SSH tunnel:
```bash
ssh -L 3847:localhost:3847 -L 5433:localhost:5433 user@server
helyx connect . --tmux
```

## Production

### Docker Compose
```bash
helyx bot-start      # docker compose up -d
helyx bot-restart    # rebuild and restart
helyx bot-logs       # follow logs
helyx bot-stop       # tmux down + docker compose down
helyx bounce         # quick reload (stop tmux → wait → start)
```

### Database Backup
```bash
helyx backup     # manual backup
# Or schedule: 0 3 * * * /path/to/scripts/backup-db.sh
```

Backups saved to `~/backups/helyx/` (gzipped, last 7 retained).

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | [Bun](https://bun.sh) |
| Telegram | [grammY](https://grammy.dev) |
| AI SDK | [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) |
| MCP | [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) |
| Database | PostgreSQL 16 + [pgvector](https://github.com/pgvector/pgvector) |
| Embeddings | [Ollama](https://ollama.ai) (nomic-embed-text) |
| Voice ASR | [Groq](https://console.groq.com) (whisper-large-v3) + [kesha-engine](https://github.com/drakulavich/kesha-voice-kit) (local ONNX, offline) |
| Voice TTS | Yandex SpeechKit + Piper + [kesha-engine](https://github.com/drakulavich/kesha-voice-kit) (Kokoro-82M EN / Piper RU, offline) + Groq |
| DB Client | [postgres](https://github.com/porsager/postgres) |
| Dashboard | [React](https://react.dev) + [Tailwind CSS](https://tailwindcss.com) + [Vite](https://vite.dev) |

## Recent Changes

See [CHANGELOG.md](CHANGELOG.md) for the full version history.

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
- [x] Offline voice stack — kesha-engine local ONNX ASR + TTS (zero API keys, auto-installs models)
- [ ] Multi-user support with separate session namespaces
- [ ] Inline mode — respond in any Telegram chat via @bot

## Guides

- [Dashboard](examples/dashboard.md) — overview, sessions, stats, logs, memory pages with screenshots
- [Cloudflare Tunnel Setup](guides/cloudflare-tunnel-setup.md) — domain purchase, tunnel configuration, and webhook activation
- [Usage Patterns](examples/usage-patterns.md) — status updates, sub-agent progress trees, file diffs, memory integration

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, code style, project structure, and PR guidelines.

For bug reports and feature requests, use [GitHub Issues](https://github.com/MrCipherSmith/helyx/issues).

## License

[MIT](LICENSE)
