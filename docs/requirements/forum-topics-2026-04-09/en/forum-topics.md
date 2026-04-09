# PRD: Telegram Forum Topics — One Topic Per Project

**Date:** 2026-04-09
**Status:** Ready to implement
**Branch:** `feat/forum-topics`

---

## Overview

Replace the single-thread DM interaction model with a Telegram Forum Supergroup where each project is a dedicated **topic (thread)**. The user opens the relevant topic to interact with that project's Claude session — no `/switch` needed, no context bleeding between projects.

---

## Problem

Today all projects share one private DM chat. The user must:
1. `/switch keryx` — to talk to keryx
2. `/switch claude-bot` — to talk to claude-bot
3. etc.

All status updates, permission requests, and replies from multiple projects appear in the same thread. Context is confusing and the `/switch` ceremony is friction.

With 5+ active projects this becomes unmanageable.

---

## Solution

Use Telegram's **Forum Topics** API:

- User creates a dedicated supergroup, enables **Topics** in group settings
- Adds the bot as admin with `manage_topics` permission
- Runs `/forum_setup` in the group — bot records the group as `FORUM_CHAT_ID`
- Each project gets its own topic (thread) — created automatically when:
  - `/forum_setup` runs (for existing projects)
  - `/project_add` is called (for new projects)
- **The General topic (thread\_id=1)** becomes the meta/control channel (commands like `/sessions`, `/status`, `/projects`)
- **All other topics** each map 1:1 to a project — messages go directly to the right Claude session without `/switch`

---

## Telegram API: Key Facts

### Requirements
- Chat type must be **supergroup** with `is_forum: true`
- Bot must be admin with **`can_manage_topics`** permission
- Bot cannot enable topics on an existing group via Bot API — the user must do it in Telegram settings (or via user account API)

### Forum Topic Methods (Bot API)
| Method | Parameters | Returns |
|--------|-----------|---------|
| `createForumTopic` | `chat_id`, `name`, optional: `icon_color` (int RGB), `icon_custom_emoji_id` | `ForumTopic` with `message_thread_id` |
| `editForumTopic` | `chat_id`, `message_thread_id`, optional: `name`, `icon_custom_emoji_id` | `True` |
| `closeForumTopic` | `chat_id`, `message_thread_id` | `True` |
| `reopenForumTopic` | `chat_id`, `message_thread_id` | `True` |
| `deleteForumTopic` | `chat_id`, `message_thread_id` (non-General only) | `True` |
| `pinChatMessage` | `chat_id`, `message_id`, optional: `message_thread_id` | `True` |
| `getForumTopicIconStickers` | — | list of `Sticker` |

### Sending Messages to a Topic
All send methods (`sendMessage`, `sendPhoto`, `sendDocument`, etc.) accept:
- `message_thread_id` — routes the message to that specific topic

### Message Object Fields
- `message_thread_id` — topic ID of incoming message
- `is_topic_message` — `true` if message is in a topic

### Topic Icon Colors (6 predefined, RGB integers)
`0x6FB9F0` (blue), `0xFFD67E` (yellow), `0xCB86DB` (violet),
`0x8EEE98` (green), `0xFF93B2` (pink), `0xFB6F5F` (red)

### General Topic
- Always exists, ID = `1`, cannot be deleted
- Messages sent without `message_thread_id` go here (or to General if forum bot has topics enabled in private chats)

### grammY API
```typescript
// Create topic
const topic = await bot.api.createForumTopic(chatId, "keryx", {
  icon_color: 0x6FB9F0,
});
const threadId = topic.message_thread_id;

// Send to topic
await bot.api.sendMessage(chatId, "text", {
  message_thread_id: threadId,
});

// Detect incoming topic message
bot.on("message", (ctx) => {
  const threadId = ctx.message.message_thread_id; // undefined if General
  const chatId = ctx.chat.id;
});
```

---

## Functional Requirements

### FR-1: Forum Setup Command

`/forum_setup` — run in the supergroup, by allowed user.

Behavior:
1. Verify chat type is supergroup + `is_forum: true`
2. Verify bot has `can_manage_topics` in this chat
3. Save `forum_chat_id` to DB config (or env; see FR-8)
4. For each existing project in `projects` table that has no `forum_topic_id`:
   - Call `createForumTopic(forum_chat_id, project.name, { icon_color: … })`
   - Save returned `message_thread_id` → `projects.forum_topic_id`
5. Reply in General topic: "✅ Forum configured. N topics created."

Icon color assigned round-robin from the 6 predefined colors.

