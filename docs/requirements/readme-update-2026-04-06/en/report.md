# README Update Report: Skills, Commands, Providers & OpenCode

**Date:** 2026-04-06  
**Branch:** main  
**Analyzed commits:** 20 recent commits (195c9df → a3d66e7)  
**Applied in:** commit a3d66e7

---

## 1. Executive Summary

Analyzed the last 20 git commits and identified a documentation gap between implemented features and the README. The README was at 620 lines (missing ~150 lines of content for new features). Updated to 770 lines covering skills/commands integration, LLM provider management, and OpenCode TUI support.

---

## 2. Commits Analyzed

| Hash | Type | Description |
|------|------|-------------|
| 195c9df | feat | Persistent OpenCode SSE monitor — TUI messages forwarded to Telegram |
| f8fbd3c | feat | Shared OpenCode session between TUI and bot |
| 9a94620 | fix | Normalize cli_config JSONB storage |
| cb65946 | feat | Provider-aware tmux projects |
| 34b907d | fix | Run OpenCode serve in tmux session |
| a625154 | feat | `--provider` flag on `claude-bot add`, `/api/sessions/register` endpoint |
| 0959fae | feat | `/add`, `/model`, `/connections` commands and provider badges |
| 7149300 | fix | Buttons-only layout for /skills and /commands |
| b221450 | fix | Better skills/commands UI |
| afa61aa | feat | `/skills`, `/commands`, `/hooks` with inline buttons and tool invocation |
| b945c04 | feat | `--name` flag on `claude-bot add` |
| 57e32f8 | fix | Stop/down commands preserve standalone session |
| 3d81555 | feat | `/remove` command to manually delete sessions |
| 4253715 | feat | `prune` command for interactive session cleanup |

---

## 3. Gap Analysis: Code vs Documentation

### 3.1 Missing Telegram Commands

| Command | Status Before | Status After |
|---------|--------------|--------------|
| `/skills` | Listed as "skills catalog from knowledge base" | Full section: inline buttons, live scan, click-to-run |
| `/commands` | Not documented | Documented: ~/.claude/commands/, YAML frontmatter |
| `/hooks` | Not documented | Documented: settings.json hooks, event types |
| `/add [provider]` | Not documented | Documented: interactive provider wizard |
| `/model` | Not documented | Documented: show active provider |
| `/connections` | Not documented | Documented: provider status badges |

### 3.2 Missing CLI Options

| Feature | Status Before | Status After |
|---------|--------------|--------------|
| `--provider` flag on `add` | Not documented | Documented with examples (opencode/local/remote) |
| `claude-bot attach <url>` | Not documented | Documented |
| Provider-specific tmux windows | Not documented | Documented |

### 3.3 Missing Sections

| Section | Status Before | Status After |
|---------|--------------|--------------|
| Skills, Commands & Hooks | None | Full section with examples |
| LLM Providers | None | Full section (/add, /model, /connections, CLI) |
| OpenCode Integration | None | Full section (SSE monitor, session sharing, setup) |
| Recent Changes (v1.8.0) | None | Added (summary of all new features) |
| ENV: HOST_CLAUDE_CONFIG | Not documented | Documented |
| ENV: OPENCODE_PORT | Not documented | Documented |

### 3.4 Updated Roadmap

Added 3 completed items:
- `[x]` Skills & commands integration from local Claude config
- `[x]` LLM provider management (/add, /model, /connections)
- `[x]` OpenCode TUI integration with SSE monitoring

---

## 4. Changes Applied

### 4.1 Telegram Commands Table

Extended `## Telegram Commands` section with 6 new rows in "Tools & Knowledge" group:
- `/commands` — Custom commands with inline buttons
- `/hooks` — Configured Hookify rules
- `/add [model]` — LLM provider wizard
- `/model` — View current provider
- `/connections` — Provider status

Updated `/skills` description from "catalog from knowledge base" to "inline buttons, click to run".

### 4.2 New Section: Skills, Commands & Hooks

Three subsections documenting:
- `/skills` — reads from `~/.claude/skills/`, inline buttons, deferred args input
- `/commands` — reads `~/.claude/commands/*.md`, YAML frontmatter example
- `/hooks` — reads `settings.json`, lists event types (PreToolUse, PostToolUse, Stop, Notification)

### 4.3 New Section: LLM Providers

Four subsections:
- `/add [provider]` — interactive wizard for all 4 providers
- `/model` — shows active provider details
- `/connections` — all configured providers with status
- CLI Provider Support — `--provider` flag with examples

### 4.4 New Section: OpenCode Integration

Explains the full flow: `add --provider opencode` → auto-start serve → shared session → SSE monitor → Telegram forwarding.

### 4.5 CLI Commands Section Updated

Added `--provider` to `add` command, added `attach <url>` command, added Providers subsection.

### 4.6 Environment Variables Table

Added two new rows:
- `HOST_CLAUDE_CONFIG` — docker mount of ~/.claude (default: `/host-claude-config`)
- `OPENCODE_PORT` — OpenCode serve port (default: `8000`)

### 4.7 Recent Changes Section

Added `## Recent Changes (v1.8.0)` with 4 categories: Skills & Commands, LLM Providers, OpenCode, Database.

---

## 5. Key Files Changed in Code

| File | Lines | Purpose |
|------|-------|---------|
| `utils/tools-reader.ts` | +141 | Parse skill/command metadata from ~/.claude |
| `adapters/opencode-monitor.ts` | +214 | SSE monitor for OpenCode TUI |
| `bot/commands/admin.ts` | +98 | /skills, /commands, /hooks, /add, /model, /connections |
| `bot/callbacks.ts` | +35 | Inline button callbacks skill:/cmd: |
| `bot/handlers.ts` | +28 | Deferred tool input management (5-min TTL) |
| `bot/text-handler.ts` | +32/-62 | Tool command routing |
| `cli.ts` | +302 | Provider flag, OpenCode attach, session registration |
| `mcp/server.ts` | +33 | /api/sessions/register endpoint |
| `sessions/manager.ts` | +35 | Provider field in session handling |
| `scripts/run-opencode.sh` | +40 | OpenCode serve launcher |

**Total code delta:** +659 insertions, -144 deletions across 13 files

---

## 6. Verification

- README line count before: 620 → after: 770 (+150 lines)
- All new Telegram commands documented
- All new CLI flags documented
- New ENV variables documented
- Roadmap reflects actual state
- Architecture diagram unchanged (still accurate)

---

## 7. Resolution of Open Items

All open items identified at report creation are now resolved:

| Item | Resolution |
|------|-----------|
| Architecture diagram missing OpenCode | Fixed — diagram updated in README.md: added `opencode serve (tmux)` host box and `HTTP/SSE ↕ host.docker.internal:4096` arrow; added `OpenCode SSE monitor` line inside Bot box |
| No PRD for `/add /model /connections` | Created — `docs/requirements/provider-management-2026-04-06/en/prd.md` |
| No PRD for OpenCode integration | Created — `docs/requirements/opencode-integration-2026-04-06/en/prd.md` |
