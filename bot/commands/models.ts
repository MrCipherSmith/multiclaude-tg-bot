/**
 * /models — list available model profiles, allow setting one as the
 * current session's active profile.
 */
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sql } from "../../memory/db.ts";
import { routeMessage } from "../../sessions/router.ts";

export async function handleModels(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id ?? "");
  const route = await routeMessage(chatId, ctx.msg?.message_thread_id);
  const sessionId = route.mode === "cli" ? route.sessionId : 0;

  let rows: Array<{
    profile_id: number; profile_name: string; model: string;
    provider_name: string; provider_type: string;
    profile_enabled: boolean; provider_enabled: boolean;
  }>;
  try {
    rows = await sql`
      SELECT
        p.id        AS profile_id,
        p.name      AS profile_name,
        p.model     AS model,
        pr.name     AS provider_name,
        pr.provider_type,
        p.enabled   AS profile_enabled,
        pr.enabled  AS provider_enabled
      FROM model_profiles p
      JOIN model_providers pr ON pr.id = p.provider_id
      ORDER BY pr.name, p.name
    ` as any;
  } catch (err) {
    await ctx.reply(
      "⚠️ <b>model_profiles</b> table not available.\n\n" +
        "Run the migration first: <code>bun memory/db.ts</code>",
      { parse_mode: "HTML" },
    );
    return;
  }

  if (rows.length === 0) {
    await ctx.reply("No model profiles configured. Use /providers to see configured providers.");
    return;
  }

  // Get current session's model_profile_id
  let currentProfileId: number | null = null;
  if (sessionId > 0) {
    const [s] = await sql`
      SELECT model_profile_id FROM sessions WHERE id = ${sessionId} LIMIT 1
    ` as any;
    currentProfileId = s?.model_profile_id ?? null;
  }

  const keyboard = new InlineKeyboard();
  const lines: string[] = ["<b>Available model profiles</b>:"];

  // Group by provider for display
  const byProvider = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byProvider.get(r.provider_name) ?? [];
    arr.push(r);
    byProvider.set(r.provider_name, arr);
  }

  for (const [providerName, profiles] of byProvider) {
    lines.push(`\n<i>${providerName}</i>:`);
    for (const p of profiles) {
      const checkmark = p.profile_id === currentProfileId ? "✓ " : "";
      const disabled = !p.profile_enabled || !p.provider_enabled ? " 🚫" : "";
      lines.push(`  ${checkmark}<b>${p.profile_name}</b> — <code>${p.model}</code>${disabled}`);
      if (p.profile_enabled && p.provider_enabled && sessionId > 0) {
        const label = p.profile_id === currentProfileId
          ? `✓ ${p.profile_name} (${p.model})`
          : `${p.profile_name} (${p.model})`;
        keyboard.text(label, `set_profile:${p.profile_id}`).row();
      }
    }
  }

  if (sessionId === 0) {
    lines.push("\n<i>(No active session — start a session to enable profile selection.)</i>");
  }

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: sessionId > 0 ? keyboard : undefined,
  });
}

/**
 * Callback handler for `set_profile:<id>` — updates session.model_profile_id.
 */
export async function handleSetProfile(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const m = data?.match(/^set_profile:(\d+)$/);
  if (!m) {
    await ctx.answerCallbackQuery({ text: "Invalid callback" });
    return;
  }
  const profileId = parseInt(m[1], 10);

  const chatId = String(ctx.chat?.id ?? "");
  const route = await routeMessage(chatId, ctx.msg?.message_thread_id);
  if (route.mode !== "cli") {
    await ctx.answerCallbackQuery({ text: "No active session in this chat", show_alert: true });
    return;
  }

  // Verify the profile exists and is enabled (defense-in-depth)
  const [profile] = await sql`
    SELECT p.id, p.name, p.model, p.enabled, pr.enabled AS provider_enabled
    FROM model_profiles p JOIN model_providers pr ON pr.id = p.provider_id
    WHERE p.id = ${profileId} LIMIT 1
  ` as any;
  if (!profile || !profile.enabled || !profile.provider_enabled) {
    await ctx.answerCallbackQuery({ text: "Profile not available", show_alert: true });
    return;
  }

  await sql`
    UPDATE sessions SET model_profile_id = ${profileId} WHERE id = ${route.sessionId}
  `;

  await ctx.answerCallbackQuery({ text: `Set: ${profile.name} (${profile.model})` });
  await ctx.reply(`✓ Session model profile set to <b>${profile.name}</b> (<code>${profile.model}</code>)`, {
    parse_mode: "HTML",
  });
}
