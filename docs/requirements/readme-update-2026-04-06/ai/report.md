# AI Context: README Update Analysis

## Job Summary
Analyzed 20 recent commits (195c9df → a3d66e7) to identify documentation gaps between implemented features and README.md. Produced updated README covering 3 undocumented feature areas.

## Commits Analyzed
- 195c9df feat: OpenCode SSE monitor
- f8fbd3c feat: shared OpenCode session
- 9a94620 fix: JSONB normalization
- cb65946 feat: provider-aware tmux
- a625154 feat: --provider flag + /api/sessions/register
- 0959fae feat: /add /model /connections commands
- 7149300 fix: buttons-only /skills /commands UI
- b221450 fix: better skills/commands UI
- afa61aa feat: /skills /commands /hooks with inline buttons
- b945c04 feat: --name flag on add
- 57e32f8 fix: stop/down preserve standalone
- 3d81555 feat: /remove command
- 4253715 feat: prune command

## Gap Found
README was 620 lines. Missing:
- 6 new Telegram commands (/commands, /hooks, /add, /model, /connections, updated /skills)
- 3 new CLI options (--provider, attach, provider-specific tmux)
- 3 sections (Skills/Commands/Hooks, LLM Providers, OpenCode Integration)
- 2 ENV vars (HOST_CLAUDE_CONFIG, OPENCODE_PORT)
- 3 roadmap items

## Changes Applied (commit a3d66e7)
README: 620 → 770 lines

### New Telegram Commands
| Command | Description |
|---------|-------------|
| /commands | Custom commands from ~/.claude/commands/*.md |
| /hooks | Configured Hookify rules from settings.json |
| /add [provider] | Interactive LLM provider wizard |
| /model | View active provider |
| /connections | List all configured providers with status |

### New Sections
1. "Skills, Commands & Hooks" — explains live scan, YAML frontmatter, deferred input, hook event types
2. "LLM Providers" — /add /model /connections, --provider CLI flag, 4 provider types
3. "OpenCode Integration" — full flow: add → serve → shared session → SSE → Telegram
4. "Recent Changes (v1.8.0)" — summary of all new features

### New ENV Variables
- HOST_CLAUDE_CONFIG: docker mount for ~/.claude (default: /host-claude-config)
- OPENCODE_PORT: OpenCode serve port (default: 8000)

### CLI Commands Updated
- add: [dir] [--name] [--provider]
- attach <url>: connect to running OpenCode
- Providers subsection with examples

## Key Technical Details

### tools-reader.ts (utils/tools-reader.ts)
- Scans HOST_CLAUDE_CONFIG/skills/ for SKILL.md files
- Scans HOST_CLAUDE_CONFIG/commands/ for *.md files
- Parses YAML frontmatter (description, args, argument-hint)
- requiresArgs detection: NO_ARGS_LIST hardcoded set + "## Arguments" section check + meta.args field
- Returns ToolItem[]: { name, description, requiresArgs }
- 38 emoji icons mapped to tool names

### opencode-monitor.ts (adapters/opencode-monitor.ts)
- EventSource to http://host.docker.internal:OPENCODE_PORT/v1/events
- Filters by shared sessionId
- Watches message.part.updated + session.status idle events
- Throttles Telegram edits to 1.5s
- Forwards TUI operation messages to Telegram

### Provider Storage
- cli_config JSONB column in DB
- Read-merge-write pattern for safe concurrent updates
- Explicit ::jsonb cast for PostgreSQL compatibility
- Provider types: opencode | local | remote

### Callback Routing
- skill:<name> → invoke from ~/.claude/skills/
- cmd:<name> → invoke from ~/.claude/commands/
- No-args: immediate enqueue to message_queue
- Requires-args: store in pendingToolInput Map (5 min TTL), prompt user, enqueue on next message

## Files Changed in Code Sprint
cli.ts +302, adapters/opencode-monitor.ts NEW+214, utils/tools-reader.ts NEW+141, bot/commands/admin.ts +98, sessions/manager.ts +35, bot/handlers.ts +28, mcp/server.ts +33, bot/text-handler.ts +32-62, bot/callbacks.ts +35, scripts/run-opencode.sh NEW+40, docker-compose.yml -20, install.sh +6, package.json +1

Total: 659 insertions, 144 deletions, 13 files

## Open Items Resolution

All open items resolved:
- Architecture diagram: updated in README.md — added opencode serve box to host section, HTTP/SSE arrow to Docker Bot, OpenCode SSE monitor line in Bot box
- PRD for /add /model /connections: docs/requirements/provider-management-2026-04-06/en/prd.md
- PRD for OpenCode integration: docs/requirements/opencode-integration-2026-04-06/en/prd.md
