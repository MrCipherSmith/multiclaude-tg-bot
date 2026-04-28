/**
 * Telegram callback handlers for per-session tmux actions.
 * Callback data format: tmux:ACTION:PROJECT_NAME
 *
 * Actions:
 *   esc          — send Escape to interrupt Claude, auto-confirm if prompted
 *   close_editor — force-close vim (:q!) or nano (^X n)
 *
 * Queues an admin_command so the host-side admin-daemon executes the
 * tmux send-keys outside the Docker container.
 */

import type { Context } from "grammy";
import { sql } from "../../memory/db.ts";

export async function handleTmuxActionCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  // tmux:ACTION:project (project name may contain colons — join from index 2)
  const parts   = data.split(":");
  const action  = parts[1];
  const project = parts.slice(2).join(":");

  if (!action || !project) {
    await ctx.answerCallbackQuery({ text: "Invalid action" });
    return;
  }

  const label: Record<string, string> = {
    esc:          "⚡ Interrupt sent",
    close_editor: "📝 Close editor sent",
  };

  if (!(action in label)) {
    await ctx.answerCallbackQuery({ text: "Unknown action" });
    return;
  }

  await sql`
    INSERT INTO admin_commands (command, payload)
    VALUES ('tmux_send_keys', ${sql.json({ project, action })})
  `;

  await ctx.answerCallbackQuery({ text: label[action] });
  // Remove buttons so the action can't be triggered twice
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
}
