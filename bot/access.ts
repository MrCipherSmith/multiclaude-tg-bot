import type { Context, NextFunction } from "grammy";
import { CONFIG } from "../config.ts";

export async function accessMiddleware(
  ctx: Context,
  next: NextFunction,
): Promise<void> {
  const userId = ctx.from?.id;

  if (!userId) return;

  // If no allowlist configured, allow everyone (dev mode)
  if (CONFIG.ALLOWED_USERS.length === 0) {
    return next();
  }

  if (CONFIG.ALLOWED_USERS.includes(userId)) {
    return next();
  }

  // Silently drop unauthorized messages
  console.log(`[access] denied user ${userId}`);
}
