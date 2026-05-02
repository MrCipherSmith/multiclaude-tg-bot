import type { Context } from "grammy";
import { replyInThread } from "../format.ts";

const QUICKSTART_TEXT = `🚀 <b>Quick Start</b>

<b>Step 1 — Create a forum supergroup</b>
Create a Telegram Supergroup → enable Topics (group settings → Topics) → add the bot as administrator.

<b>Step 2 — Set up the forum</b>
In the group: /forum_setup

<b>Step 3 — Add your projects</b>
In a private chat with the bot: /project_add
(the bot will create a topic for each project in the forum)

<b>Step 4 — Sync topics</b>
In the group: /forum_sync

<b>Step 5 — Start Claude Code in your project</b>
<code>claude</code> — inside the project directory.
The bot will automatically connect the session to the correct topic.

<b>Step 6 — Set up the supervisor (optional)</b>
Create a separate "Supervisor" topic in the forum → copy its ID → add to <code>.env</code>:
<code>SUPERVISOR_TOPIC_ID=&lt;topic id&gt;</code>
The supervisor will send alerts there and answer questions about system state.
Start it with: <code>bun scripts/admin-daemon.ts</code>

✅ <b>Done.</b> Each topic has its own Claude Code session.

<i>Use /help for the full command list.</i>`;

export async function handleQuickstart(ctx: Context): Promise<void> {
  await replyInThread(ctx, QUICKSTART_TEXT, { parse_mode: "HTML" });
}
