#!/bin/bash
# Auto-restart wrapper for Claude Code CLI sessions.
# Usage: scripts/run-cli.sh /path/to/project
#
# Runs claude with channel adapter in a loop, restarting on crash.
# Clean exit (code 0) stops the loop.
#
# When running outside tmux, captures terminal output via `script`
# to /tmp/claude-output-<project>.log for progress monitoring.

PROJECT_DIR="${1:-.}"
RESTART_DELAY="${RESTART_DELAY:-5}"
PROJECT_NAME="$(basename "$PROJECT_DIR")"
LOG_FILE="/tmp/cli-${PROJECT_NAME}.log"
OUTPUT_FILE="/tmp/claude-output-${PROJECT_NAME}.log"

cd "$PROJECT_DIR" || { echo "[run-cli] Cannot cd to $PROJECT_DIR"; exit 1; }

echo "[run-cli] Project: $PROJECT_DIR"
echo "[run-cli] Log: $LOG_FILE"

# Detect if we're inside tmux
IN_TMUX="${TMUX:-}"

if [ -z "$IN_TMUX" ]; then
  echo "[run-cli] Not in tmux — capturing output to $OUTPUT_FILE"
fi

while true; do
  echo "[run-cli] Starting claude at $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"

  if [ -z "$IN_TMUX" ]; then
    # Outside tmux: capture terminal output via script for monitoring
    > "$OUTPUT_FILE"  # truncate
    script -qfc "CHANNEL_SOURCE=remote claude --dangerously-load-development-channels server:claude-bot-channel" "$OUTPUT_FILE"
    EXIT_CODE=$?
  else
    # Inside tmux: auto-confirm channel permission prompt, then run interactively
    (sleep 5 && tmux send-keys -t "$TMUX_PANE" "" Enter) &
    CHANNEL_SOURCE=remote claude --dangerously-load-development-channels server:claude-bot-channel
    EXIT_CODE=$?
  fi

  echo "[run-cli] Exited with code $EXIT_CODE at $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"

  # Clean exit — don't restart
  if [ $EXIT_CODE -eq 0 ]; then
    echo "[run-cli] Clean exit, stopping."
    break
  fi

  echo "[run-cli] Restarting in ${RESTART_DELAY}s..." | tee -a "$LOG_FILE"
  sleep "$RESTART_DELAY"
done
