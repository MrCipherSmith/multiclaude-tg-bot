import type { Context } from "grammy";
import { sessionManager } from "../../sessions/manager.ts";
import { routeMessage } from "../../sessions/router.ts";
import { setPendingInput } from "../handlers.ts";

/**
 * /add — register the current project as a Claude Code session.
 * If already in an active session, uses its project path.
 * Otherwise prompts the user to enter the path.
 */
export async function handleAdd(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const route = await routeMessage(chatId);

  const currentPath = route.mode !== "standalone"
    ? (route as any).projectPath as string | null
    : null;

  if (currentPath) {
    await registerProject(ctx, chatId, currentPath);
    return;
  }

  await ctx.reply(
    "Enter the absolute path to the project directory to register:\n\n" +
    "<i>Tip: use <code>helyx add .</code> from the shell to register current directory</i>",
    { parse_mode: "HTML" },
  );
  setPendingInput(chatId, async (ctx2) => {
    const path = ctx2.message?.text?.trim();
    if (!path || !path.startsWith("/")) {
      await ctx2.reply("❌ Please enter a valid absolute path (starting with /)");
      return;
    }
    await registerProject(ctx2, chatId, path);
  });
}

async function registerProject(
  ctx: Context,
  chatId: string,
  projectPath: string,
): Promise<void> {
  const { basename } = await import("path");
  const name = basename(projectPath);
  const clientId = `claude-${name}-${Date.now()}`;

  const session = await sessionManager.register(
    clientId,
    name,
    projectPath,
  );

  await sessionManager.switchSession(chatId, session.id);

  await ctx.reply(
    `✅ Session #${session.id} registered: <b>${name}</b>\n` +
    `Path: <code>${projectPath}</code>\n\n` +
    `Start Claude Code with:\n<code>helyx start ${projectPath}</code>`,
    { parse_mode: "HTML" },
  );
}
