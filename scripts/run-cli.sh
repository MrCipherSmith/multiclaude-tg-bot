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

# Load shared API keys from helyx .env (GROQ_API_KEY, OPENAI_API_KEY, etc.)
# then overlay project-specific .env on top. Skip already-set vars to avoid
# overriding Docker-injected values like DATABASE_URL.
load_env() {
  local envfile="$1"
  [ -f "$envfile" ] || return
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue  # skip comments
    [[ -z "${line// }" ]] && continue             # skip blank lines
    key="${line%%=*}"
    [[ -z "${!key}" ]] && export "$line" 2>/dev/null  # only if not already set
  done < "$envfile"
}

HELYX_DIR="$(dirname "$(dirname "$(realpath "$0")")")"
load_env "$HELYX_DIR/.env" && echo "[run-cli] Loaded helyx .env"
if [ "$PROJECT_DIR" != "$HELYX_DIR" ] && [ -f ".env" ]; then
  load_env ".env" && echo "[run-cli] Loaded project .env"
fi

# Detect if we're inside tmux
IN_TMUX="${TMUX:-}"

if [ -z "$IN_TMUX" ]; then
  echo "[run-cli] Not in tmux — capturing output to $OUTPUT_FILE"
fi

while true; do
  echo "[run-cli] Starting claude at $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"

  CHANNEL_LOG_FILE="/tmp/channel-${PROJECT_NAME}.log"
  export CHANNEL_LOG_FILE

  if [ -z "$IN_TMUX" ]; then
    # Outside tmux: capture terminal output via script for monitoring
    > "$OUTPUT_FILE"  # truncate
    script -qfc "CHANNEL_SOURCE=remote claude --dangerously-load-development-channels server:helyx-channel" "$OUTPUT_FILE"
    EXIT_CODE=$?
  else
    # Inside tmux: watch for the channel permission prompt and auto-confirm it.
    # Polls every second for up to 30s; stops as soon as prompt is confirmed or disappears.
    PANE="${TMUX_PANE}"
    (
      for i in $(seq 1 30); do
        sleep 1
        out=$(tmux capture-pane -t "$PANE" -p 2>/dev/null)
        if echo "$out" | grep -q "Enter to confirm"; then
          tmux send-keys -t "$PANE" "" Enter
          break
        fi
        # Already past the prompt (running or exited) — stop watching
        if echo "$out" | grep -q "Listening for channel\|❯\|run-cli\] Exited"; then
          break
        fi
      done
    ) &
    CONFIRM_PID=$!
    CHANNEL_SOURCE=remote claude --dangerously-load-development-channels server:helyx-channel
    EXIT_CODE=$?
    # Clean up the confirm watcher if Claude exited before it finished
    kill "$CONFIRM_PID" 2>/dev/null
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
