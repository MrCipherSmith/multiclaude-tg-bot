# PRD: OpenCode TUI Integration

## 1. Overview

Integrate OpenCode as a second CLI backend alongside Claude Code. The bot registers OpenCode sessions, auto-starts `opencode serve` in tmux, shares a session ID with the TUI, and forwards all assistant responses to Telegram via a persistent SSE monitor.

---

## 2. Context

- **Product:** Claude Bot (Telegram → AI CLI bridge)
- **Module:** `adapters/opencode-monitor.ts`, `adapters/opencode.ts`, `cli.ts`, `mcp/server.ts`, `scripts/run-opencode.sh`
- **Backend:** [OpenCode](https://opencode.ai) — TUI-based AI coding tool with HTTP serve mode
- **Implemented:** commits ba1103e, 359f738, 34b907d, f8fbd3c, 195c9df

---

## 3. Problem Statement

Claude Code uses a stdio channel adapter (`channel.ts`) that is tightly coupled to the MCP protocol. OpenCode uses a different model: it exposes an HTTP server with SSE event stream. This requires:
1. A new session type (`cli_type = 'opencode'`) in the DB
2. A new adapter that speaks the OpenCode HTTP API
3. A persistent SSE monitor inside the bot to receive responses
4. CLI tooling to launch OpenCode in the right configuration

---

## 4. Goals

- Register OpenCode projects from CLI (`--provider opencode`) and from Telegram (`/add`)
- Auto-start `opencode serve` in a named tmux session
- Share a session ID so TUI and Telegram see the same conversation
- Forward all assistant responses (TUI-originated or Telegram-originated) to Telegram
- Handle disconnections gracefully with auto-reconnect

---

## 5. Non-Goals

- Replacing Claude Code support (both providers coexist)
- Handling OpenCode file diffs / permission requests (not in OpenCode's protocol)
- Running OpenCode inside Docker (it runs on host only)
- Multi-user / multiple TUI windows per project

---

## 6. Architecture

```
Telegram ─→ Bot (Docker) ─→ HTTP POST :4096/v1/session/:id/send ─→ opencode serve (host)
                                                                         ↓
                                                               OpenCode TUI processes
                                                                         ↓
Bot (Docker) ←─ SSE /event ←─────────────────────────────── opencode serve (host)
     ↓
Telegram (edit message with accumulated response)
```

Two message origins:
- **Telegram-originated**: Bot sends to opencode, sets `pending` message ID, monitor edits it
- **TUI-originated**: No pending ID, monitor sends a new message to last active chat

---

## 7. Functional Requirements

### Session Registration

**FR-1:** CLI `claude-bot add --provider opencode [dir]` calls `/api/sessions/register` with `{ cliType: "opencode", cliConfig: { port, autostart, tmuxSession } }`

**FR-2:** `/api/sessions/register` validates `cliType ∈ { "claude", "opencode" }` and sanitizes `cliConfig` (port range 1024–65535, tmuxSession alphanum pattern)

**FR-3:** On successful opencode session registration, bot starts `opencodeMonitor.start(sessionId)` immediately

**FR-4:** Session name auto-derived as `<basename(path)> · opencode` if no `--name` given

### OpenCode Serve Launch

**FR-5:** CLI wizard (`claude-bot add --provider opencode`) auto-starts `opencode serve` in a persistent tmux session named after the project

**FR-6:** `scripts/run-opencode.sh` encapsulates the serve launch: creates tmux session if absent, starts `opencode serve --hostname 0.0.0.0 --port <port>`

**FR-7:** After serve starts, CLI launches the OpenCode TUI with `--session <shared-session-id>` (the bot session ID) so TUI and bot share conversation state

**FR-8:** On TUI exit, CLI posts to `/api/sessions/disconnect` with `projectPath` to mark session as disconnected

### SSE Monitor (opencode-monitor.ts)

**FR-9:** `opencodeMonitor.startAll()` called on bot startup — starts monitoring all active `cli_type='opencode'` sessions

**FR-10:** Each session has its own `AbortController`; `stop(sessionId)` aborts and cleans up

**FR-11:** SSE connection target: `http://<OPENCODE_HOST>:<port>/event` (default host: `localhost`, override via `OPENCODE_HOST` env)

**FR-12:** On connection failure, wait `RECONNECT_DELAY_MS = 5000` and retry (while not aborted)

**FR-13:** Filter SSE events by `opencodeSessionId` stored in `cli_config` if present — ignore events from other sessions

**FR-14:** Handle event type `message.updated` — track assistant message IDs

**FR-15:** Handle event type `message.part.updated`:
- Only process parts from tracked assistant message IDs
- Accumulate text delta from `part.text`
- First chunk: resolve target chat (pending message or last active chat from DB)
- Throttle Telegram edits to max 1 per `EDIT_INTERVAL_MS = 1500ms`

**FR-16:** Handle event type `session.status` with `status.type === "idle"`:
- Send final edit with complete accumulated text
- Reset accumulation state for next response

**FR-17:** Telegram-originated message flow:
- `handleText` calls `opencodeMonitor.setPending(sessionId, chatId, messageId)` before sending to opencode
- Monitor uses this pending entry to edit the existing message instead of sending a new one
- Pending entry is consumed on first chunk

**FR-18:** TUI-originated message flow:
- No pending entry → monitor queries DB for last `user` message `chat_id` in session
- Sends new message to that chat

### HTTP Adapter (opencode.ts)

**FR-19:** `opencodeAdapter.sendMessage(cliConfig, sessionId, text)` — POST `/v1/session/:id/send`

**FR-20:** `opencodeAdapter.listModels(cliConfig)` — GET `/v1/models` → returns string array

**FR-21:** `opencodeAdapter.listProviders(cliConfig)` — GET `/v1/providers` → returns `{ id, name, configured }[]`

**FR-22:** `opencodeAdapter.subscribeToResponses(cliConfig, sessionId, callback)` — EventSource on `/event`, filter by session, call `callback(text)` on idle

**FR-23:** All adapter calls use port from `cli_config.port` (default 4096) and host `host.docker.internal` (Docker) or `localhost` (bare metal)

### Disconnect / Cleanup

**FR-24:** `/api/sessions/disconnect` (POST, local-only) sets `sessions.status = 'disconnected'` for all opencode sessions matching `projectPath`

**FR-25:** `opencodeMonitor.stop(sessionId)` called when session disconnects

---

## 8. Non-Functional Requirements

**NFR-1:** SSE reconnect must not produce duplicate Telegram messages on reconnect

**NFR-2:** Edit throttle (1500ms) prevents Telegram rate-limit errors (30 edits/s limit)

**NFR-3:** Bot restart must resume monitoring all previously active opencode sessions (via `startAll()`)

**NFR-4:** `OPENCODE_HOST` env var overrides default host for flexibility (e.g., remote server)

**NFR-5:** `opencodeSessionId` in `cli_config` is optional — if absent, monitor receives all session events on that port

**NFR-6:** Monitor runs in background — never blocks the main bot event loop

---

## 9. Configuration

| ENV Variable | Default | Description |
|-------------|---------|-------------|
| `OPENCODE_HOST` | `localhost` | Host where opencode serve is running |
| `HOST_CLAUDE_CONFIG` | `/host-claude-config` | Docker mount of ~/.claude for tools-reader |

| cli_config field | Type | Description |
|-----------------|------|-------------|
| `port` | number | opencode serve port (default 4096) |
| `autostart` | boolean | Auto-start serve on connect (future) |
| `tmuxSession` | string | Tmux session name for opencode serve |
| `model` | string | Currently selected model |
| `opencodeSessionId` | string | OpenCode session UUID for SSE filtering |

---

## 10. Edge Cases

- **Port conflict:** Two opencode projects on same port → undefined behavior; user must assign different ports
- **SSE stream drops mid-response:** Reconnect; partial Telegram message may show incomplete text until next idle event
- **No active chat for TUI message:** `_getLastChatId` returns undefined → message is silently dropped
- **Pending entry stale:** If bot restarts mid-response, pending map is cleared; next response creates new message
- **opencode serve slow to start:** CLI retries serve health check before launching TUI
- **Multiple bot instances:** Two bots monitoring same port → duplicate Telegram messages; unsupported

---

## 11. Acceptance Criteria (Gherkin)

```gherkin
Feature: OpenCode TUI Integration

  Scenario: Register OpenCode project via CLI
    Given opencode is installed on host
    When user runs: claude-bot add ~/my-project --provider opencode
    Then CLI starts opencode serve in tmux session "my-project-opencode"
    And CLI calls POST /api/sessions/register with cliType=opencode
    And bot starts opencodeMonitor for the new session
    And CLI launches TUI with --session <bot-session-id>

  Scenario: Telegram message forwarded to OpenCode
    Given active opencode session with serve running at :4096
    When user sends "refactor this function" in Telegram
    Then bot sends a "Working..." status message
    And posts text to opencode serve /v1/session/:id/send
    And setPending(sessionId, chatId, messageId) is called

  Scenario: OpenCode response streamed to Telegram
    Given pending message exists for session
    When opencode serve emits message.part.updated events
    Then bot accumulates text and edits the pending message every 1.5s
    When session.status idle event arrives
    Then bot sends final edit with complete response text

  Scenario: TUI-originated message reaches Telegram
    Given user typed a message directly in the OpenCode TUI
    When opencode serve emits the response events
    And there is no pending Telegram message
    Then monitor queries last active chat_id from DB
    And sends new Telegram message with the response

  Scenario: SSE connection drops and reconnects
    Given opencode monitor is running for session #5
    When opencode serve restarts
    Then monitor detects connection error
    And waits 5 seconds
    And reconnects to the SSE endpoint
    And resumes forwarding responses

  Scenario: Bot restart resumes monitoring
    Given two active opencode sessions (#3 and #7) in DB
    When bot restarts
    Then opencodeMonitor.startAll() starts monitors for sessions #3 and #7
    And both sessions continue receiving responses in Telegram

  Scenario: TUI exits gracefully
    Given opencode TUI is running with shared session
    When user exits the TUI (Ctrl+C)
    Then CLI script posts to /api/sessions/disconnect
    And session status is set to disconnected
    And opencodeMonitor.stop(sessionId) is called
```

---

## 12. Related Documents

- `docs/requirements/provider-management-2026-04-06/` — PRD for /add /model /connections
- `docs/requirements/readme-update-2026-04-06/` — Documentation analysis
- `adapters/opencode-monitor.ts` — Implementation reference
- `adapters/opencode.ts` — HTTP adapter reference
- `scripts/run-opencode.sh` — Serve launcher
