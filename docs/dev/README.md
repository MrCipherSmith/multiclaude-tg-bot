# Helyx

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Build](https://github.com/MrCipherSmith/helyx/actions/workflows/build.yml/badge.svg)](https://github.com/MrCipherSmith/helyx/actions)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-3178c6)](https://www.typescriptlang.org)

**Remote control panel for Claude Code CLI sessions — delivered through Telegram.**

---

<!-- Screenshot or demo GIF goes here -->
<!-- ![Helyx Demo](assets/demo.gif) -->

---

## What is Helyx?

Helyx is a Telegram bot that bridges your Telegram account to one or more long-running Claude Code CLI sessions on a host machine. You send messages in Telegram; Claude Code receives them, works on your codebase, and replies — all without leaving the chat. Voice messages are transcribed, replies can be spoken back, and permission prompts land as interactive buttons.

The system is designed for developers who want to supervise an AI coding agent from a phone, a different machine, or a Telegram Forum group where each project has its own dedicated topic. Multiple projects can run in parallel: open a topic, type normally, Claude replies in that topic — no `/switch` commands, no context bleed between projects.

Architecturally, Helyx is a durable, crash-tolerant orchestrator. All messages flow through a PostgreSQL message bus with `LISTEN/NOTIFY` for near-real-time delivery. Sessions survive process restarts through a pre-mark pending-reply buffer and a lease-based ownership model. A five-loop supervisor daemon monitors health and triggers automatic recovery. The system deliberately spans two runtimes — a Docker container and the host machine — because Claude Code's stdio MCP transport cannot cross container boundaries.

---

## Key Features

- **Telegram as the control surface** — send messages, receive replies, approve tool permissions, and control sessions entirely from Telegram
- **Forum Supergroup mode** — one Telegram forum topic per project; no `/switch` needed; status updates and permissions route to the correct topic automatically
- **Dual MCP transport** — `channel.ts` (stdio, host) delivers messages into Claude Code; the MCP HTTP server (Docker) receives tool calls back out; both run simultaneously
- **Voice transcription** — voice messages are transcribed via Groq Whisper (or local Whisper); replies can be synthesized as voice clips (Piper, Kokoro, Yandex, Groq, OpenAI TTS)
- **Persistent memory** — long-term memory with pgvector semantic search; short-term conversation context with auto-summarization on session disconnect; LLM-driven deduplication (`rememberSmart`)
- **Skills Toolkit** — Claude Code can propose new skills from session transcripts; you approve via Telegram inline button; a weekly curator auto-pins, archives, and consolidates skills
- **Permission gating** — before any destructive tool call, Claude sends a Telegram message with approve/deny/always-allow buttons; auto-approve patterns eliminate repeat prompts for trusted tools
- **Live status messages** — a "Thinking… (0:12)" spinner appears while Claude works, updates with tmux pane output, and resolves to a summary on reply
- **Response guard** — if Claude Code does not reply within 5 minutes, a fallback message is sent and the supervisor investigates
- **Multi-project parallel sessions** — each project runs in its own tmux window with a `run-cli.sh` auto-restart loop supervised by `admin-daemon`
- **Web dashboard** — full React admin SPA at port 3847: sessions, memories, projects, permissions, logs, API stats, git browser, GitHub PR viewer
- **Telegram Mini App** — lightweight in-Telegram panel with git browser, permissions, process health, timeline, and session views
- **Standalone mode** — bot can call the Anthropic API directly (or Google AI / OpenRouter / Ollama) without a Claude Code CLI session
- **Crash-tolerant delivery** — `pending_replies` pre-mark, `LISTEN/NOTIFY` message bus, lease-based session ownership, and startup recovery all protect against data loss on process restart
- **Codex code review** — `/codex_review` integrates with OpenAI Codex CLI for AI-assisted PR reviews
- **Configurable TTS and ASR** — multiple provider choices with graceful fallback
- **Cost tracking** — per-session token usage, per-call LLM telemetry, transcription stats, and auxiliary LLM cost tracking for internal ops

---

## Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────┐
│  Docker Compose                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  helyx-bot  (bun main.ts)                             │  │
│  │  ├── grammy bot  (Telegram polling / webhook)         │  │
│  │  ├── MCP HTTP server  (:3847)                         │  │
│  │  │     ├─ POST /mcp   (StreamableHTTP + SSE)          │  │
│  │  │     ├─ GET|POST /api/*  (REST dashboard API)       │  │
│  │  │     └─ static files  (dashboard SPA)               │  │
│  │  ├── SessionManager / SessionRouter                   │  │
│  │  ├── NotificationBroadcaster  (SSE → browser)         │  │
│  │  └── Cleanup jobs  (hourly)                           │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  helyx-postgres  (PostgreSQL 16 + pgvector)           │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         │ DATABASE_URL                │ http://localhost:3847
┌─────────────────────────────────────────────────────────────┐
│  Host Machine                                                │
│  systemd → admin-daemon.ts                                   │
│    ├── tmux-watchdog.ts  (5 s poll — pane state, prompts)   │
│    └── supervisor.ts  (5 × setInterval — health + recovery) │
│                                                              │
│  tmux session "bots"  →  one window per project             │
│    └── run-cli.sh  (auto-restart loop)                       │
│          └── claude … server:helyx-channel                   │
│                └── channel.ts  (stdio MCP adapter)           │
│                      ├─ LISTEN message_queue_{id}            │
│                      ├─ permission gating (500 ms poll)      │
│                      └─ TTS / status messages                │
│  Ollama  :11434  (nomic-embed-text embeddings)               │
└─────────────────────────────────────────────────────────────┘
```

Key design points:

- **PostgreSQL is the message bus.** The grammy bot inserts rows into `message_queue`; a DB trigger fires `pg_notify`; `channel.ts` wakes immediately. No direct network link between the Docker bot and the host process.
- **Two MCP transports.** `channel.ts` (stdio) pushes Telegram messages into Claude Code. The HTTP/SSE server in Docker receives tool calls (reply, remember, set_session_name) back out. Both run at the same time.
- **Split deployment is architectural.** `StdioServerTransport` cannot cross container boundaries. TTS requires native host libraries. Admin operations (tmux, docker) require host shell access.
- **Crash tolerance is layered.** Pending replies are pre-marked before Telegram sends. Session leases auto-expire on crash. The supervisor re-queues `proj_start` if a heartbeat goes stale.
- **Skills are human-gated.** Claude proposes skills from transcripts; the user approves via Telegram; the curator runs weekly to pin, archive, or consolidate.

Full architecture details: [architecture.md](architecture.md)

---

## Quick Start

### Prerequisites

| Requirement | Notes |
|---|---|
| Bun 1.x | [bun.sh](https://bun.sh) |
| Docker + Docker Compose | For the bot container and PostgreSQL |
| tmux | Manages Claude Code panes on the host |
| Claude Code CLI (`claude`) | Anthropic CLI; must be on `$PATH` |
| Telegram Bot Token | Create via [@BotFather](https://t.me/BotFather) |
| Anthropic API key | Required for Claude Code sessions |
| Ollama (recommended) | Local embeddings — `nomic-embed-text` |

### Step 1 — Clone and install

```bash
git clone https://github.com/MrCipherSmith/helyx.git
cd helyx
bun install
cd dashboard && bun install && cd ..
```

### Step 2 — Run the setup wizard

```bash
bun cli.ts setup
```

The wizard writes `.env`, registers both MCP servers in Claude Code's `settings.json`, and optionally installs the systemd service. It asks for your bot token, Telegram user ID, LLM provider, TTS provider, and PostgreSQL password.

### Step 3 — Build and start Docker services

```bash
docker compose build
docker compose up -d
```

Two containers start: `helyx-bot` and `helyx-postgres`. Migrations run automatically on first start. Verify with `docker compose ps` and `docker compose logs bot -f --tail 50`.

### Step 4 — Launch Claude Code sessions

```bash
helyx add /path/to/your-project   # register a project
helyx up                           # open tmux windows and start sessions
```

Send a message in Telegram — Claude Code responds.

For full setup details including manual `.env` configuration, MCP registration, and forum topic setup, see [onboarding.md](onboarding.md).

---

## Telegram Commands

Top commands per category. Full reference: [api-reference.md](api-reference.md)

### Session Management

| Command | Description |
|---|---|
| `/start` | Welcome message with command overview |
| `/sessions` | List all sessions; delete inactive ones inline |
| `/switch [id]` | Switch active session; loads project context briefing |
| `/session` | Show current session name, project, and status |
| `/rename` | Rename the current session |
| `/standalone` | Switch to direct Anthropic API mode (no Claude Code CLI) |

### Memory

| Command | Description |
|---|---|
| `/remember [text]` | Save a long-term memory |
| `/recall <query>` | Semantic search over long-term memory |
| `/memories` | List stored memories with type and tags |
| `/summarize` | Force-summarize the current session context |
| `/clear` | Clear short-term context for the current session |

### Projects & Forum

| Command | Description |
|---|---|
| `/projects` | List all projects with start/stop buttons |
| `/forum_setup` | Create forum topics for all projects |
| `/forum_sync` | Re-sync topics (create any missing) |
| `/project_facts` | Show memories scoped to the current project |

### Monitoring & Admin

| Command | Description |
|---|---|
| `/status` | Bot health: DB, active sessions, uptime |
| `/stats` | API token usage and per-session breakdown |
| `/monitor` | Process health: Docker, daemon, tmux; with restart buttons |
| `/pending` | List pending tool permission requests |
| `/system` | Admin-only start/stop/restart panel |
| `/interrupt` | Send Escape to the current tmux session |
| `/logs [id]` | Session request logs |

### Skills & Codex

| Command | Description |
|---|---|
| `/skills` | List skills from the knowledge-base registry |
| `/codex_review [prompt]` | Run an AI code review via Codex CLI |
| `/codex_setup` | Authenticate Codex CLI |

---

## MCP Tools

Claude Code connects to two MCP servers simultaneously. Both expose overlapping tool sets so Claude can use whichever transport is convenient.

**stdio transport (`channel/`, host)** — 19 tools including `reply`, `remember`, `recall`, `update_status`, `send_poll`, `propose_skill`, `save_skill`, `curator_run`, and permission gating.

**HTTP transport (`mcp/`, Docker :3847)** — 18 tools including all the above plus `set_session_name`, `list_sessions`, and `session_info`. The `set_session_name` call links both transports to the same DB session record.

Full tool schemas and parameter tables: [api-reference.md](api-reference.md#part-2-mcp-tools--stdio-channel-adapter)

---

## Dashboard

The web dashboard is served at `http://localhost:3847`. It provides:

- **Overview** — system uptime, DB status, active sessions, 24h token usage
- **Sessions** — list, rename, delete; message history; per-session token stats; git browser; GitHub PR viewer
- **Memories** — browse, filter, delete memories by type, tag, and project
- **Projects** — register, start, stop, delete projects
- **Permissions** — approve, deny, or always-allow pending tool permission requests
- **Monitor** — process health; restart daemon or Docker container inline
- **Stats** — API usage charts; Claude Code usage by project
- **Logs** — paginated request log with level and session filters

Authentication uses the Telegram Login Widget (7-day JWT cookie). A secondary **Telegram Mini App** is served at `/webapp/` for in-Telegram quick access (git browser, permissions, monitor, timeline, sessions).

---

## Configuration

Key environment variables. Full list and defaults: [onboarding.md](onboarding.md#3-manual-env-configuration-alternative-to-the-wizard)

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Token from @BotFather |
| `ALLOWED_USERS` | Yes | Comma-separated Telegram user IDs |
| `ANTHROPIC_API_KEY` | Conditional | Required for Claude Code sessions and summarization; one of `ANTHROPIC_API_KEY`, `GOOGLE_AI_API_KEY`, `OPENROUTER_API_KEY`, or `OLLAMA_CHAT_MODEL` must be set |
| `POSTGRES_PASSWORD` | Yes | Password for the `helyx` DB user |
| `DATABASE_URL` | Yes | Host-side PostgreSQL URL, e.g. `postgres://helyx:<pw>@localhost:5433/helyx` |
| `OLLAMA_URL` | Recommended | Ollama embedding service, default `http://localhost:11434`; if absent, semantic recall is degraded |
| `GROQ_API_KEY` | Optional | Enables Groq Whisper transcription and Groq TTS |
| `TTS_PROVIDER` | Optional | `auto` / `piper` / `yandex` / `kokoro` / `openai` / `groq` / `none`; default `auto` |
| `PORT` | Optional | MCP server and dashboard port; default `3847` |
| `TELEGRAM_WEBHOOK_SECRET` | Conditional | Required in webhook mode |
| `SUPERVISOR_CHAT_ID` | Optional | Telegram chat for supervisor alerts and curator summaries |
| `HOST_PROJECTS_DIR` | Optional | Host projects directory mounted read-only into Docker; default `$HOME/bots` |
| `KNOWLEDGE_BASE` | Optional | Path to an `AGENTS.md` catalog for `/skills` and `/rules` |

---

## Documentation

| Document | Description |
|---|---|
| [onboarding.md](onboarding.md) | Prerequisites, full setup steps, project structure, development workflow, troubleshooting |
| [architecture.md](architecture.md) | System components, deployment split, two MCP transports, data flows, authentication, error recovery, architectural decisions |
| [modules.md](modules.md) | Per-module reference: purpose, key files, public API, environment variables, how to develop |
| [api-reference.md](api-reference.md) | All Telegram commands, MCP tool schemas (both transports), REST dashboard API, Mini App API |
| [data-models.md](data-models.md) | All PostgreSQL tables, column definitions, indexes, pgvector configuration, migration guide |
| [index.md](index.md) | Navigation index — all docs with one-line descriptions |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Bun 1.x (native TypeScript, no transpilation) |
| Language | TypeScript — strict ESNext, `moduleResolution: bundler` |
| Telegram bot | grammy v1.35 with auto-retry plugin |
| MCP | @modelcontextprotocol/sdk v1.12 — stdio + StreamableHTTP transports |
| Database | PostgreSQL 16 + pgvector — raw SQL via `postgres` v3 tagged templates |
| Validation | Zod v4 — config schemas and MCP tool schemas |
| Frontend | React + Vite (TypeScript/TSX) — two independent SPAs |
| Logging | Pino v10 — structured JSON to stdout |
| TTS | kokoro-js v1.2 + Piper binary; Yandex / Groq / OpenAI as alternatives |
| Containerization | Docker multi-stage build (`oven/bun:1`) + Docker Compose |
| Testing | Bun test runner (14 unit tests) + Playwright E2E (api + dashboard) |
| AI SDKs | @anthropic-ai/sdk, Google AI, Ollama, OpenRouter |
| Embeddings | Ollama `nomic-embed-text` (768-dim); pgvector HNSW cosine index |

---

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) in the project root for contribution guidelines, coding conventions, and the PR process.

When working on the codebase, note the deployment split: changes to `bot/`, `mcp/`, `sessions/`, `memory/`, or `services/` require a Docker rebuild (`docker compose up -d --build bot`). Changes to `channel/` or `utils/tts.ts` only require restarting the host `channel.ts` process (`helyx bounce`). Full development workflow details are in [onboarding.md](onboarding.md#development-workflow).

---

## License

MIT — see [LICENSE](../../LICENSE).
