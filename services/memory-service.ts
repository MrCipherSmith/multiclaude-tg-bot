/**
 * MemoryService — thin wrapper around memory/long-term.ts.
 * Centralizes all memory operations for the main bot process.
 */

import {
  remember as ltRemember,
  recall as ltRecall,
  forget as ltForget,
  listMemories,
  type Memory,
} from "../memory/long-term.ts";

export type { Memory };

export interface RecallOptions {
  limit?: number;
  sessionId?: number | null;
  projectPath?: string | null;
  type?: string;
  tags?: string[];
}

export interface ListOptions {
  type?: string;
  tags?: string[];
  sessionId?: number | null;
  projectPath?: string | null;
  limit?: number;
  offset?: number;
}

export class MemoryService {
  async remember(memory: Omit<Memory, "id" | "createdAt">): Promise<Memory> {
    return ltRemember(memory as Memory);
  }

  async recall(query: string, options: RecallOptions = {}): Promise<Memory[]> {
    return ltRecall(query, options);
  }

  async forget(id: number): Promise<boolean> {
    return ltForget(id);
  }

  async list(options: ListOptions = {}): Promise<Memory[]> {
    return listMemories(options);
  }
}

export const memoryService = new MemoryService();
