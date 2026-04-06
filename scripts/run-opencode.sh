#!/bin/bash
# Auto-restart wrapper for opencode TUI sessions.
# Usage: scripts/run-opencode.sh /path/to/project [port]
#
# Connects to an already-running opencode serve instance.
# Restarts on crash; clean exit (code 0) stops the loop.

PROJECT_DIR="${1:-.}"
PORT="${2:-4096}"
SESSION_ID="${3:-}"
BOT_PORT="${BOT_PORT:-3847}"
RESTART_DELAY="${RESTART_DELAY:-5}"
PROJECT_NAME="$(basename "$PROJECT_DIR")"
LOG_FILE="/tmp/opencode-${PROJECT_NAME}.log"

cd "$PROJECT_DIR" || { echo "[run-opencode] Cannot cd to $PROJECT_DIR"; exit 1; }

echo "[run-opencode] Project: $PROJECT_DIR"
echo "[run-opencode] Connecting to opencode serve at localhost:${PORT}"
[ -n "$SESSION_ID" ] && echo "[run-opencode] Session: $SESSION_ID"

while true; do
  echo "[run-opencode] Starting at $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"

  if [ -n "$SESSION_ID" ]; then
    opencode attach "http://localhost:${PORT}" --session "$SESSION_ID"
  else
    opencode attach "http://localhost:${PORT}"
  fi
  EXIT_CODE=$?

  echo "[run-opencode] Exited with code $EXIT_CODE at $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"

  if [ $EXIT_CODE -eq 0 ]; then
    echo "[run-opencode] Clean exit, stopping."
    # Notify bot that TUI disconnected so it stops the SSE monitor
    curl -sf -X POST "http://localhost:${BOT_PORT}/api/sessions/disconnect" \
      -H "Content-Type: application/json" \
      -d "{\"projectPath\": \"${PROJECT_DIR}\"}" 2>/dev/null || true
    break
  fi

  echo "[run-opencode] Restarting in ${RESTART_DELAY}s..." | tee -a "$LOG_FILE"
  sleep "$RESTART_DELAY"
done
