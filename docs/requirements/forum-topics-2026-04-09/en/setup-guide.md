# Forum Topics — Setup & Operations Guide

**Branch:** `feat/forum-topics`  
**Migration:** v13

---

## Prerequisites

- Bot is running and responds to DMs
- Migration v13 applied (`bun migrate`)
- Bot token has no changes required (same token)

---

## Step 1 — Apply DB migration

```bash
cd /home/altsay/bots/claude-bot
bun migrate
# Expected: [db] migration 13: forum topics support
```

---

## Step 2 — Create Telegram supergroup

1. In Telegram: **New Group** → add yourself → set name (e.g. `🧠 Dev Hub`)
2. Open group **Settings → Group type → Topics** → enable
3. The group is now a Forum Supergroup

---

## Step 3 — Add bot as admin

1. Open group → **⋮ → Manage Group → Administrators → Add Admin**
2. Search your bot (`@GoodeaAIBot`)
3. Enable permission: **Manage Topics**
4. Save

---

## Step 4 — Run `/forum_setup`

Open the **General** topic of the group and send:

```
/forum_setup
```

Bot will:
- Verify the group has Topics enabled
- Save the group chat ID to `bot_config`
- Create one topic per project (e.g. `keryx`, `claude-bot`, `vantage-frontend`)
- Reply: `✅ Forum configured. N topics created.`

Topics appear in the left sidebar immediately.

---

## Step 5 — Verify

Open any project topic (e.g. `keryx`) and send a message. The bot should:
1. Route the message to the keryx Claude session
2. Reply in the same topic (not General, not DM)
3. Show status updates (`⏳ 3s  Thinking...`) inside that topic
4. Send permission requests as buttons inside that topic

---

## Daily use

| Action | How |
|--------|-----|
| Talk to keryx | Open **keryx** topic, type normally |
| Talk to claude-bot | Open **claude-bot** topic, type normally |
| Check all projects | `/projects` in General topic |
| See sessions | `/sessions` in General topic or DM |
| Add new project | `/project_add /path/to/project` — bot auto-creates topic |

No `/switch` needed. The topic is the project.

---

## Topic management commands

Run from inside a project topic:

```
/topic_rename new-name   — rename topic
/topic_close             — close (pause) topic
/topic_reopen            — reopen topic
```

Run from General topic or DM:

```
/forum_sync              — create missing topics, re-sync
```

---

## Backward compatibility

If `forum_chat_id` is not set in `bot_config` (never ran `/forum_setup`),
the bot works exactly as before — DM mode, `/switch`, all unchanged.

Forum mode is **additive**. DM still works even after setup.

---

## Troubleshooting

### "⚠️ This supergroup does not have Topics enabled"
→ Group Settings → Group type → Topics → enable

### "⚠️ Bot lacks Manage Topics permission"
→ Group → Administrators → bot → enable Manage Topics

### Bot replies in General instead of topic
→ Check migration ran: `bun migrate`  
→ Check `bot_config` row: `SELECT * FROM bot_config WHERE key = 'forum_chat_id';`  
→ Re-run `/forum_setup`

### Project has no topic after `/forum_setup`
→ Run `/forum_sync` to create missing topics  
→ Or check logs for errors during setup

### Status messages appear in DM instead of topic
→ Restart the channel subprocess for that project (it loads forum config on start)  
→ Check `projects.forum_topic_id` is set: `SELECT name, forum_topic_id FROM projects;`

---

## Database checks

```sql
-- Check forum is configured
SELECT key, value FROM bot_config;

-- Check which projects have topics
SELECT name, forum_topic_id FROM projects ORDER BY name;

-- Check a specific project's topic
SELECT name, path, forum_topic_id FROM projects WHERE name = 'keryx';
```

---

## Reset forum (start over)

```sql
-- Clear forum config
UPDATE bot_config SET value = '' WHERE key = 'forum_chat_id';

-- Clear topic IDs (allows /forum_setup to re-create)
UPDATE projects SET forum_topic_id = NULL;
```

Then run `/forum_setup` again. Old topics in Telegram remain but are no longer linked.
