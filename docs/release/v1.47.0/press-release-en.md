# FOR IMMEDIATE RELEASE

## Helyx v1.47.0: Open-Source Telegram Bridge for Claude Code Releases with Forum Mode, Skills Toolkit, and Full MCP Integration

**May 1, 2026** — The Helyx project today announced the release of version 1.47.0 of its open-source Telegram-to-Claude Code bridge, adding Forum Supergroup routing, a Skills Toolkit for capturing reusable AI workflows, and a dual MCP transport layer that tightly integrates Claude Code sessions with Telegram-native controls.

Helyx lets developers control one or more Claude Code CLI sessions from their Telegram client. Messages, voice notes, and photos sent in Telegram arrive inside Claude Code's context; Claude's responses, tool permission requests, and live status updates flow back to the same Telegram thread. The system is entirely self-hosted and runs on any machine where Docker and Bun are available.

### Key Features in v1.47.0

- **Forum Supergroup mode** — Each project maps to a dedicated Telegram forum topic. Status updates, permission prompts, and replies auto-route to the correct topic without manual `/switch` commands.
- **Dual MCP transport** — A stdio channel process (running on the host) delivers user messages into Claude Code; a Docker-hosted HTTP MCP server receives tool call results back, creating a clean bidirectional bus.
- **Skills Toolkit** — Claude proposes reusable skills extracted from session transcripts. Developers approve proposals via Telegram inline button; a weekly curator agent auto-pins active skills and archives stale ones.
- **Permission gating** — Destructive tool calls (file edits, shell commands) surface as Telegram inline approve/deny buttons. Auto-approve patterns can be configured for trusted operations.
- **Persistent memory with semantic search** — PostgreSQL 16 + pgvector stores session facts; `rememberSmart` uses LLM-based deduplication to avoid redundant entries; idle sessions trigger auto-summarization.
- **Live status spinner** — "Thinking… (0:12)" updates while Claude works, sourced from tmux pane output.
- **Web dashboard** — A React/Vite admin SPA at port 3847 provides session management, memory browser, permissions log, API stats, and a git file browser.
- **Telegram Mini App** — A lightweight in-Telegram panel covering git browser, permissions, and session health.
- **Voice support** — Transcription via Groq Whisper with a local fallback; TTS replies via Piper, Kokoro, Yandex, or Groq.
- **Standalone mode** — The bot can call Anthropic, Google AI, OpenRouter, or Ollama directly without an active Claude Code session.
- **Codex review integration** — `/codex_review` runs OpenAI Codex CLI for AI-assisted code reviews from Telegram.

### Quote

> "We built Helyx because we wanted to review a pull request from the couch without opening a laptop. It turned into a full control plane for Claude Code — with approvals, memory, voice, and now per-project forum topics. Everything we needed, nothing we didn't."
> — The Helyx Team

### Technical Details

Helyx is built on Bun and TypeScript, using the grammY Telegram framework. The persistence layer is PostgreSQL 16 with the pgvector extension, using Ollama's `nomic-embed-text` model for embedding generation. The web dashboard is a standalone React + Vite SPA. Deployment requires Docker Compose; the host-side channel process runs under Bun directly. A working Claude Code installation with an active Anthropic API key is required for full operation.

The project ships with a complete Docker Compose stack, database migration tooling, and a `CLAUDE.md` template for per-project context injection.

### Availability

Helyx v1.47.0 is available now under the MIT License.

**GitHub:** https://github.com/MrCipherSmith/helyx

Releases, issue tracking, and documentation are managed through the GitHub repository. Self-hosting instructions and configuration reference are available in the project README.

### About Helyx

Helyx is an open-source project maintained by independent developers. It is not affiliated with Anthropic, Telegram, or OpenAI. Claude Code is a product of Anthropic.

---

*Press contact: see GitHub repository for maintainer contact information.*
