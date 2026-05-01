# Helyx — Onboarding Guide

## What is Helyx?

Helyx is a Telegram bot that acts as a remote control panel for [Claude Code](https://docs.anthropic.com/claude/docs/claude-code) CLI sessions. It bridges your Telegram account to one or more long-running Claude Code processes on a host machine, letting you send messages, approve tool permissions, receive voice replies, and manage AI coding sessions entirely from Telegram. The system is built on Bun + TypeScript, uses PostgreSQL as its durable message bus, and implements the Model Context Protocol (MCP) on both sides of Claude Code simultaneously.

For a deeper look at how the components fit together, see [architecture.md](../artifacts/architecture.md).

---

## Architecture at a Glance

- **Docker container (`helyx-bot`)** — runs the grammy Telegram bot, an MCP HTTP server on port 3847 (also serves the dashboard SPA), and all PostgreSQL-backed session/memory/project managers.
- **Host machine** — runs `channel.ts` (a stdio MCP adapter that Claude Code connects to directly), the `admin-daemon` (executes tmux/docker shell commands queued from the bot), and the `tmux-watchdog`/`supervisor` background daemons.
- **PostgreSQL 16 + pgvector** — the central message bus. Telegram messages are inserted as rows; `channel.ts` picks them up via `LISTEN/NOTIFY`. All session state, memories, permissions, and telemetry live here.
- **Two MCP transports** — `channel.ts` uses a stdio transport (host-side, for pushing messages into Claude Code and intercepting permission prompts); the Docker container uses an HTTP/SSE transport (for receiving tool calls from Claude Code like `reply`, `remember`, `set_session_name`).
- **Claude Code CLI in tmux** — the AI agent itself. Helyx launches and supervises it inside a `bots` tmux session, one window per project, using `run-cli.sh` as an auto-restart wrapper.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Bun 1.x** | Runtime for all TypeScript. Install from [bun.sh](https://bun.sh). |
| **Docker + Docker Compose** | For the bot container and PostgreSQL. |
| **tmux** | For managing Claude Code session panes on the host. |
| **Claude Code CLI** (`claude`) | Install from Anthropic. Must be on `$PATH`. |
| **Telegram Bot Token** | Create a bot via [@BotFather](https://t.me/BotFather) in Telegram. |
| **Anthropic API key** | Required for Claude Code sessions (and optionally for standalone mode). Alternatively: Google AI, OpenRouter, or Ollama for standalone mode only. |
| **Ollama** (optional but recommended) | Local embedding service (`nomic-embed-text`) for semantic memory search. Install from [ollama.com](https://ollama.com). |

---

## Setup Steps

### 1. Clone the Repository

```bash
git clone https://github.com/MrCipherSmith/helyx.git
cd helyx
bun install
cd dashboard && bun install && cd ..
```

### 2. Run the Interactive Setup Wizard

The easiest way to configure Helyx is the built-in wizard. It writes a `.env` file, registers the MCP servers in Claude Code, and optionally installs the systemd service.

```bash
bun cli.ts setup
```

The wizard asks for:
- Deployment type (Docker recommended)
- Telegram Bot Token and your Telegram user ID
- LLM provider for standalone mode (Anthropic / Google AI / OpenRouter / Ollama)
- Telegram transport (polling or webhook)
- Voice transcription key (Groq, optional)
- TTS provider (Piper / Yandex / Kokoro / auto)
- PostgreSQL password
- Bot port (default `3847`)

After it completes, your `.env` is ready and the MCP servers are registered in `~/.claude/settings.json`.

### 3. Manual .env Configuration (alternative to the wizard)

```bash
cp .env.example .env
```

Edit `.env`. The variables below are required or commonly needed:

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **Yes** | Token from @BotFather. |
| `ALLOWED_USERS` | **Yes** | Comma-separated Telegram user IDs. Get yours from [@userinfobot](https://t.me/userinfobot). Omit only if `ALLOW_ALL_USERS=true`. |
| `ANTHROPIC_API_KEY` | Conditional | Required for Claude API calls (standalone mode, summarization). One of `ANTHROPIC_API_KEY`, `GOOGLE_AI_API_KEY`, `OPENROUTER_API_KEY`, or `OLLAMA_CHAT_MODEL` must be set. |
| `POSTGRES_PASSWORD` | **Yes** | Password for the `helyx` DB user. Used by Docker Compose. |
| `DATABASE_URL` | **Yes** | For the host-side processes (`channel.ts`, `admin-daemon`). Docker Compose overrides this internally. Use `postgres://helyx:<password>@localhost:5433/helyx` when connecting from the host. |
| `OLLAMA_URL` | Recommended | URL of the Ollama service. Default: `http://localhost:11434`. Used for `nomic-embed-text` embeddings (semantic memory search). If unreachable, memories are stored without embeddings — recall/search is degraded. |
| `GROQ_API_KEY` | Optional | Enables fast cloud-based Whisper transcription for voice messages. Free at [console.groq.com](https://console.groq.com). |
| `TTS_PROVIDER` | Optional | `auto` \| `piper` \| `yandex` \| `kokoro` \| `openai` \| `groq` \| `none`. Default: `auto`. |
| `PORT` | Optional | HTTP port for the MCP server and dashboard. Default: `3847`. |
| `TELEGRAM_WEBHOOK_SECRET` | Conditional | Required in webhook mode (`TELEGRAM_TRANSPORT=webhook`). Generate: `openssl rand -hex 32`. |
| `SUPERVISOR_CHAT_ID` | Optional | Telegram chat ID for supervisor alerts and skill curator summaries. |
| `HOST_PROJECTS_DIR` | Optional | Directory on the host containing your project directories. Mounted read-only into Docker. Default: `$HOME/bots`. |
| `KNOWLEDGE_BASE` | Optional | Path to a directory with an `AGENTS.md` catalog (enables `/skills` and `/rules` commands). |

### 4. Build and Start the Docker Services

```bash
docker compose build
docker compose up -d
```

This starts two containers:
- `helyx-bot` — the Telegram bot and MCP HTTP server.
- `helyx-postgres` — PostgreSQL 16 with pgvector.

The bot service waits for PostgreSQL to be healthy before starting, then runs all pending DB migrations automatically.

Verify the bot is running:
```bash
docker compose ps
docker compose logs bot -f --tail 50
```

### 5. Register the MCP Servers in Claude Code

If you did not run the setup wizard, register the two MCP servers manually:

```bash
bun cli.ts mcp-register
```

This runs:
```bash
claude mcp add --transport http -s user helyx http://localhost:3847/mcp
claude mcp add-json -s user helyx-channel '{"command":"bun","args":["/path/to/helyx/channel.ts"],...}'
```

And adds `mcp__helyx__*` + `mcp__helyx-channel__*` to the allow-list in `~/.claude/settings.json`.

### 6. Start the tmux Sessions

```bash
helyx up
```

This creates a `bots` tmux session and opens one window per registered project, each running `run-cli.sh` which starts `claude --dangerously-load-development-channels server:helyx-channel` in an auto-restart loop.

If `helyx` is not yet on your `$PATH`, create the wrapper:
```bash
echo '#!/bin/bash' > ~/.local/bin/helyx
echo 'exec bun --cwd "/path/to/helyx" "/path/to/helyx/cli.ts" "$@"' >> ~/.local/bin/helyx
chmod +x ~/.local/bin/helyx
```
(The setup wizard does this automatically.)

### 7. Register a Project and Connect

**Register a project directory:**
```bash
helyx add /path/to/your/project
# or from inside the project directory:
helyx add .
```

**Start a managed session for a specific project:**
```bash
helyx up   # starts all registered projects
```

**Open an ad-hoc session (attach to existing tmux pane):**
```bash
helyx connect /path/to/your/project
```

**Attach to the bots tmux session to watch panes:**
```bash
helyx attach
```

Once a Claude Code session starts, it registers with both MCP transports. You can now send messages to it from Telegram.

---

## Project Structure

```
helyx/
├── main.ts                   # Docker entrypoint — bootstraps DB migrations, bot, MCP server
├── channel.ts                # Host entrypoint — stdio MCP adapter for Claude Code
├── cli.ts                    # Management CLI (helyx up/down/add/connect/backup/…)
├── config.ts                 # Zod-validated env config (all env vars parsed here)
├── logger.ts                 # Pino structured logger
├── .env.example              # Template for all supported env variables
├── docker-compose.yml        # bot + postgres services
├── Dockerfile                # Multi-stage: dashboard build → webapp build → production
│
├── bot/                      # grammy Telegram bot handlers
│   └── commands/             # 20+ command files (session, menu, admin, codex, …)
├── channel/                  # stdio MCP adapter (runs on host alongside Claude Code)
├── mcp/                      # HTTP MCP server + dashboard REST API (runs in Docker)
├── sessions/                 # Session state machine and lifecycle manager
├── memory/                   # PostgreSQL persistence, pgvector embeddings, migrations
├── services/                 # Thin facades: forum, session, memory, permission, project
├── adapters/                 # CLI adapter registry (currently: claude)
├── utils/                    # TTS, transcription, aux LLM client, skills toolkit, stats
│
├── scripts/                  # Operational tooling
│   ├── supervisor.ts         # Health monitoring + auto-recovery (5 interval loops)
│   ├── tmux-watchdog.ts      # Watches Claude Code panes, auto-confirms prompts
│   ├── admin-daemon.ts       # Drains admin_commands table; executes host-side shell ops
│   ├── run-cli.sh            # Auto-restart wrapper for Claude Code CLI in tmux
│   ├── backup-db.sh          # Daily pg_dump + gzip + rotation (7 backups)
│   ├── save-session-facts.sh # Claude Code Stop hook; POSTs transcript to MCP API
│   └── helyx.service         # systemd service unit
│
├── dashboard/                # React + Vite admin SPA (sessions, memories, permissions)
│   ├── src/                  # Main dashboard app (served at port 3847)
│   └── webapp/               # Secondary Telegram Mini App SPA
├── claude/                   # Claude Code CLI wrapper (spawn, prompt, stream)
├── skills/                   # MCP skill definitions (Markdown)
├── cleanup/                  # Hourly maintenance jobs (log rotation, stale session cleanup)
├── prompts/                  # LLM prompt templates for skill curation/distillation
├── tests/
│   ├── unit/                 # 14 Bun unit test files
│   └── e2e/                  # Playwright E2E (api + dashboard projects)
├── docs/                     # Requirements, roadmap, spec, issues
├── guides/                   # Architecture, MCP tools, voice, webapp, memory guides
└── piper/                    # Piper TTS binary + voice model files
```

---

## Development Workflow

### Making Changes to the Bot (Docker side)

The bot (`main.ts`, `bot/`, `mcp/`, `sessions/`, `memory/`, `services/`) runs inside Docker. After code changes:

```bash
# Rebuild only the bot container (faster than full rebuild):
docker compose up -d --build bot

# Or use the CLI shorthand:
bun cli.ts restart
```

Wait for the health check to pass before testing (`docker compose ps` shows `healthy`).

### Making Changes to channel.ts (Host side)

`channel.ts` and everything under `channel/` run on the host machine, not in Docker. Changes take effect immediately on the next session start. To apply them to running sessions:

```bash
# Kill all channel.ts processes — Claude Code respawns them automatically:
helyx bounce      # down + up (restarts all tmux sessions)
# or to kill only channel processes without restarting tmux:
# (from Telegram: /bounce command, or via admin dashboard)
```

### Running Tests

```bash
# Unit tests:
bun test tests/unit/

# E2E tests (requires running bot + Playwright):
cd tests && npx playwright test --config=playwright.config.ts

# Coverage:
bun test --coverage tests/unit/
```

### Dashboard Development

```bash
cd dashboard
bun run dev    # Vite dev server with HMR (proxies API to running bot)
bun run build  # Production build (artifacts copied into Docker image)
```

### Running DB Migrations Manually

Migrations run automatically on Docker startup. To run them manually (e.g., during development without Docker):

```bash
bun memory/db.ts
```

### Running Cleanup Jobs

```bash
# Dry run (counts rows, no deletes):
DRY_RUN=true bun cleanup/runner.ts

# Actually clean:
bun cleanup/runner.ts
```

---

## Common Tasks

| Task | Command |
|---|---|
| Start all tmux sessions | `helyx up` |
| Stop all tmux sessions | `helyx down` |
| Restart all sessions (bounce) | `helyx bounce` |
| List session status | `helyx ps` |
| Register a new project | `helyx add /path/to/project` |
| Remove a project | `helyx remove <project-name>` |
| Start Docker bot | `docker compose up -d` |
| Stop Docker bot | `docker compose down` |
| Rebuild + restart Docker bot | `docker compose up -d --build bot` |
| Follow bot logs | `docker compose logs bot -f --tail 50` |
| Run DB backup | `helyx backup` |
| List active sessions | `helyx sessions` |
| Show bot health | `helyx status` |
| Re-register MCP servers | `helyx mcp-register` |
| Run cleanup dry run | `DRY_RUN=true bun cleanup/runner.ts` |
| Start admin daemon manually | `bun scripts/admin-daemon.ts` |

---

## Troubleshooting

### Bot starts but does not respond to Telegram messages

1. Verify `ALLOWED_USERS` contains your Telegram user ID (send `/start` to [@userinfobot](https://t.me/userinfobot) to find it).
2. Check that `TELEGRAM_BOT_TOKEN` is correct.
3. If using webhook mode, confirm `TELEGRAM_WEBHOOK_SECRET` is set and the public URL is reachable.
4. Run `docker compose logs bot -f` and look for `accessMiddleware: user not allowed`.

### channel.ts does not connect / Claude Code shows no MCP tools

1. Verify the MCP servers are registered: `claude mcp list` — you should see `helyx` and `helyx-channel`.
2. If missing, run `helyx mcp-register`.
3. Verify the Docker bot is running and healthy (`docker compose ps`). The `helyx` HTTP MCP endpoint at `http://localhost:3847/mcp` must be reachable from the host.
4. `channel.ts` pre-registers sessions via `POST /api/sessions/expect` before Claude Code connects. If the bot is down, this call fails silently and the session shows as standalone.
5. Check the `.env` loaded by `channel.ts`: `DATABASE_URL` must be reachable from the host (use `localhost:5433`, not the Docker-internal `postgres:5432`).

### PostgreSQL / DB not ready at startup

The bot waits for PostgreSQL's health check before starting (see `docker-compose.yml` `depends_on: condition: service_healthy`). If the bot container exits immediately:

```bash
docker compose logs postgres
docker compose logs bot
```

Common causes: wrong `POSTGRES_PASSWORD`, `pgdata` volume corruption, or the pgvector image failing to pull. Try `docker compose down -v && docker compose up -d` to reset (this deletes all data).

### Semantic memory search not working (recall returns nothing)

Ollama must be running and the `nomic-embed-text` model must be pulled:

```bash
ollama list              # check if nomic-embed-text is present
ollama pull nomic-embed-text
```

If Ollama was unreachable when memories were created, their embeddings are `NULL` and they will not appear in semantic search results. There is no background backfill job — you would need to re-save those memories.

### Supervisor sends "hasn't responded" alerts after 5 minutes

This is the response guard timer: if Claude Code does not call the `reply` MCP tool within 5 minutes of receiving a message, the bot sends a fallback message. Possible causes:
- Claude Code is stuck waiting for a shell command (check the tmux pane).
- Claude Code is waiting for a permission approval that was not delivered (check Telegram for a pending permission message).
- The `channel.ts` process crashed mid-conversation (the supervisor will auto-recover via `proj_start`).

### Permission prompts are not appearing in Telegram

The `tmux-watchdog` detects MCP permission prompts from the visible pane output. If prompts are not appearing:
1. Verify `admin-daemon.ts` is running (it starts the watchdog): `helyx status` or check `process_health` via `/monitor` in Telegram.
2. Confirm `TELEGRAM_BOT_TOKEN` is set in `.env` (the watchdog needs it to send messages).
3. Check that the `bots` tmux session exists: `tmux ls`.

### helyx command not found

The `helyx` wrapper is installed at `~/.local/bin/helyx`. Make sure `~/.local/bin` is on your `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.bashrc or ~/.zshrc
```

Alternatively, run commands directly:
```bash
bun --cwd /path/to/helyx /path/to/helyx/cli.ts up
```

### Dashboard login fails

The dashboard uses Telegram Login Widget. Ensure:
1. Your bot has a domain set in BotFather (`/setdomain`).
2. `JWT_SECRET` is consistent across restarts (auto-derived from `TELEGRAM_BOT_TOKEN` if not set — do not change the bot token after setting up accounts).

### Migrations fail on startup

Migrations are validated for strict ascending order. If you see a migration uniqueness or ordering error:

```bash
docker compose logs bot | grep migration
```

The gap between schema versions 22 and 39 is intentional (Skills Toolkit migrations were renumbered). Gaps are allowed; duplicate or out-of-order version numbers are not.
