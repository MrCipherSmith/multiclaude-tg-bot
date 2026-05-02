# Helyx — Control Claude Code from Telegram

**Helyx** is a free, open-source bot that connects your Telegram to Claude Code running on your computer or server. You don't need to be at your keyboard to ask Claude to write code, review a PR, or check on a long-running task — just open Telegram and message the bot.

---

## What It Does

- **Chat with Claude Code remotely** — Send a message in Telegram, Claude Code receives it, works on your codebase, and replies in the same thread.
- **Voice messages** — Speak your request; Helyx transcribes it and forwards it to Claude.
- **Photo support** — Send a screenshot or diagram; Claude sees it.
- **Permission prompts as buttons** — When Claude wants to edit a file or run a command, you get an inline Approve / Deny button in Telegram instead of having to type at the terminal.
- **Live status** — See "Thinking… (0:42)" update in real time while Claude is working.
- **Per-project forum topics** — Each project gets its own chat topic. Everything routes automatically — no need to manually switch sessions.
- **Memory** — Helyx remembers facts about your projects across sessions and surfaces them when relevant.
- **Voice replies** — Claude can read its responses aloud using text-to-speech.
- **Web dashboard** — A browser-based panel shows sessions, memories, permission logs, and API usage.

---

## Who It's For

- Developers who want to use Claude Code without being tied to a terminal.
- Anyone who wants to review code, check a build status, or approve a file edit from their phone.
- Teams self-hosting AI coding assistants.

---

## Requirements

Helyx is self-hosted — it runs on your own machine, not a cloud service. You need:

- A computer or server with Docker and an internet connection
- A [Claude Code](https://claude.ai/code) installation with an Anthropic API key
- A Telegram account
- About 15 minutes to set up

Your data stays on your machine. Helyx doesn't send anything to external services except Telegram messages (which go through Telegram's API) and Claude Code requests (which go through Anthropic's API, same as using Claude Code normally).

---

## Get Started

GitHub: **https://github.com/MrCipherSmith/helyx**

Setup instructions are in the project README. The full stack runs with `docker compose up`.
