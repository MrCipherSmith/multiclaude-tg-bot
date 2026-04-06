#!/bin/bash
# Auto-restart wrapper for opencode TUI sessions.
# Usage: scripts/run-opencode.sh /path/to/project [port]
#
# Connects to an already-running opencode serve instance.
# Restarts on crash; clean exit (code 0) stops the loop.

PROJECT_DIR="${1:-.}"
PORT="${2:-4096}"
RESTART_DELAY="${RESTART_DELAY:-5}"
PROJECT_NAME="$(basename "$PROJECT_DIR")"
LOG_FILE="/tmp/opencode-${PROJECT_NAME}.log"

cd "$PROJECT_DIR" || { echo "[run-opencode] Cannot cd to $PROJECT_DIR"; exit 1; }

echo "[run-opencode] Project: $PROJECT_DIR"
echo "[run-opencode] Connecting to opencode serve at localhost:${PORT}"

while true; do
  echo "[run-opencode] Starting at $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"

  opencode attach "http://localhost:${PORT}"
  EXIT_CODE=$?

  echo "[run-opencode] Exited with code $EXIT_CODE at $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"

  if [ $EXIT_CODE -eq 0 ]; then
    echo "[run-opencode] Clean exit, stopping."
    break
  fi

  echo "[run-opencode] Restarting in ${RESTART_DELAY}s..." | tee -a "$LOG_FILE"
  sleep "$RESTART_DELAY"
done
