#!/bin/bash
# Auto-restart wrapper for Claude Code CLI sessions.
# Usage: scripts/run-cli.sh /path/to/project
#
# Runs claude with channel adapter in a loop, restarting on crash.
# Clean exit (code 0) stops the loop.

PROJECT_DIR="${1:-.}"
RESTART_DELAY="${RESTART_DELAY:-5}"
LOG_FILE="/tmp/cli-$(basename "$PROJECT_DIR").log"

cd "$PROJECT_DIR" || { echo "[run-cli] Cannot cd to $PROJECT_DIR"; exit 1; }

echo "[run-cli] Project: $PROJECT_DIR"
echo "[run-cli] Log: $LOG_FILE"

while true; do
  echo "[run-cli] Starting claude at $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"

  CHANNEL_SOURCE=tmux claude --dangerously-load-development-channels server:claude-bot-channel
  EXIT_CODE=$?

  echo "[run-cli] Exited with code $EXIT_CODE at $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"

  # Clean exit — don't restart
  if [ $EXIT_CODE -eq 0 ]; then
    echo "[run-cli] Clean exit, stopping."
    break
  fi

  echo "[run-cli] Restarting in ${RESTART_DELAY}s..." | tee -a "$LOG_FILE"
  sleep "$RESTART_DELAY"
done
