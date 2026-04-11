# PRD: Rename Project from `claude-bot` to `Helyx`

**Date:** 2026-04-10  
**Status:** Draft  
**Scope:** Full project rename — repository, CLI, code, Docker, DB, Telegram bot, docs

---

## 1. Context

The project is being rebranded from the working name `claude-bot` to **Helyx** — a coined name combining Iris (Greek messenger goddess) with the `-yx` suffix shared with the sibling project **Keryx**. Helyx is the simpler companion product: a Telegram-first multi-project forum hub for developers working with Claude Code CLI.

---

## 2. New Identity

| Item | Old | New |
|------|-----|-----|
| Product name | claude-bot | **Helyx** |
| CLI command | `claude-bot` | `helyx` |
| Telegram bot username | `@GoodeaAIBot` | `@HelyxBot` (or `@HelyxDevBot`) |
| Telegram bot display name | (current) | **Helyx** |
| GitHub repository | `multiclaude-tg-bot` | `helyx` |
| npm package name | `claude-bot` | `helyx` |
| Docker network | `claude-bot` | `helyx` |
| Docker volume | `claude-bot-pgdata` | `helyx-pgdata` |
| DB name | `claude_bot` | `helyx` |
| DB user | `claude_bot` | `helyx` |
| MCP server (bot) | `claude-bot` | `helyx` |
| MCP server (channel) | `claude-bot-channel` | `helyx-channel` |
| Domain | `claude-bot.mrciphersmith.com` | `helyx.mrciphersmith.com` |
| Project directory | `~/bots/claude-bot` | `~/bots/helyx` |
| tmux session | `claude-bot` | `helyx` |

---

## 3. Scope of Changes

### 3.1 GitHub Repository
- [ ] Rename repository `MrCipherSmith/multiclaude-tg-bot` → `MrCipherSmith/helyx` via GitHub Settings
- [ ] Update all GitHub-relative URLs in README, docs, CONTRIBUTING.md
- [ ] Update any `gh repo clone` examples in documentation

### 3.2 Package & Metadata
- [ ] `package.json` — `name`: `"claude-bot"` → `"helyx"`
- [ ] `dashboard/webapp/package.json` — update any references
- [ ] `tests/package.json` — update references

### 3.3 CLI Binary (`cli.ts`)
- [ ] Rename all user-facing `claude-bot <cmd>` strings → `helyx <cmd>`
- [ ] Update help text, error messages, setup wizard prompts
- [ ] Update `package.json` `bin` field (if present) to `helyx`
- [ ] Update `install.sh` — symlink/bin name from `claude-bot` → `helyx`
- [ ] Update tmux session constant: `TMUX_SESSION = "claude-bot"` → `"helyx"`
- [ ] Update DB connection strings in wizard: `claude_bot` → `helyx`
- [ ] Update `setupStopHook()` — hook script path will change with directory rename

### 3.4 MCP Servers
- [ ] `cli.ts` setup wizard: `claude.mcp remove "claude-bot"` → `"helyx"`
- [ ] `cli.ts` setup wizard: `claude.mcp remove "claude-bot-channel"` → `"helyx-channel"`
- [ ] `cli.ts` setup wizard: `claude.mcp add "claude-bot"` → `"helyx"`
- [ ] `cli.ts` setup wizard: `claude.mcp add-json "claude-bot-channel"` → `"helyx-channel"`
- [ ] `cli.ts` `syncChannelToken()`: `mcpServers["claude-bot-channel"]` → `["helyx-channel"]`
- [ ] `channel/index.ts`: channel source name `"claude-bot-channel"` referenced internally
- [ ] `scripts/run-cli.sh`: `server:claude-bot-channel` → `server:helyx-channel`
- [ ] `cli.ts` `start()`: `server:claude-bot-channel` → `server:helyx-channel`
- [ ] All `~/.claude.json` / `~/.claude/` MCP registrations must be re-registered (done by wizard re-run)

### 3.5 Docker & Infrastructure
- [ ] `docker-compose.yml`:
  - Service name `bot` — no rename needed (already generic)
  - `DATABASE_URL`: `claude_bot` user/db → `helyx`
  - `POSTGRES_USER`: `claude_bot` → `helyx`
  - `POSTGRES_DB`: `claude_bot` → `helyx`
  - Network name `claude-bot` → `helyx`
  - Volume name `claude-bot-pgdata` → `helyx-pgdata`
  - `pg_isready -U claude_bot -d claude_bot` → `-U helyx -d helyx`
- [ ] `.env.example`: update all `claude_bot` → `helyx`, `claude_bot_secret` → `helyx_secret`
- [ ] `.env` (production): **manual step** — update DB credentials, rebuild containers

### 3.6 Database
- [ ] **PostgreSQL rename** (migration or fresh):
  - DB: `claude_bot` → `helyx`
  - User: `claude_bot` → `helyx`
  - Password: `claude_bot_secret` → new password (user configurable)
- [ ] Alternative: keep DB/user names as-is internally, only rename in display — evaluate tradeoff
- [ ] Update all hardcoded connection string examples in docs

### 3.7 Telegram Bot
- [ ] Via **@BotFather**:
  - `/mybots` → select bot → `Edit Bot` → `Edit Name` → set to **Helyx**
  - `/mybots` → select bot → `Edit Bot` → `Edit Username` → set to `@HelyxBot` (check availability)
  - `/mybots` → select bot → `Edit Bot` → `Edit Description` → update
  - `/mybots` → select bot → `Edit Bot` → `Edit About` → update
- [ ] Update `README.md` example: `@GoodeaAIBot` → `@HelyxBot`
- [ ] Update all docs referencing the old bot username

