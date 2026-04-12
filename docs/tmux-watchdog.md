# tmux-watchdog

`scripts/tmux-watchdog.ts` — host-side daemon that monitors active Claude Code sessions for problems and routes alerts + actions to Telegram.

Runs inside `admin-daemon` (started automatically by `helyx up`).

---

## Why it exists

Claude Code sessions run in tmux panes on the host. Certain problems are invisible to the bot's Docker container:

- **External MCP tool permissions** — docker, github, and other MCP servers show an interactive permission dialog in the terminal. The bot's `permission_request` channel only covers built-in tools (Bash, Edit, Read).
- **Stall / MCP transport hang** — if the helyx channel process deadlocks (e.g. `telegramRequest` hangs), Claude keeps showing a spinner but `last_active` stops updating. Invisible without polling the tmux pane.
- **Interactive editor** — `git commit` without `-m` opens vim/nano in the pane; the session blocks indefinitely.
- **Credential prompts** — git push/pull or SSH may ask for a password/passphrase; session blocks indefinitely.
- **Crash / restart** — `run-cli.sh` wraps Claude Code in an auto-restart loop; a crash emits `[run-cli] Exited with code N` in the pane.

---

## Architecture

```
admin-daemon (host)
└── startTmuxWatchdog(sql, token)
      │
      ├─ every 5 s: fetchActiveSessions() ← queries sessions WHERE status='active'
      │
      └─ for each active session's tmux window:
            capturePane()
            ├─ detectPermissionPrompt → send Telegram buttons, poll DB, tmux send-keys
            ├─ detectSpinner + stale last_active → stall alert [⚡ Interrupt]
            ├─ detectEditor → editor alert [📝 Force close]
            ├─ detectCredential → credential alert (informational)
            └─ detectCrash → crash alert (informational)
```

**Only active sessions are inspected.** Sessions with `status != 'active'` or without a tmux window are skipped. This prevents polling idle projects.

---

## Detectors

### 1. Permission prompts

Trigger: `Do you want to proceed?` + `❯ 1. Yes` visible in the pane.

Sent to: Telegram with **✅ Yes / ✅ Always / ❌ No** inline buttons.

Flow:
1. Watchdog sends a Telegram message with `perm:allow/always/deny:ID` buttons (same format as built-in permissions).
2. Row inserted into `permission_requests` with `tmux_target = "bots:WINDOW"`.
3. Watchdog polls DB for `response IS NOT NULL`.
4. On response: `tmux send-keys "1"/"2"/"3" Enter` → Claude Code receives the key.
5. If prompt disappears before response (user answered in terminal): edit message to "⚡ Resolved in terminal".
6. Timeout (10 min): auto-deny, key `"3"` sent.

Tool name extraction (in order of priority):
- `mcp__server__tool_name` pattern in context lines
- `server - tool_name (MCP)` pattern
- `server wants to use tool_name` pattern
- Fallback: `mcp:unknown`

The **Always** action writes the tool name to `settings.local.json` (via `callbacks.ts`), so Claude Code auto-approves it in future sessions.

---

### 2. Stall detection

Trigger: spinner line (`·`, `✶`, or `✻`) visible **and** `last_active < NOW() - 2.5 min`.

`last_active` is renewed every ~60 s by the channel lease renewal in `channel/index.ts`. If it goes stale for 2.5 min while a spinner is visible, the MCP channel is hung.

Alert includes **[⚡ Interrupt]** button — sends `tmux send-keys Escape` followed by auto-confirm if Claude shows a confirmation prompt.

Cooldown: re-alerts at most once per 10 min. Resets automatically when activity resumes.

---

### 3. Editor open

Trigger: vim mode indicator (`-- INSERT --`, `-- NORMAL --`, etc.) or nano chrome (`^G Get Help`, `^X Exit`) in the last 20 lines.

Typically caused by `git commit` without `-m` during Claude's git workflow.

Alert includes **[📝 Force close]** button — sends `Escape` then `:q!` `Enter` to force-quit vim without saving.

Cooldown: once per 5 min. Resets when the editor closes (patterns disappear).

---

### 4. Credential prompts

Trigger: last 5 lines contain a line matching:
```
/(password|passphrase|username for\s+['"]https?:|token).*:\s*$/i
```

Examples:
- `Password:`
- `Enter passphrase for key '/home/user/.ssh/id_rsa':`
- `Username for 'https://github.com':`

Informational alert only — no action button (credential must be supplied or SSH keys configured).

Cooldown: once per 5 min.

---

### 5. Crash / restart

Trigger: `[run-cli] Exited with code N` (N ≥ 1) in last 10 lines.

`run-cli.sh` wraps Claude Code in an auto-restart loop with `RESTART_DELAY=5` seconds. The alert is informational — the session will recover automatically.

Cooldown: once per 3 min.

---

## Action buttons

Two actions route via `admin_commands` → `admin-daemon` → `tmux send-keys`:

| Button | Callback data | Admin command | tmux keys sent |
|--------|--------------|---------------|----------------|
| ⚡ Interrupt | `tmux:esc:PROJECT` | `tmux_send_keys {action:"esc"}` | `Escape` + auto-confirm `Enter` |
| 📝 Force close | `tmux:close_editor:PROJECT` | `tmux_send_keys {action:"close_editor"}` | `Escape` + `:q!` `Enter` |

The bot (in Docker) never executes tmux commands directly — it only inserts into `admin_commands`. The host-side `admin-daemon` executes them.

---

## Configuration

No configuration needed. The watchdog starts automatically when `admin-daemon` has `TELEGRAM_BOT_TOKEN` available (loaded from `.env`).

```
[watchdog] started (poll interval: 5 s)
```

If `TELEGRAM_BOT_TOKEN` is missing:
```
[admin-daemon] TELEGRAM_BOT_TOKEN not set — tmux watchdog disabled
```

---

## DB schema additions

**Migration v16** (`memory/db.ts`):
```sql
ALTER TABLE permission_requests ADD COLUMN IF NOT EXISTS tmux_target TEXT;
```

Nullable. Only set for watchdog-originated permission requests. Used by the `pollPermissionResponse` loop to know which tmux pane to send keys to.

---

## Tests

`tests/unit/tmux-watchdog.test.ts` — 64 tests covering all pure detection functions:

- `stripAnsi` — ANSI escape stripping
- `detectPermissionPrompt` — signal detection, tool name extraction (3 formats), multi-prompt buffers
- `detectSpinner` — spinner char variants, 10-line window
- `detectEditor` — vim modes, nano chrome
- `detectCredential` — password/passphrase/username/token, URL patterns, 5-line window
- `detectCrash` — exit code extraction, clean exit ignored, 10-line window
- `canAlert` / `markAlerted` — cooldown logic, per-kind independence
- `behaviorToKey` — Telegram response → tmux key mapping
