import { sessionManager } from "./manager.ts";

export type RouteTarget =
  | { mode: "standalone"; sessionId: 0; projectPath?: null }
  | { mode: "cli"; sessionId: number; clientId: string; projectPath?: string | null }
  | { mode: "disconnected"; sessionId: number; sessionName: string | null; projectPath?: string | null };

export async function routeMessage(chatId: string): Promise<RouteTarget> {
  const sessionId = await sessionManager.getActiveSession(chatId);

  if (sessionId === 0) {
    return { mode: "standalone", sessionId: 0 };
  }

  const session = await sessionManager.get(sessionId);

  if (!session) {
    // Session was deleted, reset to standalone
    await sessionManager.switchSession(chatId, 0);
    return { mode: "standalone", sessionId: 0 };
  }

  if (session.status === "disconnected") {
    return { mode: "disconnected", sessionId, sessionName: session.name, projectPath: session.projectPath };
  }

  return { mode: "cli", sessionId, clientId: session.clientId, projectPath: session.projectPath };
}
