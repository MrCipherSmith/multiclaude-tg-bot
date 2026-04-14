# PRD: Helyx Supervisor (AI-Readable)

## METADATA
```json
{
  "feature": "helyx-supervisor",
  "version": "1.0.0",
  "date": "2026-04-14",
  "type": "architecture-change",
  "scope": ["scripts/admin-daemon.ts", "scripts/supervisor.ts (new)"],
  "stack": ["TypeScript", "Bun", "PostgreSQL", "Docker", "tmux", "Ollama"],
  "deployment_modes": ["docker", "host-process"],
  "inspired_by": "OpenClaw Gateway pattern"
}
```

---

## PROBLEM_CONSTRAINTS
```json
{
  "existing_infrastructure": {
    "admin_daemon": "scripts/admin-daemon.ts — polls admin_commands table, executes tmux/docker commands",
    "db_tables": [
      "sessions",
      "active_status_messages",
      "message_queue",
      "pending_replies",
      "voice_status_messages",
      "process_health",
      "admin_commands"
    ],
    "ollama_models": ["qwen3:8b", "nomic-embed-text"],
    "tmux_session": "bots",
    "docker_services": ["bot", "postgres"]
  },
  "known_failure_modes": [
    "channel subprocess dies → active_status_messages.updated_at stops updating",
    "message_queue poller crashes → pending messages accumulate",
    "voice download hangs → voice_status_messages record stuck",
    "TTS 429 → voice not sent (fixed in sendVoice retry, supervisor adds monitoring)"
  ]
}
```

---

## FUNCTIONAL_REQUIREMENTS

### FR-1: SESSION_HEALTH_MONITOR
```
INTERVAL: 60s
QUERY: SELECT s.id, s.project, asm.updated_at, asm.started_at
       FROM sessions s
       JOIN active_status_messages asm ON asm.session_id = s.id
       WHERE s.status = 'active'
         AND asm.updated_at < NOW() - INTERVAL '2 minutes'
TRIGGER: hung_session
ACTION: insert admin_commands(proj_start, {path: session.project_path})
```

### FR-2: QUEUE_STUCK_MONITOR
```
INTERVAL: 60s
QUERY: SELECT mq.session_id, s.project, MIN(mq.created_at) as oldest
       FROM message_queue mq
       JOIN sessions s ON s.id = mq.session_id
       WHERE mq.status = 'pending'
         AND mq.created_at < NOW() - INTERVAL '5 minutes'
       GROUP BY mq.session_id, s.project
TRIGGER: stuck_queue
ACTION: insert admin_commands(proj_start, {path: session.project_path})
```

### FR-3: VOICE_STATUS_RECOVERY
```
INTERVAL: 300s (5 min)
QUERY: SELECT id, chat_id, thread_id, message_id
       FROM voice_status_messages
       WHERE created_at < NOW() - INTERVAL '3 minutes'
ACTION_1: editMessage(chat_id, message_id, "⚠️ Bot restarted — voice not processed. Resend.")
ACTION_2: DELETE FROM voice_status_messages WHERE id = $id
```

### FR-4: CHANNEL_SUBPROCESS_RESTART
```
TRIGGER: hung_session OR stuck_queue
STEP_1: INSERT INTO admin_commands (command, payload, status)
        VALUES ('proj_start', {path: projectPath}, 'pending')
STEP_2: POLL admin_commands WHERE id = $id AND status IN ('done','error')
        TIMEOUT: 30s, INTERVAL: 2s
STEP_3: log result → send Telegram alert
```

### FR-5: LLM_DIAGNOSIS
```
PROVIDER: Ollama (http://localhost:11434)
MODEL: qwen3:8b
TIMEOUT: 10s
PROMPT_TEMPLATE: |
  You are a Telegram bot monitoring assistant. Briefly explain in 2-3 sentences
  what happened and what action was taken. Use simple language. Language: {lang}.
  
  Incident: {incident_type}
  Project: {project_name}
  Elapsed: {elapsed}
  Action: {action_taken}
  Result: {result}
ON_FAILURE: skip LLM, send alert without explanation field
```

### FR-6: TELEGRAM_ALERTS
```
DESTINATION: SUPERVISOR_CHAT_ID + SUPERVISOR_TOPIC_ID (from .env)
FORMAT_INCIDENT: |
  ⚠️ Supervisor: {incident_type}
  Проект: {project}
  Elapsed: {elapsed}
  Действие: {action}
  Результат: {result}
  
  💬 {llm_explanation}
FORMAT_HEALTH_OK: "✅ Все сессии в норме (проверка {HH:MM})"
HEALTH_OK_INTERVAL: 3600s (1 hour, only if no incidents in last hour)
IDEMPOTENCY_KEY: "{incident_type}:{project}:{floor(timestamp/300)}" — deduplicate per 5-min window
```

### FR-7: DEPLOYMENT_MODE_DETECTION
```
DOCKER_CHECK: runShell('docker ps --filter name=helyx-bot --format "{{.Names}}"')
IF result contains "helyx-bot": mode = "docker"
ELSE: mode = "host"

RECOVERY_ACTION:
  docker mode → admin_commands(proj_start) [admin-daemon restarts Docker tmux window]
  host mode   → admin_commands(proj_start) [admin-daemon restarts host tmux window]
```

### FR-8: INTEGRATION_POINT
```
FILE: scripts/admin-daemon.ts
ADD: import { startSupervisor } from "./supervisor.ts"
ADD: startSupervisor(sql, botToken, runShell, runCommand) after startTmuxWatchdog()

FILE: scripts/supervisor.ts (new)
EXPORTS: startSupervisor(sql, token, runShell, runCommand): void
PATTERN: multiple setInterval loops + shared incident dedup map
```

