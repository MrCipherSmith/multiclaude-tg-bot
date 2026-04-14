# PRD: Helyx Supervisor — Session & Health Watchdog

## 1. Overview

Helyx Supervisor is a continuously-running watchdog process that monitors all Helyx bot components: Claude Code sessions, message queues, voice status messages, and Docker containers. Upon detecting anomalies it automatically performs recovery, generates a human-readable diagnosis via LLM (gemma4:e4b / Ollama), and sends an alert to a dedicated Telegram topic. Any message in the supervisor topic triggers an interactive status response with LLM commentary.

Inspired by OpenClaw Gateway architecture: a central control plane with retry policy, session health tracking, and multi-agent routing.

---

## 2. Context

- **Product:** Helyx — Telegram bot managing Claude Code sessions
- **Module:** Extension of `scripts/admin-daemon.ts` + new `supervisor.ts` logic
- **User:** Single administrator (altsay)
- **Tech Stack:** TypeScript/Bun, PostgreSQL, Docker, tmux, Ollama (gemma4:e4b)
- **Deployment Modes:** Docker (bot + postgres containers) OR host process (bun main.ts)

---

## 3. Problem Statement

1. Sessions silently hang — channel subprocess dies but DB record stays "active"
2. `message_queue` accumulates unprocessed messages when poller fails
3. `active_status_messages` become Telegram zombies after bot crash
4. `voice_status_messages` stay stuck at "downloading..." indefinitely
5. Recovery requires full manual Docker restart
6. Telegram TTS 429 rate limit — no retry, voice messages are lost (just fixed; supervisor adds monitoring layer)
7. No single observability point for all session states

---

## 4. Goals

- Automatically detect and recover hung states without manual intervention
- Restart individual channel subprocesses without full Docker restart
- Use LLM (qwen3:8b via Ollama) for human-readable incident diagnosis
- Notify a dedicated Telegram topic for all incidents and recoveries
- Work in both deployment modes (Docker + host process)

---

## 5. Non-Goals

- Replacing existing `admin-daemon.ts` (extension, not replacement)
- Monitoring external services (Groq, Anthropic API, Yandex TTS) — local components only
- Automatic Docker restart when bot container dies (requires explicit confirmation)
- Web UI or separate dashboard (existing `/monitor` command is sufficient)

---

## 6. Functional Requirements

**FR-1: Session Health Monitoring**
Every 60 seconds, check `sessions` + `active_status_messages`:
- Session is active but `active_status_messages.updated_at` not refreshed >2 min → session "hung"
- Session is active but `message_queue` has unprocessed messages >5 min old → queue "stuck"

**FR-2: Message Queue Monitoring**
Every 60 seconds, check `message_queue`:
- Records with `delivered = false` older than 5 minutes → alert with inline buttons (🔄 Restart / ✅ Ignore)
- No auto-restart — user-driven via inline keyboard callback

**FR-3: Voice Status Recovery**
Every 5 minutes, check `voice_status_messages`:
- Records older than 3 minutes → edit Telegram message to "⚠️ Bot restarted — voice not processed. Resend." + delete from DB

**FR-4: Channel Subprocess Restart + Recovery Verification**
On hung session detection:
1. Send alert to supervisor topic
2. Insert `admin_commands(command='proj_start', payload={path})` → admin-daemon executes
3. Poll `active_status_messages` every 5s for 60s — wait for fresh heartbeat (< 30s old)
4. If heartbeat resumes → send ✅ recovery confirmed
5. If not recovered in 60s → send ⛔ alert with 🔄 retry button

**FR-5: LLM Diagnosis (gemma4:e4b via Ollama)**
For each incident and status query:
1. Call Ollama `/api/chat` with `think: false`, model `gemma4:e4b`
2. System prompt constrains model to Helyx monitoring context only (no off-topic responses)
3. Include LLM commentary in Telegram alert (best-effort, skipped if Ollama unavailable, 10s timeout)

