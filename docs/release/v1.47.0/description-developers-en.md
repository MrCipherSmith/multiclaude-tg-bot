# Helyx v1.47.0 — Technical Description for Developers

## The Problem

Claude Code is a powerful local coding assistant, but it is inherently terminal-bound. If you walk away from your machine, close the laptop lid, or want a quick status check from your phone, you lose access to the session. There is no built-in way to receive notifications when Claude finishes a long task, approve or deny a permission prompt mid-session, or inject a follow-up message without being at the keyboard.

Helyx solves this by making Telegram the control plane for one or more Claude Code sessions running on any reachable machine.

---

## Architecture Overview

Helyx has two runtime halves that communicate through a PostgreSQL message bus.

### Host-Side: `channel.ts` (stdio MCP)

A Bun process running on the host registers itself as an MCP server over stdio. Claude Code connects to it at startup via the standard MCP stdio transport. This channel process:

- Injects incoming Telegram messages (text, transcribed voice, photo descriptions) into Claude Code's context as if the user typed them.
- Captures Claude Code's output (tool calls, replies, permission requests, status updates) and forwards them to the bot process via PostgreSQL NOTIFY.
- Maintains a tmux pane watcher for live "Thinking… (N:NN)" status updates.

The host process runs under Bun directly — it is **not** containerized, because it needs to share a file system and process namespace with Claude Code.

### Docker-Side: HTTP MCP Server + Bot + Dashboard

A Docker Compose stack contains:

- **Bot process** (`bot.ts`, grammY): handles all Telegram interaction — message routing, inline button rendering, voice transcription dispatch, mini app serving.
- **HTTP MCP server**: receives tool call results from Claude Code (memory reads/writes, skill proposals, permission outcomes) over HTTP. This is the "MCP server" from Claude Code's perspective for all non-stdio tools.
- **Web dashboard** (React + Vite, port 3847): admin SPA for sessions, memories, permissions, API stats, logs, git browser.
- **PostgreSQL 16 + pgvector**: central message bus + persistent store. Vectors are embedded via Ollama `nomic-embed-text` running on the host.

### Data Flow (typical message)

```
User sends Telegram message
  → bot.ts receives via grammY webhook/polling
  → inserts into PostgreSQL queue (NOTIFY)
  → channel.ts picks up via LISTEN
  → writes to Claude Code stdin (MCP message)
  → Claude Code processes, produces response/tool call
  → tool call hits HTTP MCP server in Docker
  → HTTP server inserts result into PostgreSQL
  → bot.ts delivers response to Telegram thread
```

---

## Quick Start (4 Steps)

**Prerequisites:** Docker + Docker Compose, Bun ≥ 1.1, Claude Code installed, Anthropic API key, Telegram Bot Token (from @BotFather), Ollama running locally with `nomic-embed-text` pulled.

1. **Clone and configure**
   ```bash
   git clone https://github.com/MrCipherSmith/helyx
   cd helyx
   cp .env.example .env
   # Edit .env: TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, POSTGRES_*, OLLAMA_HOST
   ```

2. **Start the Docker stack**
   ```bash
   docker compose up -d
   # Runs migrations automatically on first start
   ```

3. **Register the channel MCP in Claude Code**

   Add to your global `~/.claude.json` or per-project `.claude/settings.json`:
   ```json
   {
     "mcpServers": {
       "helyx": {
         "command": "bun",
         "args": ["/path/to/helyx/channel/channel.ts"],
         "env": { "DATABASE_URL": "postgresql://..." }
       }
     }
   }
   ```

4. **Start a Claude Code session in a tmux pane**
   ```bash
   tmux new-session -s myproject
   claude  # or: claude --mcp-config ~/.claude.json
   ```

   Send a message from Telegram. It appears in Claude Code. Done.

---

## Key Integration Points

### CLAUDE.md injection

Helyx reads a `CLAUDE.md` from your project root and prepends it to the session context. This is how per-project instructions, tool permissions, and memory loading instructions reach Claude Code without manual copying.

### MCP tool registration

The HTTP MCP server exposes tools that Claude Code can call:
- `remember` / `recall` / `forget` — semantic memory CRUD backed by pgvector
- `propose_skill` / `save_skill` — Skills Toolkit workflow
- `reply` / `react` / `edit_message` — send content to Telegram from within a session
- `update_status` — update the "Thinking…" indicator
- `send_poll` — create a Telegram poll from a session

### Forum Supergroup routing

In forum mode, each project in the database maps to a `message_thread_id`. The bot reads the `project_id` from the incoming message's thread, looks up the associated Claude Code session, and routes accordingly. No session-switching command is needed from the user.

### Skills Toolkit

When Claude Code completes a non-trivial task, it can call `propose_skill` with a name, description, and reusable prompt body. The bot delivers an inline button to the user:

```
[Approve skill: "deploy-preview"] [Reject]
```

On approval, `save_skill` persists the skill to PostgreSQL. A weekly cron job (the "curator") runs LLM analysis over recent skill usage and posts a pin summary to the designated Telegram channel.

---

## Honest Assessment of Complexity

Helyx is not a one-click install. You need:

- **tmux**: Claude Code sessions must run in tmux panes for status tracking to work.
- **Docker + Compose**: the server-side stack (bot, MCP server, PostgreSQL) runs in containers.
- **Ollama**: the `nomic-embed-text` model must be available locally for embedding generation. Without it, semantic memory is unavailable.
- **Two separate MCP registrations**: the stdio channel and the HTTP server are both registered in Claude Code's MCP config.
- **Database migrations**: the migration system is custom (not Prisma/Drizzle); you run `bun run migrate` before first start and after updates.

If you want a simpler Claude Code companion, this is not it. Helyx is for developers who want deep, persistent, multi-project integration and are comfortable managing a small self-hosted stack.

---

## What Makes Helyx Different

Most Claude Code UIs focus on the IDE or terminal. Helyx treats the phone as the primary interface for async control and notification. The key differentiators:

- **Bidirectional, not just display** — you don't just watch Claude work; you inject messages, approve tool calls, and redirect the session mid-task.
- **Persistent across sessions** — memory and skills survive restarts; pgvector search means context compounds over time.
- **Multi-project, multi-session** — forum topics give each project its own lane without any manual routing work.
- **Open, composable** — MCP means any Claude Code tool can call back into Helyx; the PostgreSQL bus means adding new integrations is straightforward.

---

**License:** MIT
**GitHub:** https://github.com/MrCipherSmith/helyx
**Stack:** Bun · TypeScript · grammY · PostgreSQL 16 · pgvector · Ollama · Docker · React + Vite
