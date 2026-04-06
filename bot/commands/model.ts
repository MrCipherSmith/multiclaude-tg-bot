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
 * /model — select model for the current active session.
 * Works for both Claude Code and opencode sessions.
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

  const { cliType, cliConfig } = route;
  const currentModel = (cliConfig as any).model ?? "default";

  if (cliType === "opencode") {
    // Fetch models from opencode HTTP API
    const { opencodeAdapter } = await import("../../adapters/opencode.ts");
    const models = await opencodeAdapter.listModels(cliConfig);

    if (models.length === 0) {
      await ctx.reply(
        `opencode is not running or returned no models.\n` +
        `Current model: <code>${currentModel}</code>\n\n` +
        `Start opencode: <code>opencode serve</code>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const model of models.slice(0, 20)) {
      const label = model === currentModel ? `✓ ${model}` : model;
      keyboard.text(label, `set_model:${model}`).row();
    }

    await ctx.reply(
      `Current model: <code>${currentModel}</code>\nSelect a model:`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  } else {
    // Claude Code — show available models from config
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

  // Update cli_config.model in sessions table
  await sessionManager.updateCliConfig(route.sessionId, { model });

  await ctx.editMessageText(
    `✅ Model set to <code>${model}</code> for session #${route.sessionId}`,
    { parse_mode: "HTML" },
  );
}