---

### FR-2: Auto-Create Topic on `/project_add`

When forum is configured (`forum_chat_id` is set in DB), `/project_add` additionally:
1. Creates a topic for the new project
2. Saves `forum_topic_id` to the `projects` row
3. Sends a welcome message in the new topic:
   ```
   📁 keryx
   /home/altsay/keryx
   Session: #53
   ```

---

### FR-3: Message Routing by Topic

In `bot/text-handler.ts` (and media/voice handlers), routing must consider `message_thread_id`:

```
incoming message:
  chat_id = forum_chat_id AND message_thread_id = N
    → look up project WHERE forum_topic_id = N
    → route to that project's active session
  chat_id = forum_chat_id AND message_thread_id = 1 (General)
    → treat as DM: route by active session from chat_sessions
  chat_id = private DM (existing behavior)
    → unchanged
```

The `routeMessage(chatId)` function needs a new overload / second parameter:
```typescript
routeMessage(chatId: string, forumTopicId?: number): Promise<Route>
```

When `forumTopicId` is provided:
- Query `projects` WHERE `forum_topic_id = forumTopicId`
- Return that project's active remote session
- If no session active → reply in topic: "⚠️ Session not running. Start it with /projects."

---

### FR-4: All Bot Replies Include `message_thread_id`

When the incoming message has a `message_thread_id`, all bot replies to that message must include the same `message_thread_id`:
- `ctx.reply(text)` → `ctx.reply(text, { message_thread_id: threadId })`

This applies to:
- Text replies
- Inline keyboard messages (permission requests, `/projects` buttons, etc.)
- Error messages

Implementation: create a helper `replyInThread(ctx, text, options?)` that auto-injects `message_thread_id` from `ctx.message.message_thread_id`. Use this everywhere instead of bare `ctx.reply()`.

---

### FR-5: Status Messages and Channel Adapter in Topics

`channel/status.ts` and `channel/telegram.ts` currently use only `chatId`.

When forum is active, the channel adapter for a project session must use:
- `chatId = forum_chat_id`
- `threadId = project.forum_topic_id`

