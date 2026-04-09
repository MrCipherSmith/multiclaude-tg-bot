# Usage Scenarios

This guide covers the four main ways to run claude-bot. Choose based on your setup.

---

## Scenario 1: Laptop (single project, simple)

The simplest setup — run everything locally, connect one project at a time.

```bash
# 1. Start the bot (if not already running)
claude-bot docker-start

# 2. Open your project and connect
cd ~/my-project
claude-bot connect .
```

Open Telegram, type `/sessions` — your project appears. Send messages, voice, photos — Claude CLI processes them in this terminal.

Stop with `Ctrl+C`. Connect a different project at any time by running `claude-bot connect .` in another directory.

> **Note:** Without `--tmux`, real-time status updates ("Reading files...", "Running tests...") won't appear in Telegram. Everything else works: messages, permissions, replies.

---

## Scenario 2: Laptop with tmux (single project, full monitoring)

Same as above, but with live progress monitoring in Telegram:

```bash
claude-bot docker-start
cd ~/my-project
claude-bot connect . --tmux
```

Telegram shows what Claude is doing in real-time as it happens.

**How it works:** `--tmux` creates a tmux session and monitors its output. The bot reads the terminal lines and forwards them as status updates to Telegram.

---

## Scenario 3: Server (multiple projects, always-on)

For headless servers where you want multiple projects running 24/7 in persistent tmux sessions.

### Setup

```bash
# Register your projects
claude-bot add ~/project-a
claude-bot add ~/project-b
claude-bot add ~/project-c

# Start all at once in tmux (separate windows)
claude-bot up -a

# Or all visible at once as split panes
claude-bot up -a -s
```

Each project runs in its own tmux window (or pane with `-s`) with auto-restart on crash.

### Connect from SSH

```bash
ssh user@server -t "tmux attach -t bots"
```

### Project management

```bash
claude-bot ps                     # List configured projects and status
claude-bot up -a                  # Start all + attach (windows layout)
claude-bot up -a -s               # Start all + attach (split panes layout)
claude-bot down                   # Stop all sessions + clean DB
claude-bot remove project-b       # Remove project from config
```

### Tmux navigation

Press `Ctrl+B`, release, then the key:

| Mode | Key | Action |
|---|---|---|
| Windows | `N` / `P` | Next / previous window |
| Windows | `W` | List all windows |
| Windows | `0-9` | Jump to window by number |
| Panes | `Arrow` | Move to adjacent pane |
| Panes | `Z` | Zoom current pane (toggle fullscreen) |
| Panes | `Q` + digit | Jump to pane by number |
| Both | `D` | Detach from tmux (bot keeps running) |

---

## Scenario 4: Remote (laptop → server)

Run the bot on a server, connect and work from your laptop via SSH tunnel.

See [Remote Laptop Setup](remote-laptop-setup.md) for a full walkthrough.

Quick summary:
```bash
# On your laptop:
claude-bot remote   # Interactive wizard
```

The wizard sets up SSH tunnels and registers MCP servers on your laptop so Claude CLI can communicate with the remote bot.