**FR-6: Telegram Alerts**
Send all alerts to a dedicated topic (`SUPERVISOR_CHAT_ID` + `SUPERVISOR_TOPIC_ID`):
- Incident: type + project + elapsed time + LLM commentary
- Recovery: action taken + result (✅ confirmed or ⛔ failed)
- Status broadcast: every 5 minutes — sessions, queue, process health + LLM assessment
- Stuck queue alerts include inline buttons: 🔄 Перезапустить / ✅ Игнорировать
- All Telegram calls via shared `tgPost()` with 429 retry-after handling

**FR-7: admin-daemon Integration**
Supervisor runs inside `admin-daemon.ts` as additional `setInterval` loops, reusing the existing DB connection and `runShell`/`runCommand` utilities.

**FR-8: Supervisor Topic Chat**
Any message sent to the supervisor Telegram topic triggers an immediate status response:
- Live DB data: sessions, queue, process health
- LLM evaluation of current state, with the user's actual question forwarded to the model
- Model responds in Russian, staying within Helyx monitoring context

---

## 7. Non-Functional Requirements

**NFR-1:** Supervisor idle resource usage: <50MB RAM, <2% CPU
**NFR-2:** LLM diagnosis (gemma4:e4b) timeout: 10 seconds; never blocks recovery
**NFR-3:** When Ollama is unavailable — skip LLM, send alert without explanation
**NFR-4:** All actions logged to `process_health` table with type 'supervisor'
**NFR-5:** Alerts are idempotent — do not duplicate notifications for the same incident

---

## 8. Constraints

- Only monitors components tracked in DB (sessions without DB records are invisible)
- gemma4:e4b must be available in Ollama (already installed)
- `SUPERVISOR_CHAT_ID` and `SUPERVISOR_TOPIC_ID` must be set in `.env`
- Docker container restart requires docker group membership (already configured)
- admin-daemon must be running for tmux commands to execute

---

## 9. Edge Cases

- **Ollama unavailable:** send alert without LLM explanation, continue monitoring
- **Telegram API 429:** retry after `retry_after` seconds (same logic as TTS fix)
- **admin-daemon not running:** log error, skip admin_commands insertion
- **Incident persists >30 min:** escalate alert with "requires manual intervention" flag
- **Supervisor restart:** do not re-alert for already-closed incidents (check by timestamp)

---

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Supervisor — automatic recovery of hung sessions

  Scenario: Hung channel subprocess
    Given active_status_messages has a record with updated_at > 2 minutes ago
    When the supervisor loop fires
    Then supervisor inserts proj_start into admin_commands
    And admin-daemon restarts the tmux window
    And a Telegram alert with LLM explanation is sent to the supervisor topic
    And the record is deleted from active_status_messages

  Scenario: Stuck message queue
    Given message_queue has records with status='pending' older than 5 minutes
    When the supervisor loop fires
    Then supervisor resolves the project from session_id
    And inserts proj_start into admin_commands
    And sends a Telegram alert to the supervisor topic

  Scenario: Hung voice status message
    Given voice_status_messages has a record older than 3 minutes
    When supervisor checks voice statuses
    Then it edits the Telegram message to "⚠️ Bot restarted — voice not processed. Resend."
    And deletes the record from voice_status_messages

  Scenario: Ollama unavailable
    Given Ollama does not respond or returns an error
    When supervisor attempts LLM diagnosis
    Then supervisor skips LLM and sends alert without explanation
    And continues monitoring normally

  Scenario: Incident persists >30 minutes
    Given supervisor detected an incident more than 30 minutes ago
    And recovery attempts have not resolved it
    When supervisor loop fires again
    Then an escalated alert is sent with "requires manual intervention" note
```

---

## 11. Verification

- **Where to test:** Locally, simulating hangs via direct DB UPDATE
- **How to test:**
  - `UPDATE active_status_messages SET updated_at = now() - interval '5 minutes' WHERE key = 'test-key'`
  - Verify Telegram alert arrives within 60 seconds with LLM explanation
  - Verify tmux window was restarted
- **Observability:**
  - `process_health` table: 'supervisor' row with uptime and incident counter
  - `/monitor` bot command shows supervisor status
  - `/tmp/admin-daemon.log` contains full action log
