#!/bin/bash
# Claude Code Stop hook — extract and save project facts after session ends.
# Registered in ~/.claude/settings.json hooks.Stop by helyx setup wizard.
#
# Receives JSON on stdin: { "session_id": "...", "transcript_path": "..." }
# Calls bot API which reads transcript and extracts durable project facts.

set -euo pipefail

INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('transcript_path',''))" 2>/dev/null || true)
PORT="${PORT:-3847}"

# Nothing to do if no transcript
[ -z "$TRANSCRIPT_PATH" ] && exit 0
[ ! -f "$TRANSCRIPT_PATH" ] && exit 0

# Call bot API (non-blocking, ignore errors — bot may not be running)
curl -sf -X POST "http://localhost:${PORT}/api/hooks/stop" \
  -H "Content-Type: application/json" \
  --data-raw "{\"transcript_path\": \"${TRANSCRIPT_PATH//\"/\\\"}\", \"project_path\": \"${PWD//\"/\\\"}\"}" \
  --max-time 60 \
  > /dev/null 2>&1 || true
