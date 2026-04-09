# PRD: Voice Transcription Progress + Session Timeline

**Date:** 2026-04-09  
**Status:** Ready to implement  
**Branch:** `feat/voice-and-timeline`

---

## Overview

Two complementary features that improve the real-time feedback and auditability of Claude Bot sessions.

---

## Feature 1: Voice Transcription Live Progress

### Problem

When a user sends a voice message longer than ~30 seconds, the bot shows "🎤 Transcribing speech..." with no indication of how long it has been running. The user has no idea if the request is stuck or working.

### Solution

Update the status message every 5 seconds with elapsed time while Groq/Whisper transcription is in progress.

### User Stories

1. **As a user**, I send a 90-second voice message. I see the status update every 5s: `🎤 Transcribing... (5s)`, `(10s)`, `(15s)` — so I know it's working.
2. **As a user**, if transcription takes >30s I'm still informed — no anxiety about whether the bot is stuck.
3. **As a user**, short voice messages (<10s) show the existing one-shot status (no timer needed — it resolves before the first tick).

### Acceptance Criteria

- [ ] Status message updates every 5s with elapsed seconds while `transcribe()` is running
- [ ] Timer stops as soon as transcription completes or fails
- [ ] No timer shown for voice messages where transcription resolves in <5s (first tick never fires)
- [ ] Works for both Groq and local Whisper fallback paths
- [ ] Existing behavior (download → transcribe → reply) unchanged; only status UX changes

### Technical Approach

In `bot/media.ts` `handleVoice`:
- Start a `setInterval(5000)` timer right before calling `transcribe()`
- Each tick: `bot.api.editMessageText(chatId, statusMsg.message_id, \`🎤 Transcribing... (${elapsed}s)\`)`
- `clearInterval` in a `finally` block regardless of success/failure
- Elapsed computed from `Date.now() - startTime`

No changes to `utils/transcribe.ts` needed (pure UX change in the caller).

### Files

- `bot/media.ts` — `handleVoice()`: add interval timer around `transcribe()` call

---

## Feature 2: Session Timeline

### Problem

The webapp has a Messages tab (chat bubbles) and a Monitor tab (API stats, tool calls list). But there's no unified chronological view that shows **messages and tool events interleaved** — the user can't see "Claude ran Bash() then sent this message". The `messages` and `permission_requests` tables already have all the data.

### Solution

Add a **Timeline tab** to the webapp Session Monitor area, showing messages and tool calls interleaved in chronological order. Also add a `/session_export` Telegram command for markdown transcript export.

### User Stories

1. **As a user**, I open the Timeline tab and see all messages + tool calls in order — user bubbles, assistant bubbles, and tool events (`🔧 Bash: git status → allowed`).
2. **As a user**, I can see exactly what tools Claude used between messages, giving me an audit trail.
3. **As a user**, I send `/session_export` in Telegram and receive a markdown `.md` file with the full session transcript (messages + tool calls chronologically).
4. **As a user**, I can filter the timeline by type: All / Messages only / Tools only.

### Acceptance Criteria

- [ ] `GET /api/sessions/:id/timeline` returns merged, chronologically sorted array of messages and tool events
- [ ] Each item has a `kind` field: `"message"` or `"tool"`
- [ ] Timeline tab renders in the webapp (🕐 icon, 4th or 5th tab)
- [ ] Messages rendered as bubbles (user right, assistant left, system gray)
- [ ] Tool events rendered as compact rows: icon + tool_name + response badge + timestamp
- [ ] Filter bar: All / Messages / Tools
- [ ] Auto-refresh every 5s (same as Messages tab)
- [ ] `/session_export [id]` sends a `.md` file with full transcript
- [ ] Export includes header: session name, project path, exported_at, message count, tool call count

### Technical Approach

**API:**
- New endpoint `GET /api/sessions/:id/timeline?limit=100&offset=0`
- SQL: `SELECT 'message' AS kind, id, role AS actor, content, created_at FROM messages WHERE session_id=$1 UNION ALL SELECT 'tool', id, tool_name, description, created_at FROM permission_requests WHERE session_id=$1 ORDER BY created_at ASC LIMIT $2 OFFSET $3`
- Pagination same pattern as `/messages`

**Webapp:**
- `dashboard/webapp/src/api.ts`: add `sessionTimeline()` method
- `dashboard/webapp/src/components/SessionTimeline.tsx`: new component
- `dashboard/webapp/src/App.tsx`: add 🕐 tab

**Bot:**
- `bot/commands/admin.ts`: `handleSessionExport()` — fetches timeline from DB, formats as markdown, sends as `.md` file

### Files

- `mcp/dashboard-api.ts` — add `handleSessionTimeline()`, wire route
- `dashboard/webapp/src/api.ts` — add `sessionTimeline()`
- `dashboard/webapp/src/components/SessionTimeline.tsx` — new component
- `dashboard/webapp/src/App.tsx` — add tab
- `bot/commands/admin.ts` — add `handleSessionExport()`
- `bot/handlers.ts` — register `/session_export`
- `bot/bot.ts` — add to setMyCommands

---

## Out of Scope

- Audio file chunking / splitting (requires ffmpeg, not available in container)
- Streaming transcription API (Groq Whisper API is not streaming)
- Session playback animation / step-through
- Timeline search/filter by content text

## Dependencies

- No new packages required
- No DB migrations required (data already exists)

---

## Testing

- Voice: mock `transcribe()` with a 15s delay, verify status message was edited ≥2 times
- Timeline API: integration test — create session with messages + tool calls, verify merged/sorted response
- Timeline webapp: component renders with mock data (unit test)
