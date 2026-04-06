import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sessionManager } from "../../sessions/manager.ts";
import { routeMessage } from "../../sessions/router.ts";
import { setPendingInput } from "../handlers.ts";

/**
 * /add — register the current project with a selected provider.
 * Shows inline keyboard: [Claude Code] [opencode]
 */
export async function handleAdd(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const route = await routeMessage(chatId);

  // Try to determine current project path from active session
  const currentPath = route.mode !== "standalone"
    ? (route as any).projectPath
    : null;

  const keyboard = new InlineKeyboard()
    .text("Claude Code", "add_provider:claude")
    .text("opencode", "add_provider:opencode");

  await ctx.reply(
    currentPath
      ? `Register <code>${currentPath}</code> with which provider?`
      : "Register a project. Which provider?\n\n(Use shell <code>claude-bot add --provider claude .</code> to register current directory)",
    { parse_mode: "HTML", reply_markup: keyboard },
  );
}

/**
 * Callback handler for provider selection after /add.
 * Called from callbacks.ts when data starts with "add_provider:".
 */
export async function handleAddProviderCallback(
  ctx: Context,
  provider: "claude" | "opencode",
): Promise<void> {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat!.id);
  const route = await routeMessage(chatId);

  const currentPath = route.mode !== "standalone"
    ? (route as any).projectPath as string | null
    : null;

  if (!currentPath) {
    // Ask user to enter path
    await ctx.editMessageText(
      `Enter the absolute path to the project directory to register with ${provider}:`,
    );
    setPendingInput(chatId, async (ctx2) => {
      const path = ctx2.message?.text?.trim();
      if (!path || !path.startsWith("/")) {
        await ctx2.reply("❌ Please enter a valid absolute path (starting with /)");
        return;
      }
      await registerProject(ctx2, chatId, path, provider);
    });
    return;
  }

  await registerProject(ctx, chatId, currentPath, provider);
}

async function registerProject(
  ctx: Context,
  chatId: string,
  projectPath: string,
  provider: "claude" | "opencode",
): Promise<void> {
  const { basename } = await import("path");
  const name = `${basename(projectPath)} · ${provider}`;
  const clientId = `${provider}-${basename(projectPath)}-${Date.now()}`;

  const cliConfig = provider === "opencode" ? { port: 4096, autostart: false } : {};

  const session = await sessionManager.register(
    clientId,
    name,
    projectPath,
    undefined,
    provider,
    cliConfig,
  );

  // Switch to the new session
  await sessionManager.switchSession(chatId, session.id);

  await ctx.reply(
    `✅ Session #${session.id} registered: <b>${name}</b>\n` +
    `Provider: ${provider}\nPath: <code>${projectPath}</code>\n\n` +
    (provider === "opencode"
      ? `Start opencode with: <code>opencode serve</code> (port 4096)\nor enable autostart: <code>/model</code>`
      : `Start Claude Code with: <code>claude --channels "bun /path/to/claude-bot/channel.ts"</code>`),
    { parse_mode: "HTML" },
  );
}
