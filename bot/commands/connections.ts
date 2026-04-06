import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { routeMessage } from "../../sessions/router.ts";

/**
 * /connections — manage opencode provider connections (API keys).
 * Only available for opencode sessions.
 */
export async function handleConnections(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const route = await routeMessage(chatId);

  if (route.mode !== "cli") {
    await ctx.reply("No active CLI session. /switch to a session first.");
    return;
  }

  if (route.cliType !== "opencode") {
    await ctx.reply(
      "ℹ️ /connections is only available for opencode sessions.\n" +
      `Current session uses: <b>Claude Code</b>`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const { opencodeAdapter } = await import("../../adapters/opencode.ts");
  const providers = await opencodeAdapter.listProviders(route.cliConfig);

  if (providers.length === 0) {
    await ctx.reply(
      `opencode is not running or returned no providers.\n` +
      `Start opencode: <code>opencode serve</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const keyboard = new InlineKeyboard();
  const lines: string[] = ["<b>opencode connections:</b>\n"];

  for (const p of providers) {
    const status = p.configured ? "✅" : "❌";
    lines.push(`${status} <b>${p.name}</b> (<code>${p.id}</code>)`);
    if (!p.configured) {
      keyboard.text(`Configure ${p.name}`, `configure_provider:${p.id}`).row();
    }
  }

  lines.push("\nConfigure providers in your opencode settings or via <code>opencode auth</code>");

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
  });
}

/**
 * Callback for provider configuration. Called from callbacks.ts.
 */
export async function handleConfigureProviderCallback(
  ctx: Context,
  providerId: string,
): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `To configure <b>${providerId}</b>:\n\n` +
    `Run in your terminal:\n<code>opencode auth ${providerId}</code>\n\n` +
    `Or set the API key in your opencode config file.`,
    { parse_mode: "HTML" },
  );
}