Changes:
- `sendTelegramMessage(token, chatId, text, opts)` → pass `message_thread_id` in opts
- `editTelegramMessage(token, chatId, msgId, text, opts)` — no change (edit doesn't need thread_id)
- `StatusManager.sendStatusMessage(chatId, stage)` → accept optional `threadId`, pass to sendTelegramMessage

The channel adapter (`channel/session.ts`) resolves `chatId` from project's `client_id`. For remote sessions in forum mode, it must also resolve `threadId` from `projects.forum_topic_id`.

Store in session context: `forumThreadId: number | null`.

---

### FR-6: Permission Forwarding to the Right Topic

`channel/permissions.ts` sends permission request buttons to Telegram. Currently uses `chatId` from `chat_sessions`. In forum mode, the permission request must appear in the relevant project's topic.

When the session has a `forum_topic_id`, pass `message_thread_id: forumThreadId` to the permission message send call.

---

### FR-7: Topic Management Commands (General topic only)

New bot commands (valid only from General topic or private DM):

| Command | Behavior |
|---------|----------|
| `/forum_setup` | Configure forum (FR-1) |
| `/forum_sync` | Re-sync all projects: create missing topics, close topics for deleted projects |
| `/topic_rename <name>` | Rename current topic (run from within a project topic) |
| `/topic_close` | Close current topic (project paused) |
| `/topic_reopen` | Reopen current topic |

---

### FR-8: DB Schema Changes (migration v13)

```sql
-- projects table: store forum topic ID
ALTER TABLE projects ADD COLUMN forum_topic_id INTEGER;

-- Global bot config table (new, if not exists)
CREATE TABLE IF NOT EXISTS bot_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Store forum_chat_id here
INSERT INTO bot_config (key, value) VALUES ('forum_chat_id', '') ON CONFLICT DO NOTHING;
```

`forum_chat_id` is stored in `bot_config` (not env var) so it can be set at runtime by `/forum_setup` without restart.

---

### FR-9: Backward Compatibility

All existing behavior (private DM chat) remains fully functional:
- If `forum_chat_id` is not configured → bot works exactly as before
- Forum mode is **additive**: DM still works
- Users who don't use forum get zero impact

---

### FR-10: Forum Topic Status Line

When Claude is working in a project topic, the status message (e.g. `⏳ 12s  Editing: server.ts`) appears **in that topic**. No project name prefix needed (the topic itself provides context).

Remove the `📌 ${sessionName} · ` prefix from status messages when running in forum mode (it's redundant — the topic already identifies the project).

---

## Non-Goals

- Automatically enabling forum mode on a group (requires user account API, not Bot API)
- Multi-user forum (multiple people in one supergroup) — auth/isolation is future
- Topic per branch or per task (1 topic = 1 project is the right granularity for now)
- Telegram Channels (only supergroups support topics for bots)
- Mobile notifications per-topic (Telegram handles this natively)

---

## User Experience Flow

### Setup (one-time)
1. User creates Telegram supergroup: "🧠 Dev Hub"
2. Enables Topics in group Settings → Group type → Topics
3. Adds bot, promotes to admin, enables "Manage Topics"
4. In General topic: `/forum_setup`
5. Bot creates topics: "keryx", "claude-bot", "cralson-bot", "vantage-frontend"
6. Done — topics appear in the left sidebar

### Daily Use
1. User taps "keryx" topic in sidebar
2. Types: "добавь тест для auth middleware"
3. Bot replies in the same topic — status updates appear here
4. Switches to "claude-bot" topic — separate thread, different session
5. No `/switch` ever needed

### Permission Requests
- "claude-bot" session requests permission → button appears in "claude-bot" topic
- "keryx" session requests permission → button appears in "keryx" topic
- No more all-sessions permissions mixed in one DM

---

## Implementation Order

1. **DB migration v13** — add `forum_topic_id` to projects, create `bot_config` table
2. **`services/forum-service.ts`** — `setup(chatId)`, `createTopicForProject(project)`, `syncTopics()`, `getForumConfig()`
3. **`bot/commands/forum.ts`** — `/forum_setup`, `/forum_sync`, `/topic_rename`, `/topic_close`, `/topic_reopen`
4. **`sessions/router.ts`** — extend `routeMessage()` to accept `forumTopicId?`
5. **`bot/text-handler.ts`** — extract `message_thread_id`, pass to router, use `replyInThread()`
6. **`channel/telegram.ts`** — add `message_thread_id` support to `sendTelegramMessage()`
7. **`channel/status.ts`** — pass `threadId` through `StatusManager`
8. **`channel/session.ts`** — resolve `forumThreadId` from DB for remote sessions
9. **`channel/permissions.ts`** — pass `message_thread_id` to permission messages
10. **Update ROADMAP.md** — move from 💡 Idea to ✅ Done after merge

---

## Files to Create / Modify

| File | Action | Change |
|------|--------|--------|
| `db/migrations/v13.sql` | Create | Add `forum_topic_id` to projects, `bot_config` table |
| `services/forum-service.ts` | Create | Forum setup, topic CRUD, config load/save |
| `bot/commands/forum.ts` | Create | `/forum_setup`, `/forum_sync`, `/topic_*` commands |
| `bot/handlers.ts` | Modify | Register forum commands |
| `bot/bot.ts` | Modify | Add forum commands to bot menu |
| `bot/text-handler.ts` | Modify | Extract `message_thread_id`, forum-aware routing |
| `bot/media.ts` | Modify | Pass `message_thread_id` in voice/image handlers |
| `sessions/router.ts` | Modify | `routeMessage(chatId, forumTopicId?)` |
| `channel/telegram.ts` | Modify | `sendTelegramMessage` accepts `message_thread_id` in opts |
| `channel/status.ts` | Modify | `StatusManager` carries `threadId`, passes to send calls |
| `channel/session.ts` | Modify | Load `forumThreadId` from project row on session init |
| `channel/permissions.ts` | Modify | Include `message_thread_id` in permission request sends |
| `docs/ROADMAP.md` | Modify | Move from 💡 to 📋 Planned (after PRD), then ✅ Done |

---

## Acceptance Criteria

- [ ] `/forum_setup` in a forum supergroup creates topics for all projects and stores `forum_chat_id`
- [ ] Messages in a project topic route to that project's active Claude session
- [ ] Bot replies appear in the same topic as the user's message
- [ ] Status updates (⏳ working...) appear in the correct topic
- [ ] Permission request buttons appear in the correct project topic
- [ ] `/project_add` creates a forum topic when forum is configured
- [ ] General topic (thread_id=1) works as control channel (commands, `/projects`, `/status`)
- [ ] Private DM mode still works unchanged when no forum is configured
- [ ] `/forum_sync` adds missing topics and closes topics for removed projects
- [ ] DB migration v13 runs cleanly on top of v12
- [ ] `bun test tests/unit/` passes (all existing unit tests green)
