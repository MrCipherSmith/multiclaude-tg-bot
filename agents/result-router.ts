/**
 * Route standalone-llm task results to Telegram forum topics.
 *
 * Pre-v1.39.0, standalone-llm task results were silently written to
 * `agent_tasks.result` and the operator had to run `/task <id>` to see
 * them. With `agent_instances.forum_topic_id` (migration v33), an
 * instance can be bound to a forum topic — when set, this module posts
 * the task result there as a regular Telegram message after completion.
 *
 * Architecture note: the standalone-llm worker runs as a separate Bun
 * process (in a tmux window) NOT inside the bot container. We could
 * proxy through a notification queue, but for now the worker
 * instantiates its own minimal `grammy` Api client using
 * `TELEGRAM_BOT_TOKEN` from env. Same token, same bot identity — the
 * message looks like the helyx bot posted it.
 *
 * Failures here are LOGGED, not raised — a failed Telegram post must
 * not flip the task to status='failed'. The result is already
 * persisted in agent_tasks.result; the topic post is a
 * notification convenience.
 */

import { Api } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { sql } from "../memory/db.ts";
import { logger } from "../logger.ts";

/** Cached Api instance — built on first use. Token comes from env. */
let cachedApi: Api | null = null;
function getApi(): Api | null {
  if (cachedApi) return cachedApi;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const api = new Api(token);
  api.config.use(autoRetry({ maxRetryAttempts: 2, rethrowInternalServerErrors: false }));
  cachedApi = api;
  return api;
}

/**
 * Look up `forum_topic_id` for an agent_instance. Returns null when:
 *  - the instance has no topic binding, OR
 *  - the row is missing.
 */
export async function getForumTopicId(agentInstanceId: number): Promise<number | null> {
  const rows = (await sql`
    SELECT forum_topic_id FROM agent_instances WHERE id = ${agentInstanceId} LIMIT 1
  `) as { forum_topic_id: number | string | null }[];
  if (rows.length === 0) return null;
  const v = rows[0]!.forum_topic_id;
  if (v == null) return null;
  return Number(v);
}

/** Look up the global forum chat id from bot_config. */
async function getForumChatId(): Promise<string | null> {
  const rows = (await sql`
    SELECT value FROM bot_config WHERE key = 'forum_chat_id'
  `) as { value: string | null }[];
  if (rows.length === 0) return null;
  const v = rows[0]!.value;
  return v && v.length > 0 ? v : null;
}

/**
 * Post a task result to the agent's bound forum topic.
 *
 * No-op (returns false) when:
 *  - agent_instance has no forum_topic_id
 *  - bot_config has no forum_chat_id
 *  - TELEGRAM_BOT_TOKEN env var missing
 *  - Telegram API call fails (logged but not thrown)
 *
 * Returns true on a successful post. Worker can use this to log a
 * `task_result_posted` agent_event for traceability.
 *
 * Truncation: Telegram caps message text at 4096 chars. We trim to
 * 3800 to leave room for the header + metadata. Long results stay
 * fully in agent_tasks.result; the topic post is a teaser pointing
 * back to `/task <id>`.
 */
export async function routeTaskResultToTopic(args: {
  agentInstanceId: number;
  agentName: string;
  taskId: number;
  taskTitle: string;
  resultText: string;
}): Promise<boolean> {
  const topicId = await getForumTopicId(args.agentInstanceId);
  if (topicId == null) return false;

  const chatId = await getForumChatId();
  if (!chatId) {
    logger.info(
      { agentInstanceId: args.agentInstanceId, taskId: args.taskId },
      "result-router: agent has forum_topic_id but bot_config.forum_chat_id is unset; skipping post",
    );
    return false;
  }

  const api = getApi();
  if (!api) {
    logger.warn(
      { agentInstanceId: args.agentInstanceId, taskId: args.taskId },
      "result-router: TELEGRAM_BOT_TOKEN env var missing; cannot post",
    );
    return false;
  }

  const MAX = 3800;
  const truncated = args.resultText.length > MAX
    ? args.resultText.slice(0, MAX) + `\n\n…(truncated; full output in /task ${args.taskId})`
    : args.resultText;
  const text =
    `🤖 <b>${escapeHtml(args.agentName)}</b> finished task #${args.taskId}\n` +
    `<i>${escapeHtml(args.taskTitle)}</i>\n\n` +
    `${escapeHtml(truncated)}`;

  try {
    await api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      message_thread_id: topicId,
      // Disable preview to keep noise low.
      link_preview_options: { is_disabled: true },
    });
    return true;
  } catch (err) {
    logger.warn(
      {
        agentInstanceId: args.agentInstanceId,
        taskId: args.taskId,
        topicId,
        chatId,
        err: String(err),
      },
      "result-router: Telegram sendMessage failed; result remains in agent_tasks.result",
    );
    return false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
