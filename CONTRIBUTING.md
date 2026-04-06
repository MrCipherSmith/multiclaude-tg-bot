# Contributing

Thanks for your interest in contributing to Claude Bot! This guide will help you get started.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) (runtime)
- [Docker](https://docs.docker.com/engine/install/) (for PostgreSQL)
- [Ollama](https://ollama.com/download) (for embeddings)

### Local Development Setup

```bash
# Clone the repo
git clone https://github.com/MrCipherSmith/multiclaude-tg-bot.git
cd multiclaude-tg-bot

# Install dependencies
bun install
cd dashboard && bun install && cd ..

# Set up environment
cp .env.example .env
# Edit .env with your Telegram bot token, user ID, etc.

# Start PostgreSQL
docker compose up -d postgres

# Run in development mode
bun dev
```

### Dashboard Development

```bash
cd dashboard
bun run dev    # Vite dev server with HMR
bun run build  # Production build
```

## How to Contribute

### Reporting Bugs

- Check [existing issues](https://github.com/MrCipherSmith/multiclaude-tg-bot/issues) first
- Include steps to reproduce, expected vs actual behavior
- Include relevant logs (`docker compose logs bot`)

### Suggesting Features

- Open a [GitHub Issue](https://github.com/MrCipherSmith/multiclaude-tg-bot/issues/new) with the `enhancement` label
- Describe the use case and why it would be useful

### Pull Requests

1. Fork the repository
2. Create a feature branch from `main` (`git checkout -b feature/my-feature`)
3. Make your changes
4. Test locally (bot starts, dashboard builds, no TypeScript errors)
5. Commit with a descriptive message (see [Commit Style](#commit-style))
6. Push and open a Pull Request

### Commit Style

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new MCP tool for file uploads
fix: handle 429 rate limit in OpenRouter streaming
docs: update installation guide for macOS
refactor: extract retry logic into shared utility
```

Prefixes: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

## Project Structure

```
├── main.ts              # Entry point, server setup, cleanup timer
├── config.ts            # Centralized environment config
├── channel.ts           # stdio channel adapter for CLI sessions
├── cli.ts               # CLI tool (setup, connect, manage)
├── bot/
│   ├── bot.ts           # grammY bot creation, access middleware
│   ├── handlers.ts      # Handler registry, shared state (pendingInput, botRef)
│   ├── streaming.ts     # LLM streaming with Telegram message edits
│   ├── format.ts        # Markdown → Telegram HTML converter
│   ├── text-handler.ts  # Main text message routing
│   ├── media.ts         # Voice, photo, document, video handlers
│   ├── callbacks.ts     # Inline keyboard callback handlers
│   └── commands/
│       ├── session.ts   # /sessions, /switch, /rename, /cleanup
│       ├── memory.ts    # /remember, /recall, /forget, /summarize
│       └── admin.ts     # /stats, /logs, /status, /tools
├── claude/
│   ├── client.ts        # Multi-provider LLM client with retry
│   └── prompt.ts        # System prompt composition
├── memory/
│   ├── db.ts            # PostgreSQL schema, versioned migrations
│   ├── short-term.ts    # In-memory message cache (LRU)
│   ├── long-term.ts     # Semantic memory (pgvector)
│   ├── embeddings.ts    # Ollama embeddings with retry
│   └── summarizer.ts    # Auto-summarization on idle/overflow
├── sessions/
│   ├── manager.ts       # Session lifecycle management
│   ├── router.ts        # Chat → session routing
│   └── delete.ts        # Transactional cascade delete
├── mcp/
│   ├── server.ts        # HTTP MCP server, auth, health
│   ├── tools.ts         # MCP tool definitions (JSON Schema)
│   ├── bridge.ts        # MCP session ↔ Telegram bridge
│   └── dashboard-api.ts # Dashboard REST API + static serving
├── dashboard/           # React + Tailwind dashboard (Vite)
│   ├── auth.ts          # JWT + Telegram Login verification
│   └── src/
│       ├── pages/       # Overview, Sessions, Stats, Logs, Memory
│       ├── components/  # SlidePanel, UI components
│       └── api/         # Typed API client
└── utils/
    ├── stats.ts         # API/transcription stats recording + queries
    ├── transcribe.ts    # Voice transcription (Groq + Whisper)
    └── files.ts         # File download helpers
```

## Code Style

- **TypeScript** — strict types, no `any` where avoidable
- **No semicolons** — Bun/project convention
- **Functional style** — prefer functions over classes
- **Error handling** — log errors with `[module]` prefix, don't swallow silently
- **i18n** — dashboard strings go in `dashboard/src/i18n.ts` (EN + RU)

## Questions?

Open an issue or start a [discussion](https://github.com/MrCipherSmith/multiclaude-tg-bot/issues). We're happy to help!