---

## NON_FUNCTIONAL_REQUIREMENTS
```json
{
  "NFR-1": { "metric": "idle CPU", "threshold": "<2%", "measurement": "top -p $PID" },
  "NFR-2": { "metric": "idle RAM", "threshold": "<50MB", "measurement": "process.memoryUsage()" },
  "NFR-3": { "metric": "LLM timeout", "threshold": "10s", "implementation": "AbortSignal.timeout(10000)" },
  "NFR-4": { "metric": "alert dedup window", "threshold": "5 minutes", "key_format": "type:project:timestamp_bucket" },
  "NFR-5": { "metric": "recovery attempt limit", "threshold": "3 attempts per incident", "escalation": "after 30min without resolution" }
}
```

---

## DB_SCHEMA_ADDITIONS
```sql
-- No new tables required.
-- process_health already tracks supervisor heartbeat:
-- INSERT INTO process_health (name, status, detail, updated_at)
-- VALUES ('supervisor', 'running', {incident_count, last_incident}, now())
-- ON CONFLICT (name) DO UPDATE ...

-- Optional: incident_log table for audit trail
CREATE TABLE IF NOT EXISTS supervisor_incidents (
  id          BIGSERIAL PRIMARY KEY,
  incident_type TEXT NOT NULL,       -- 'hung_session' | 'stuck_queue' | 'voice_stuck'
  project     TEXT,
  session_id  BIGINT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  action_taken TEXT,
  result      TEXT,
  llm_explanation TEXT
);
```

---

## ENV_VARS_REQUIRED
```env
SUPERVISOR_CHAT_ID=<telegram_group_chat_id>     # e.g. -1003908750902
SUPERVISOR_TOPIC_ID=<telegram_thread_id>        # dedicated supervisor alerts topic
OLLAMA_URL=http://localhost:11434               # already set
# SUPERVISOR_ENABLED=true                       # optional kill switch
```

---

## ACCEPTANCE_CRITERIA

```gherkin
Feature: Helyx Supervisor automatic recovery

  Background:
    Given admin-daemon is running
    And SUPERVISOR_CHAT_ID and SUPERVISOR_TOPIC_ID are configured
    And Ollama qwen3:8b is available at OLLAMA_URL

  Scenario: FR-1 hung session recovery
    Given sessions(id=5, status='active', project_path='/home/altsay/bots/myproject')
    And active_status_messages(session_id=5, updated_at=now()-5min)
    When supervisor FR-1 loop fires (t+60s)
    Then admin_commands row created with command='proj_start', payload.path='/home/altsay/bots/myproject'
    And admin-daemon processes it within 30s
    And Telegram message sent to SUPERVISOR_CHAT_ID/SUPERVISOR_TOPIC_ID
    And message contains project name, elapsed time, LLM explanation
    And active_status_messages row deleted

  Scenario: FR-2 stuck queue recovery
    Given message_queue(session_id=3, status='pending', created_at=now()-10min)
    And sessions(id=3, project_path='/home/altsay/bots/testproject')
    When supervisor FR-2 loop fires
    Then admin_commands row created with command='proj_start'
    And Telegram alert sent with stuck queue details

  Scenario: FR-3 voice status cleanup
    Given voice_status_messages(chat_id='-1001234', message_id=999, created_at=now()-5min)
    When supervisor FR-3 loop fires (t+5min)
    Then Telegram message 999 edited to "⚠️ Bot restarted — voice not processed. Resend."
    And voice_status_messages row deleted

  Scenario: NFR-3 Ollama unavailable
    Given OLLAMA_URL is unreachable
    When supervisor detects hung session
    Then recovery proceeds without LLM step
    And Telegram alert sent with "[LLM unavailable]" in explanation field

  Scenario: NFR-4 alert deduplication
    Given supervisor sent alert for project 'myproject' 2 minutes ago
    When supervisor detects same issue again at t+2min
    Then NO new Telegram message sent (within 5-min dedup window)

  Scenario: Incident escalation after 30min
    Given supervisor has been trying to recover session_id=5 for 35 minutes
    And admin_commands results are 'error' or session still hung
    When supervisor loop fires
    Then escalation alert sent: "⛔ Requires manual intervention: myproject (35m)"
    And supervisor stops automatic recovery attempts for this session
```

---

## IMPLEMENTATION_ORDER
```
1. scripts/supervisor.ts — core monitoring loops + Telegram alerts (no LLM yet)
2. Test: manual DB injection → verify alerts in Telegram topic
3. Add LLM diagnosis (qwen3:8b) with timeout + fallback
4. Add supervisor_incidents table migration (optional audit trail)
5. Expose supervisor status in /monitor command
6. Add SUPERVISOR_ENABLED env var kill switch
```

---

## VERIFICATION_CHECKLIST
- [ ] process_health('supervisor') updated every 30s
- [ ] hung_session alert arrives within 60s of simulated hang
- [ ] proj_start executed by admin-daemon within 30s
- [ ] LLM explanation in Russian for Russian sessions, English for English
- [ ] No duplicate alerts within 5-minute window
- [ ] Ollama timeout (10s) does not block Telegram alert
- [ ] Voice status messages cleaned up within 5 minutes of detection
- [ ] Escalation alert fires after 30 minutes of unresolved incident
- [ ] /monitor shows supervisor status: uptime + incident_count
