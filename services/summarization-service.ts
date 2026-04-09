import {
  touchIdleTimer,
  checkOverflow,
  forceSummarize,
  summarizeOnDisconnect,
  cleanupStaleTimers,
} from "../memory/summarizer.ts";
import { extractProjectKnowledge } from "../memory/summarizer.ts";

export class SummarizationService {
  /**
   * Reset the idle timer for a session/chat.
   * Should be called after each user message to trigger summarization on inactivity.
   */
  touchIdleTimer(sessionId: number, chatId: string, projectPath?: string | null): void {
    touchIdleTimer(sessionId, chatId, projectPath);
  }

  /**
   * Check if message count exceeds threshold and summarize if needed.
   * Call after adding a message in standalone mode.
   */
  async checkOverflow(sessionId: number, chatId: string, projectPath?: string | null): Promise<void> {
    await checkOverflow(sessionId, chatId, projectPath);
  }

  /**
   * Force summarize current conversation. Returns the summary text or null.
   */
  async force(sessionId: number, chatId: string, projectPath?: string | null): Promise<string | null> {
    return forceSummarize(sessionId, chatId, projectPath);
  }

  /**
   * Summarize on session disconnect — saves context before session terminates.
   */
  async onDisconnect(sessionId: number, projectPath?: string | null): Promise<void> {
    await summarizeOnDisconnect(sessionId, projectPath);
  }

  /**
   * Extract durable project knowledge facts from a completed session.
   * Saves facts to long-term memory.
   */
  async extractProjectKnowledge(
    sessionId: number,
    projectPath: string | null,
    workSummary: string,
    messages: { role: string; content: string }[],
  ): Promise<void> {
    await extractProjectKnowledge(sessionId, projectPath, workSummary, messages);
  }

  /**
   * Clear stale in-memory idle timers (e.g. on process shutdown).
   */
  cleanupStaleTimers(): void {
    cleanupStaleTimers();
  }
}

export const summarizationService = new SummarizationService();
