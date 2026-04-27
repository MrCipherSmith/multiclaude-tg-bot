/**
 * Auto-inject project context into standalone-llm agent prompts.
 *
 * standalone-llm agents (planner, reviewer, orchestrator) had no
 * project-awareness pre-v1.39.0 — they saw only `task.title`,
 * `task.description`, `task.payload`. This module fetches relevant
 * project facts + recent forum messages and formats them as an
 * extension to the agent's system prompt.
 *
 * Sources:
 *  1. memories.type IN ('fact','decision') WHERE project_path = X
 *     — operator-curated facts tagged to the project (architecture
 *     decisions, conventions, gotchas).
 *  2. messages WHERE project_path = X — last N user/assistant turns
 *     in the project's forum topic. Lets the agent see what the team
 *     was just discussing.
 *
 * Token budget: hard cap at ~4000 chars of injected context. Beyond
 * that the LLM context window starts crowding the actual task
 * description. The cap is a rough character count, not a tokenizer-
 * exact measurement — the goal is "don't spend half the prompt on
 * stale chatter", not precise budgeting.
 *
 * Returns null if the agent has no project_id (project-less instances
 * get no auto-context).
 */

import { sql } from "../memory/db.ts";

const FACT_LIMIT = 12;
const MESSAGE_LIMIT = 20;
const CONTEXT_CHAR_BUDGET = 4000;

export interface ProjectContext {
  projectName: string;
  projectPath: string;
  facts: string[];
  recentMessages: Array<{ role: string; content: string; createdAt: Date }>;
}

/**
 * Fetch and format the project context for an agent_instance.
 *
 * Returns null when:
 *  - the agent has no project binding (project_id IS NULL), OR
 *  - the project row has been deleted (orphan instance), OR
 *  - both facts and messages are empty (no value in injection).
 */
export async function buildProjectContext(
  agentInstanceId: number,
): Promise<ProjectContext | null> {
  const projRows = (await sql`
    SELECT p.id, p.name, p.path
    FROM agent_instances ai
    JOIN projects p ON p.id = ai.project_id
    WHERE ai.id = ${agentInstanceId}
    LIMIT 1
  `) as { id: number; name: string; path: string }[];
  if (projRows.length === 0) return null;
  const proj = projRows[0]!;

  // Facts: prefer recent (last-edited wins) since architecture often
  // gets refined over time. Filter to fact + decision types so we
  // skip transient notes / summaries that bloat the prompt.
  const factRows = (await sql`
    SELECT content
    FROM memories
    WHERE project_path = ${proj.path}
      AND type IN ('fact', 'decision')
    ORDER BY updated_at DESC
    LIMIT ${FACT_LIMIT}
  `) as { content: string }[];

  // Recent messages: last N turns from the project's forum topic.
  // Caveat: chat_id / topic linkage isn't surfaced here — we trust
  // project_path partitioning. If the topic spans multiple chats,
  // ordering by created_at DESC still keeps the freshest signal.
  const msgRows = (await sql`
    SELECT role, content, created_at
    FROM messages
    WHERE project_path = ${proj.path}
      AND content IS NOT NULL
      AND length(content) > 0
    ORDER BY created_at DESC
    LIMIT ${MESSAGE_LIMIT}
  `) as { role: string; content: string; created_at: Date }[];

  if (factRows.length === 0 && msgRows.length === 0) return null;

  return {
    projectName: proj.name,
    projectPath: proj.path,
    facts: factRows.map((r) => r.content),
    // Reverse so messages are oldest-first when rendered (natural
    // reading order for the LLM).
    recentMessages: msgRows.reverse().map((r) => ({
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    })),
  };
}

/**
 * Format a `ProjectContext` as a system-message-appendable string.
 *
 * Layout:
 *   ## Project: <name> (<path>)
 *   ### Project facts (<N>):
 *   - fact 1
 *   - fact 2
 *   ...
 *   ### Recent conversation (<N> turns):
 *   <role>: <content>
 *
 * Honors `CONTEXT_CHAR_BUDGET` — facts come first (most useful), then
 * messages truncated as needed. Returns empty string when the budget
 * runs out before any block is rendered.
 */
export function formatProjectContext(ctx: ProjectContext): string {
  const lines: string[] = [];
  lines.push(`## Project: ${ctx.projectName} (${ctx.projectPath})`);

  let used = lines[0]!.length + 2;

  if (ctx.facts.length > 0) {
    const factHeader = `### Project facts (${ctx.facts.length}):`;
    lines.push("", factHeader);
    used += factHeader.length + 2;
    for (const f of ctx.facts) {
      const line = `- ${f}`;
      if (used + line.length + 1 > CONTEXT_CHAR_BUDGET) break;
      lines.push(line);
      used += line.length + 1;
    }
  }

  if (ctx.recentMessages.length > 0 && used < CONTEXT_CHAR_BUDGET - 100) {
    const msgHeader = `### Recent conversation (${ctx.recentMessages.length} turns):`;
    lines.push("", msgHeader);
    used += msgHeader.length + 2;
    for (const m of ctx.recentMessages) {
      // Truncate individual messages so one long monologue doesn't
      // crowd everything else.
      const trimmed = m.content.length > 500 ? m.content.slice(0, 497) + "..." : m.content;
      const line = `${m.role}: ${trimmed}`;
      if (used + line.length + 1 > CONTEXT_CHAR_BUDGET) {
        lines.push("...(remaining messages truncated)");
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }
  }

  return lines.join("\n");
}
