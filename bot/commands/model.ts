import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sessionManager } from "../../sessions/manager.ts";
import { routeMessage } from "../../sessions/router.ts";
import { CONFIG } from "../../config.ts";

async function fetchAvailableModels(): Promise<{ id: string; display_name: string }[]> {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": CONFIG.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const json = await res.json() as { data: { id: string; display_name: string }[] };
  return json.data;
}

/**
 * /model — select Claude model for the current active session.
 * Fetches available models from the Anthropic API and stores selection in cli_config.model.
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

  let models: { id: string; display_name: string }[];
  try {
    models = await fetchAvailableModels();
  } catch {
    await ctx.reply("Failed to fetch model list from Anthropic API.");
    return;
  }

  if (models.length === 0) {
    await ctx.reply("No models returned from Anthropic API.");
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const m of models) {
    const active = m.id === currentModel;
    const label = active ? `✅ ${m.display_name}` : m.display_name;
    keyboard.text(label, `set_model:${m.id}`).row();
  }

  await ctx.reply(
    `Current model: <code>${currentModel}</code>\n\nSelect a Claude model:`,
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
