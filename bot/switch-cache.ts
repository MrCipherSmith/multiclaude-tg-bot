/**
 * In-memory cache for session switch briefings.
 * Stores the last loaded project context summary for each chat.
 * Lives until next switch or 60 min TTL.
 */

export interface SwitchContext {
  summary: string;
  sessionId: number;
  projectPath: string;
  loadedAt: Date;
}

const cache = new Map<string, SwitchContext>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const TTL_MS = 60 * 60 * 1000; // 60 minutes

export function setSwitchContext(chatId: string, ctx: SwitchContext): void {
  // Clear existing timer
  const existing = timers.get(chatId);
  if (existing) clearTimeout(existing);

  cache.set(chatId, ctx);
  timers.set(chatId, setTimeout(() => {
    cache.delete(chatId);
    timers.delete(chatId);
  }, TTL_MS));
}

export function getSwitchContext(chatId: string): SwitchContext | undefined {
  return cache.get(chatId);
}

export function clearSwitchContext(chatId: string): void {
  cache.delete(chatId);
  const t = timers.get(chatId);
  if (t) { clearTimeout(t); timers.delete(chatId); }
}
