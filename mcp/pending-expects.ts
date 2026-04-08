/**
 * Shared registry of pending expect registrations.
 * channel.ts calls POST /api/sessions/expect → stored here.
 * On HTTP MCP transport init or first tool call → auto-link to channel session.
 */
import { sessionManager } from "../sessions/manager.ts";

const EXPECT_TTL_MS = 60_000; // 1 minute

interface PendingExpect {
  sessionId: number;
  created: number;
}

export const pendingExpects: PendingExpect[] = [];

export function pushExpect(sessionId: number): void {
  const now = Date.now();
  // Evict stale
  while (pendingExpects.length > 0 && now - pendingExpects[0].created > EXPECT_TTL_MS) {
    pendingExpects.shift();
  }
  pendingExpects.push({ sessionId, created: now });
}

/**
 * Try to auto-link an HTTP MCP transport to a pending channel.ts session.
 * Safe to call multiple times — no-op if already linked or no pending.
 */
export async function tryAutoLink(clientId: string): Promise<void> {
  if (sessionManager.getSessionIdByClient(clientId) !== undefined) return;
  const now = Date.now();
  while (pendingExpects.length > 0 && now - pendingExpects[0].created > EXPECT_TTL_MS) {
    pendingExpects.shift();
  }
  const pending = pendingExpects.shift();
  if (pending) {
    await sessionManager.linkClientToSession(clientId, pending.sessionId);
  }
}
