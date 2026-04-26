#!/bin/bash
# Auto-restart wrapper for Helyx CLI sessions (multi-runtime).
# Usage: scripts/run-cli.sh /path/to/project [runtime_type]
#
# runtime_type defaults to "claude-code" for backward compatibility.
# Supported runtimes:
#   - claude-code  (default) — Claude Code CLI with helyx-channel MCP integration
#   - codex-cli    — npx @openai/codex
#   - opencode     — opencode binary
#   - deepseek-cli — Helyx-internal DeepSeek REPL (scripts/deepseek-repl.ts)
#
# Runs the chosen CLI in a loop, restarting on crash.
# Clean exit (code 0) stops the loop.
#
# When running outside tmux, captures terminal output via `script`
# to /tmp/claude-output-<project>.log for progress monitoring.

PROJECT_DIR="${1:-.}"
RUNTIME_TYPE="${2:-claude-code}"
RESTART_DELAY="${RESTART_DELAY:-5}"
PROJECT_NAME="$(basename "$PROJECT_DIR")"
LOG_FILE="/tmp/cli-${PROJECT_NAME}.log"
OUTPUT_FILE="/tmp/claude-output-${PROJECT_NAME}.log"

cd "$PROJECT_DIR" || { echo "[run-cli] Cannot cd to $PROJECT_DIR"; exit 1; }

echo "[run-cli] Project: $PROJECT_DIR"
echo "[run-cli] Runtime: $RUNTIME_TYPE"
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

# Resolve launcher command based on runtime_type.
# launcher_cmd: the actual shell command to run.
# needs_claude_confirm: whether to spawn the "Enter to confirm" watcher (Claude only).
case "$RUNTIME_TYPE" in
  claude-code)
    launcher_cmd='CHANNEL_SOURCE=remote claude --dangerously-load-development-channels server:helyx-channel'
    needs_claude_confirm=1
    ;;
  codex-cli)
    launcher_cmd='npx -y @openai/codex'
    needs_claude_confirm=0
    ;;
  opencode)
    launcher_cmd='opencode'
    needs_claude_confirm=0
    ;;
  deepseek-cli)
    # Use the Helyx-internal REPL. PROFILE_NAME defaults to deepseek-default
    # (created by migration v24); override via MODEL_PROFILE_ID env.
    launcher_cmd="bun \"$HELYX_DIR/scripts/deepseek-repl.ts\""
    needs_claude_confirm=0
    ;;
  standalone-llm)
    # Worker loop that polls agent_tasks and runs them via generateResponse.
    # Requires AGENT_INSTANCE_ID env var (admin-daemon sets it when launching
    # standalone-llm agents through the runtime driver).
    if [ -z "$AGENT_INSTANCE_ID" ]; then
      echo "[run-cli] ERROR: standalone-llm requires AGENT_INSTANCE_ID env var"
      exit 2
    fi
    launcher_cmd="bun \"$HELYX_DIR/scripts/standalone-llm-worker.ts\""
    needs_claude_confirm=0
    ;;
  *)
    echo "[run-cli] ERROR: unknown runtime_type '$RUNTIME_TYPE'"
    echo "[run-cli] Supported: claude-code, codex-cli, opencode, deepseek-cli, standalone-llm"
    exit 2
    ;;
esac

while true; do
  echo "[run-cli] Starting $RUNTIME_TYPE at $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"

  CHANNEL_LOG_FILE="/tmp/channel-${PROJECT_NAME}.log"
  export CHANNEL_LOG_FILE

  if [ -z "$IN_TMUX" ]; then
    # Outside tmux: capture terminal output via script for monitoring
    > "$OUTPUT_FILE"  # truncate
    script -qfc "$launcher_cmd" "$OUTPUT_FILE"
    EXIT_CODE=$?
  else
    # Inside tmux: optionally watch for Claude's "development channels" warning
    # prompt and auto-confirm. Only relevant for claude-code runtime.
    CONFIRM_PID=""
    if [ "$needs_claude_confirm" = "1" ]; then
      PANE="${TMUX_PANE}"
      (
        for i in $(seq 1 120); do
          out=$(tmux capture-pane -t "$PANE" -p 2>/dev/null)
          if echo "$out" | grep -q "Enter to confirm"; then
            tmux send-keys -t "$PANE" "" Enter
            break
          fi
          # Already past the prompt (running or exited) — stop watching
          if echo "$out" | grep -q "Listening for channel\|run-cli\] Exited"; then
            break
          fi
          sleep 0.5
        done
      ) &
      CONFIRM_PID=$!
    fi

    eval "$launcher_cmd"
    EXIT_CODE=$?

    # Clean up the confirm watcher if it's still running
    if [ -n "$CONFIRM_PID" ]; then
      kill "$CONFIRM_PID" 2>/dev/null
    fi
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
