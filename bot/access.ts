import type { Context, NextFunction } from "grammy";
import { CONFIG } from "../config.ts";
import { logger } from "../logger.ts";

export async function accessMiddleware(
  ctx: Context,
  next: NextFunction,
): Promise<void> {
  const userId = ctx.from?.id;

  if (!userId) return;

  // If explicitly opened to all users
  if (CONFIG.ALLOW_ALL_USERS) {
    return next();
  }

  if (CONFIG.ALLOWED_USERS.includes(userId)) {
    return next();
  }

  // Silently drop unauthorized messages
  logger.warn({ userId }, "access denied");
}
