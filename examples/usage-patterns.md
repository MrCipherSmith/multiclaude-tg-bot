# Usage Patterns

Practical examples of how Claude Code interacts with the Telegram bot through MCP tools. These patterns are configured via `CLAUDE.md` instructions — see [CLAUDE_MD_GUIDE.md](../CLAUDE_MD_GUIDE.md) for setup.

---

## Status Updates

Call `update_status` before each major operation so the user sees progress in Telegram.

```
User sends message in Telegram
  → Claude receives channel notification with chat_id
  → update_status(chat_id, "Reading files...")
  → update_status(chat_id, "Running tests...")
  → reply(chat_id, "Done! All 42 tests pass.")
  → status message auto-deleted on reply
```

Keep status text under 50 characters. The status message shows a live timer in Telegram.

---

## Sub-Agent Progress Tree

When Claude launches multiple background agents (for analysis, review, implementation), the status updates show a progress tree in Telegram.

### CLAUDE.md configuration

```markdown
## Sub-agent status updates

When launching Agent tools, update status with agent progress:
- Before launching: `update_status(chat_id, "Running N agents...")`
- After each agent completes, update with a tree showing progress
- In the final `reply`, include a brief summary of what each agent did
```

### How it looks in Telegram

**Initial status (all agents launched):**
```
⏳ Running 3 agents...
├─ Analyzing architecture — ⏳
├─ Checking test coverage — ⏳
└─ Reviewing dependencies — ⏳
```

**After first agent completes:**
```
⏳ Running 3 agents...
├─ Analyzing architecture — done
├─ Checking test coverage — ⏳
└─ Reviewing dependencies — ⏳
```

**After second agent completes:**
```
⏳ Running 3 agents...
├─ Analyzing architecture — done
├─ Checking test coverage — done
└─ Reviewing dependencies — ⏳
```

**Final reply (status auto-deleted):**
```
✅ Analysis complete:
├─ Architecture — 29 .ts files, clean module structure
├─ Tests — 85% coverage, 3 files missing tests
└─ Dependencies — all up to date, no vulnerabilities
```

### Technical notes

- Agents must be launched with `run_in_background: true` for incremental updates
- Each agent completion triggers a status update with the full tree
- Very fast agents (< 5 sec) may complete before intermediate statuses are sent
- Works best with real tasks (code analysis, reviews, implementation) where agents run 20-60+ seconds

---

## File Diffs in Status

The `update_status` tool supports an optional `diff` parameter to show file changes as a separate message.

```
update_status(chat_id, "Editing src/bot.ts...", diff="```diff\n- old line\n+ new line\n```")
```

This sends the diff as a separate code-formatted message above the status, useful when editing multiple files so the user can track changes in real-time.

---

## Session Naming

Claude automatically names sessions after the project directory on startup:

```
set_session_name(name="helyx", project_path="/home/user/bots/helyx")
```

This makes `/sessions` in Telegram show meaningful names instead of random IDs.

---

## Memory Integration

Claude can save and recall project-specific memories through the bot:

```
remember(text="API rate limit is 100 req/min per user", chat_id="...")
recall(query="rate limit", chat_id="...")
```

Memories are scoped to the project directory — all sessions in the same project share the same memory pool. Useful for persisting decisions, architecture notes, and context across sessions.

---

## Permission Forwarding

When Claude needs to run a potentially dangerous command, the bot forwards the permission request to Telegram with inline buttons:

```
Telegram shows:
┌─────────────────────────────────────┐
│ 🔐 Permission Request              │
│                                     │
│ Bash: rm -rf dist/ && bun build     │
│                                     │
│ [Allow] [Always Allow] [Deny]       │
└─────────────────────────────────────┘
```

For file edits, the bot also shows a syntax-highlighted diff preview. Configure auto-approve patterns in `settings.local.json` to skip approval for trusted tools.

---

## Standalone vs CLI Mode

| Feature | Standalone | CLI Session |
|---------|-----------|-------------|
| Response source | LLM API (Anthropic/OpenRouter/Ollama) | Claude Code CLI |
| File access | None | Full project access |
| Status updates | None | Real-time via tmux/MCP |
| Permissions | N/A | Forwarded to Telegram |
| Memory | Shared per chat | Shared per project |
| Voice/Photos | Transcription + analysis | Forwarded to CLI |

Switch between modes: `/standalone` for chat mode, `/switch <id>` for CLI sessions.

### Dashboard
<img width="1722" height="885" alt="image" src="https://github.com/user-attachments/assets/4ba73c7c-1141-4fe7-b9af-5293d95cf5e8" />

