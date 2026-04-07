import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sessionManager } from "../../sessions/manager.ts";
import { routeMessage } from "../../sessions/router.ts";

const CLAUDE_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
];

/**
 * /model — select Claude model for the current active session.
 * Stores selection in cli_config.model.
 */
export async function handleModel(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const route = await routeMessage(chatId);

  if (route.mode === "standalone") {
    await ctx.reply("No active CLI session. /switch to a session first.");
    return;
  }

  if (route.mode === "disconnected") {
    await ctx.reply(`Session "${route.sessionName}" is disconnected.`);
    return;
  }

  const currentModel = (route.cliConfig as any).model ?? "default";

  const keyboard = new InlineKeyboard();
  for (const model of CLAUDE_MODELS) {
    const label = model === currentModel ? `✓ ${model}` : model;
    keyboard.text(label, `set_model:${model}`).row();
  }

  await ctx.reply(
    `Current model: <code>${currentModel}</code>\nSelect a Claude model:`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );
}

/**
 * Callback for model selection. Called from callbacks.ts when data starts with "set_model:".
 */
export async function handleSetModelCallback(ctx: Context, model: string): Promise<void> {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat!.id);
  const route = await routeMessage(chatId);

  if (route.mode !== "cli") {
    await ctx.editMessageText("No active CLI session.");
    return;
  }

  await sessionManager.updateCliConfig(route.sessionId, { model });

  await ctx.editMessageText(
    `✅ Model set to <code>${model}</code> for session #${route.sessionId}`,
    { parse_mode: "HTML" },
  );
}
