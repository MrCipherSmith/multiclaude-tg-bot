# Helyx v1.48.0 Release Notes

**Released:** 2026-05-03

## What's New

### send_photo MCP Tool
A new `send_photo` tool is available on both the stdio and HTTP MCP transports. Agents can now send images to Telegram — either by URL or by uploading a local file. The stdio transport correctly routes photos to the right forum topic.

### Smart Response Guard
The status guard that watches for stuck Claude sessions now distinguishes three states instead of one:

- **Recently active** (< 90s silent) — re-arms silently, no message sent
- **Long thinking** (spinner/tool stage went quiet) — sends a soft note and re-arms
- **Stuck** (no activity and no active-looking stage) — sends an alert and deletes the status message

This eliminates false alarms during long tool calls while still catching genuinely stuck sessions.

### Status Heartbeat Redesign
The status message system was simplified to a single 15-second interval (was: 1s spinner + 10s pane timer). Each new user request now starts with a fresh status message — the old message is deleted before a new one is sent — eliminating the visual confusion of editing a previous turn's status in-place.

## Bug Fixes / Housekeeping

- `CLAUDE.md` Implementation Rules section added (no code changes without explicit user confirmation)
- tmux-monitor poll interval increased from 2s to 15s to match the new heartbeat

## Upgrade

No database migrations. No new environment variables. Drop-in upgrade — restart the bot container after pulling.
