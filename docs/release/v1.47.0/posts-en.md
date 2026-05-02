# Helyx v1.47.0 — Ready-to-Post Content (English)

---

## Hacker News — Show HN

**Title:** Show HN: Helyx – control Claude Code from Telegram (approve tool calls, voice, forum mode)

**Body:**

I built Helyx because I kept walking away from my laptop mid-task and losing context. It's an open-source Telegram bot that bridges one or more Claude Code sessions: messages you send in Telegram appear inside Claude Code's context; Claude's responses, permission prompts, and live status updates come back to the same Telegram thread.

What it does that I haven't seen elsewhere:
- Destructive tool calls (file edits, shell commands) show up as inline Approve/Deny buttons in Telegram — no need to be at the terminal
- Forum Supergroup mode: one Telegram forum topic per project, auto-routed, no /switch commands
- Skills Toolkit: Claude proposes reusable skill prompts from session transcripts, you approve via button, weekly curator archives stale ones
- Persistent semantic memory: pgvector search, LLM deduplication, auto-summarization on idle
- Voice notes transcribed (Groq Whisper / local fallback); TTS replies via Piper/Kokoro/Yandex/Groq
- Web dashboard (React, port 3847) + Telegram Mini App for sessions, memories, permissions

Honest caveat: it's not simple to self-host. You need Docker, Bun, tmux, Ollama (for embeddings), and two MCP registrations in Claude Code. Takes ~30 minutes if you know what you're doing.

Stack: Bun, TypeScript, grammY, PostgreSQL 16 + pgvector, Ollama, React + Vite. MIT license.

https://github.com/MrCipherSmith/helyx

---

## Reddit r/SideProject — Post

**Title:** I built a Telegram bot to control Claude Code from my phone – approve file edits, get status updates, send voice messages

I got tired of being chained to my laptop when Claude Code was working on something. So I built Helyx — a self-hosted Telegram bridge for Claude Code sessions.

The basic loop: you message Telegram, it goes into Claude Code's context, Claude works, replies come back to Telegram. But the part I use every day is the permission gating: when Claude wants to edit a file or run a command, I get an Approve/Deny button in Telegram instead of a terminal prompt. Super useful when I'm away from the desk.

Other things I ended up adding: per-project forum topics (so multiple projects don't bleed into one chat), semantic memory with pgvector (Claude remembers facts across sessions), voice message transcription, and a Skills Toolkit where Claude proposes reusable workflow prompts that you can save with a tap.

Fair warning: this is not a one-click install. It needs Docker, Bun, tmux, and Ollama. But if you already run a home server or a VPS, the setup is manageable.

MIT, open source: https://github.com/MrCipherSmith/helyx

Happy to answer questions about the architecture — two MCP transports (stdio on host, HTTP in Docker) communicating through PostgreSQL was the interesting design challenge here.

---

## Reddit r/ClaudeAI — Post

**Title:** Open-source Telegram bridge for Claude Code – MCP permission buttons, forum mode, pgvector memory

Built a self-hosted bridge between Telegram and Claude Code that I've been using for a few months. Figured this community might find it interesting.

**How it works with MCP:** Two transports. A stdio MCP process on the host delivers Telegram messages into Claude Code. An HTTP MCP server in Docker exposes tools that Claude can call back: `remember`, `recall`, `propose_skill`, `reply`, `send_poll`, etc. PostgreSQL is the message bus between them.

**The permission flow:** When Claude Code triggers a tool call that matches the "requires approval" pattern, Helyx surfaces it as a Telegram inline button — Approve or Deny. Claude Code waits for the response. This is the thing I use most.

**v1.47.0 additions:** Forum Supergroup mode (per-project topics, auto-routing), Skills Toolkit (Claude proposes reusable MCP tool call sequences, you approve via button), better status tracking.

**What you need:** Claude Code + Anthropic API key, Docker, Bun, tmux, Ollama (nomic-embed-text for embeddings). Not trivial but not crazy if you're comfortable self-hosting.

MIT license. https://github.com/MrCipherSmith/helyx

---

## Twitter/X Thread

**Tweet 1 (hook):**
I got tired of being stuck at my laptop waiting for Claude Code to finish. So I built Helyx: control Claude Code from Telegram. Approve file edits with a button tap. Get status updates on your phone. Send voice messages. Thread 👇

**Tweet 2:**
The basic idea: messages you send in Telegram appear inside Claude Code as if you typed them. Responses come back to the same thread. Works while Claude is mid-task — you can inject follow-ups, redirect, or just check in.

**Tweet 3:**
When Claude wants to edit a file or run a shell command, instead of a terminal prompt you get this in Telegram:

"Claude wants to edit auth/login.ts — Allow or Deny?"
[Allow] [Deny]

Tap a button. Done. You can be on the couch.

**Tweet 4:**
Forum Supergroup mode: each project gets a dedicated Telegram topic. Status, replies, and permission prompts auto-route to the right topic. Multiple projects, no manual switching.

**Tweet 5:**
Under the hood: two MCP transports. stdio on host delivers messages into Claude Code. HTTP MCP server in Docker receives tool calls back. PostgreSQL is the bus. Ollama + pgvector for semantic memory that persists across sessions.

**Tweet 6:**
Also ships with: voice transcription (Groq Whisper), TTS replies (Piper/Kokoro/Yandex), a Skills Toolkit where Claude proposes reusable prompts from your sessions, a React dashboard at port 3847, and a Telegram Mini App.

**Tweet 7:**
Open source, MIT, self-hosted. Needs Docker + Bun + tmux + Ollama. Not a one-click install, but if you run your own server it's manageable. v1.47.0 is out now.

https://github.com/MrCipherSmith/helyx

---

## LinkedIn Post

**Headline:** Helyx v1.47.0: an open-source Telegram control plane for Claude Code

One of the friction points I kept running into with AI coding assistants: they're great when you're at your computer, and invisible when you're not.

Helyx is an open-source project I've been building to close that gap. It's a self-hosted Telegram bot that bridges one or more Claude Code sessions — so you can send instructions, review progress, and approve or deny actions from your phone, without being at a terminal.

The v1.47.0 release adds Forum Supergroup routing (each project gets its own Telegram topic, auto-routed), a Skills Toolkit for capturing reusable AI workflows across sessions, and a fully bidirectional MCP integration that lets Claude Code and Telegram communicate in both directions.

A few things I find genuinely useful in practice:

Permission gating — when Claude Code wants to edit a file or run a command, an inline Approve/Deny button appears in Telegram. No terminal, no SSH, just a tap.

Persistent semantic memory — facts about a project are stored in PostgreSQL with pgvector. LLM-based deduplication keeps the memory clean. Context compounds over time, across sessions.

Live status — "Thinking… (0:42)" updates while Claude works, sourced from the tmux pane. You know exactly where the session stands.

The architecture involves two MCP transports (stdio for message delivery, HTTP for tool callbacks), PostgreSQL as a message bus, and Ollama for local embeddings. The web dashboard is React + Vite. The whole stack runs in Docker Compose.

It's honest-to-goodness infrastructure work — not a one-click install. But for developers who want deep, async, multi-project control over Claude Code sessions without being glued to a keyboard, it's been worth building.

MIT license. https://github.com/MrCipherSmith/helyx
