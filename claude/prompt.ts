import type { MessageParam } from "./client.ts";
import { recall } from "../memory/long-term.ts";
import { getContext, getProjectHistory, type Message } from "../memory/short-term.ts";
import { sessionManager } from "../sessions/manager.ts";

export async function composePrompt(
  sessionId: number,
  chatId: string,
  currentMessage: string,
): Promise<{ system: string; messages: MessageParam[] }> {
  // Get session info
  const session = await sessionManager.get(sessionId);
  const projectPath = session?.projectPath ?? null;

  // 1. Get long-term memories relevant to current message (by project, not session)
  const memories = await recall(currentMessage, { projectPath, sessionId, limit: 5 });

  // 2. Get short-term context
  let history = await getContext(sessionId, chatId);

  // 3. If short-term context is thin and we have a project, load cross-session history
  if (history.length < 3 && projectPath) {
    const projectHistory = await getProjectHistory(projectPath, chatId);
    if (projectHistory.length > history.length) {
      history = projectHistory;
    }
  }

  // Build system prompt
  const parts: string[] = [
    "Ты — полезный AI-ассистент. Отвечай на том языке, на котором пишет пользователь.",
    `Текущая дата: ${new Date().toISOString().split("T")[0]}.`,
  ];

  if (session && session.name && session.name !== "standalone") {
    parts.push(
      `Текущая сессия: "${session.name}"${session.projectPath ? ` (${session.projectPath})` : ""}.`,
    );
  }

  if (memories.length > 0) {
    parts.push("\n## Релевантные воспоминания из долгосрочной памяти:");
    for (const m of memories) {
      const dist = Number(m.distance).toFixed(3);
      parts.push(`- [${m.type}] ${m.content} (relevance: ${dist})`);
    }
  }

  const system = parts.join("\n");

  // Build messages array from short-term history
  const messages: MessageParam[] = history.map((msg: Message) => ({
    role: msg.role as "user" | "assistant",
    content: msg.content,
  }));

  // Add current message
  messages.push({ role: "user", content: currentMessage });

  return { system, messages };
}
