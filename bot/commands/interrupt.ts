/**
 * /interrupt command — send Escape to interrupt the running Claude session.
 *
 * - If one active remote session: interrupts immediately, no buttons needed.
 * - If multiple: shows a list with ⚡ Interrupt buttons per session.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sql } from "../../memory/db.ts";

export async function handleInterrupt(ctx: Context): Promise<void> {
  const active = await sql`
    SELECT id, project, name, last_active
    FROM sessions
    WHERE source = 'remote' AND status = 'active' AND id != 0
    ORDER BY last_active DESC
  `;

  if (active.length === 0) {
    await ctx.reply("No active remote sessions to interrupt.");
    return;
  }

  if (active.length === 1) {
    const s = active[0];
    const project = s.project ?? s.name;
    await sql`
      INSERT INTO admin_commands (command, payload)
      VALUES ('tmux_send_keys', ${JSON.stringify({ project, action: "esc" })}::jsonb)
    `;
    await ctx.reply(`⚡ Interrupt sent to <b>${project}</b>.`, { parse_mode: "HTML" });
    return;
  }

  // Multiple sessions — let user pick
  const kb = new InlineKeyboard();
  for (const s of active) {
    const project = s.project ?? s.name;
    kb.text(`⚡ ${project}`, `tmux:esc:${project}`).row();
  }

  const lines = active.map((s) => {
    const project = s.project ?? s.name;
    const ago = Math.round((Date.now() - new Date(s.last_active).getTime()) / 1000);
    const agoStr = ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.floor(ago / 60)}m` : `${Math.floor(ago / 3600)}h`;
    return `• <b>${project}</b> — ${agoStr} ago`;
  });

  await ctx.reply(
    `Active sessions — choose which to interrupt:\n\n${lines.join("\n")}`,
    { parse_mode: "HTML", reply_markup: kb },
  );
}
