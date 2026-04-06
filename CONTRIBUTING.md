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
├── main.ts              # Entry point, server setup
├── bot/                 # Telegram bot handlers
├── claude/              # LLM client (Anthropic, Google AI, OpenRouter, Ollama)
├── memory/              # Database, embeddings, summarization
├── mcp/                 # MCP server, tools, dashboard API
├── utils/               # Stats, transcription, helpers
├── dashboard/           # React + Tailwind dashboard (Vite)
│   └── src/
│       ├── pages/       # Dashboard pages
│       ├── components/  # Shared components
│       └── api/         # API client
├── channel.ts           # stdio channel adapter for CLI sessions
├── cli.ts               # CLI tool (setup, connect, manage)
└── config.ts            # Environment config
```

## Code Style

- **TypeScript** — strict types, no `any` where avoidable
- **No semicolons** — Bun/project convention
- **Functional style** — prefer functions over classes
- **Error handling** — log errors with `[module]` prefix, don't swallow silently
- **i18n** — dashboard strings go in `dashboard/src/i18n.ts` (EN + RU)

## Questions?

Open an issue or start a [discussion](https://github.com/MrCipherSmith/multiclaude-tg-bot/issues). We're happy to help!