### 3.8 Domain
- [ ] Cloudflare Tunnel config: update ingress rule hostname from `claude-bot.mrciphersmith.com` → `helyx.mrciphersmith.com`
- [ ] DNS: add CNAME for `helyx.mrciphersmith.com`
- [ ] `.env` `TELEGRAM_WEBHOOK_URL`: update domain
- [ ] GitHub Actions secrets: update `APP_BASE_URL`-equivalent if set

### 3.9 Project Directory
- [ ] Move `~/bots/claude-bot` → `~/bots/helyx`
  ```bash
  mv ~/bots/claude-bot ~/bots/helyx
  ```
- [ ] Update `~/.claude/settings.json` Stop hook path:
  `~/bots/claude-bot/scripts/save-session-facts.sh` → `~/bots/helyx/scripts/save-session-facts.sh`
- [ ] Update tmux-projects.json if it contains absolute paths
- [ ] Update any systemd/cron jobs referencing the old path

### 3.10 Source Code — String Replacements
Files with `claude-bot` or `claude_bot` references requiring code changes:

| File | What changes |
|------|-------------|
| `cli.ts` | CLI name, MCP names, DB names, tmux session, help text |
| `channel/index.ts` | Channel source name in MCP registration |
| `mcp/server.ts` | Any hardcoded service names |
| `sessions/manager.ts` | Any hardcoded references |
| `scripts/run-cli.sh` | `server:claude-bot-channel` |
| `scripts/save-session-facts.sh` | Path references |
| `scripts/backup-db.sh` | DB name |
| `bot/commands/add.ts` | Any references |
| `bot/commands/project-add.ts` | BOT_RULES_SECTION text |
| `bot/commands/memory-export.ts` | Any references |
| `CLAUDE.md` | Project name |
| `.claude/settings.local.json` | MCP server names |
| `tmux-projects.json` | Paths |

### 3.11 Documentation
Files requiring text replacement of project name:

- `README.md` — main README, all `claude-bot` CLI references, `@GoodeaAIBot`, GitHub repo URL
- `docs/ROADMAP.md` — project name references
- `CLAUDE_MD_GUIDE.md` — project name
- `CONTRIBUTING.md` — repo URL, project name
- `SECURITY.md` — project name
- `CODE_OF_CONDUCT.md` — project name
- `guides/*.md` — all 8 guides
- `examples/*.md` — usage examples
- `docs/requirements/**/*.md` — historical docs (low priority, can leave as-is since they're historical records)
- `docs/spec/**/*.md` — spec documents

---

## 4. Implementation Phases

### Phase 1 — Code & Config (no downtime)
1. Global string replace in all `.ts`, `.json`, `.yml`, `.sh`, `.md` files
2. Rename package, bin, MCP server names in code
3. Update Docker Compose network/volume/DB names
4. Update `.env.example`

### Phase 2 — Telegram Bot (BotFather, ~5 min)
1. Change bot display name → **Helyx**
2. Change bot username → `@HelyxBot`
3. Update description and about text

### Phase 3 — Infrastructure (requires downtime ~5 min)
1. Stop running containers
2. Rename directory: `claude-bot` → `helyx`
3. Update `.env` with new DB credentials
4. Rebuild Docker images
5. Recreate DB with new name (or `ALTER DATABASE`)
6. Update domain/tunnel config
7. Re-register MCP servers: `helyx setup` (runs wizard step)
8. Update Stop hook path in `~/.claude/settings.json`

### Phase 4 — GitHub (after code merge)
1. Merge rename PR
2. Rename repository via GitHub Settings
3. GitHub auto-redirects old URL — no broken links immediately

---

## 5. Database Migration Strategy

**Option A — Rename in place** (zero data loss, preferred):
```sql
ALTER DATABASE claude_bot RENAME TO helyx;
ALTER ROLE claude_bot RENAME TO helyx;
ALTER ROLE helyx WITH PASSWORD 'helyx_secret';
```
Requires no active connections. Do while bot is stopped.

**Option B — Fresh DB** (only if starting fresh):
Docker volume rename + recreate. All data is lost. Not recommended for production.

---

## 6. Backward Compatibility

- **MCP servers**: after rename, users must re-run `helyx setup` (or `helyx mcp-register`) — old `claude-bot` / `claude-bot-channel` registrations will be removed and replaced
- **tmux**: existing tmux session named `claude-bot` must be killed and recreated as `helyx`
- **Cloudflare**: old domain `claude-bot.mrciphersmith.com` can remain as redirect during transition
- **GitHub redirect**: repository rename creates an automatic redirect for 1 year

---

## 7. What NOT to Rename

- **Internal MCP protocol messages** — JSON-RPC, no names there
- **Historical PRD/docs** in `docs/requirements/` — keep as historical record
- **Database table names** — `sessions`, `messages`, `memories`, etc. are generic, no rename needed
- **"Claude" as AI model name** — references to Claude API, Claude Code CLI stay as-is (that's the product name, not our project name)
- **`CHANNEL_SOURCE=remote/local`** — internal values, not user-facing

---

## 8. Acceptance Criteria

- [ ] `helyx setup` runs end-to-end without errors
- [ ] `helyx up` starts all tmux sessions
- [ ] `helyx connect .` starts a CLI session
- [ ] Telegram bot responds as **Helyx** with username `@HelyxBot`
- [ ] MCP tools `helyx` and `helyx-channel` registered in Claude Code
- [ ] `bun test tests/unit/` — all 77 tests pass
- [ ] GitHub repo accessible at `github.com/MrCipherSmith/helyx`
- [ ] No `claude-bot` or `claude_bot` strings in user-facing output
- [ ] Bot webhook working at new domain
- [ ] Stop hook path updated and functional
