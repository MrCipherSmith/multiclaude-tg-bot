import { resolve } from "node:path";
import { sql } from "../memory/db.ts";
import { callAuxLlm } from "./aux-llm-client.ts";
import { sendCuratorApprovalMessage } from "./skill-approval.ts";

const AUTO_ARCHIVE_DAYS = parseInt(process.env.HELYX_CURATOR_ARCHIVE_DAYS ?? "90");
// PRD FR-B-8 says "use_count > 10". TODO: reconcile with PRD whether the intent
// is "more than 10" (>) or "10 or more" (>=); current code matches the PRD
// wording and the curation prompt verbatim.
const AUTO_PIN_USE_COUNT = parseInt(process.env.HELYX_CURATOR_PIN_USE_COUNT ?? "10");
const AUTO_PIN_DAYS = 14;

export interface CuratorRun {
  id: number;
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number;
  status: string;
  skillsExamined: number;
  skillsPinned: number;
  skillsArchived: number;
  skillsProposedConsolidate: number;
  skillsProposedPatch: number;
  auxLlmCostUsd?: number;
  errorMessage?: string;
  summary?: string;
}

let cachedCurationPrompt: string | undefined;
async function getCurationPrompt(): Promise<string> {
  if (cachedCurationPrompt !== undefined) return cachedCurationPrompt;
  const path = resolve(import.meta.dir, "../prompts/skill-curation.md");
  cachedCurationPrompt = await Bun.file(path).text();
  return cachedCurationPrompt;
}

// Strip code fences DeepSeek likes to wrap JSON in. Returns the raw payload
// when no fence is present.
function stripJsonFences(content: string): string {
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1]!.trim();
  return content.trim();
}

function getSupervisorChatId(): string | undefined {
  return process.env.SUPERVISOR_CHAT_ID;
}

function getSupervisorTopicId(): number | undefined {
  const v = process.env.SUPERVISOR_TOPIC_ID;
  return v ? parseInt(v, 10) || undefined : undefined;
}

// FR-B-6: queue consolidate/patch for human approval. Writes to
// curator_pending_actions and emits a Telegram message; rows expire 24h after
// creation (cleanup happens at read time via getPendingCuratorActions).
async function queuePendingAction(
  skillName: string,
  action: string,
  reason: string,
  runId: number,
): Promise<void> {
  const chatId = getSupervisorChatId();
  try {
    const [row] = await sql`
      INSERT INTO curator_pending_actions (run_id, skill_name, action, reason, status, telegram_chat_id, created_at)
      VALUES (${runId}, ${skillName}, ${action}, ${reason}, 'pending', ${chatId ?? null}, now())
      RETURNING id
    `;
    if (!chatId) return; // No supervisor configured — row stays in DB, action is auditable but not actioned.

    const tg = await sendCuratorApprovalMessage({
      actionId: Number(row.id),
      skillName,
      action,
      reason,
      chatId,
      topicId: getSupervisorTopicId(),
    });
    if (tg.ok && tg.messageId !== null) {
      await sql`UPDATE curator_pending_actions SET telegram_message_id = ${tg.messageId} WHERE id = ${row.id}`;
    }
  } catch (err) {
    console.warn("[curator] queue pending action failed:", err);
  }
}

export async function runCurator(): Promise<CuratorRun> {
  const startTime = Date.now();

  const runRow = await sql`
    INSERT INTO curator_runs (status, skills_examined)
    VALUES ('running', 0)
    RETURNING id
  `;
  const runId = runRow[0]!.id;
  const startedAt = new Date();

  try {
    if (process.env.HELYX_CURATOR_PAUSED === "true") {
      await sql`UPDATE curator_runs SET status = 'skipped', finished_at = now(), summary = 'CURATOR_PAUSED=true' WHERE id = ${runId}`;
      return {
        id: runId,
        startedAt,
        status: "skipped",
        skillsExamined: 0,
        skillsPinned: 0,
        skillsArchived: 0,
        skillsProposedConsolidate: 0,
        skillsProposedPatch: 0,
      };
    }

    const candidates = await sql`
      SELECT name, description, use_count, last_used_at, pinned
      FROM agent_created_skills
      WHERE status = 'active' AND pinned = false
      ORDER BY last_used_at DESC NULLS LAST
      LIMIT 200
    `;

    if (candidates.length === 0) {
      const durationMs = Date.now() - startTime;
      await sql`UPDATE curator_runs SET status = 'success', finished_at = now(), duration_ms = ${durationMs}, skills_examined = 0, summary = 'No active skills to examine' WHERE id = ${runId}`;
      return {
        id: runId,
        startedAt,
        finishedAt: new Date(),
        durationMs,
        status: "success",
        skillsExamined: 0,
        skillsPinned: 0,
        skillsArchived: 0,
        skillsProposedConsolidate: 0,
        skillsProposedPatch: 0,
        summary: "No active skills to examine",
      };
    }

    const metaTable = candidates
      .map((c) => `${c.name} | ${c.description} | use_count=${c.use_count ?? 0} | last_used_at=${c.last_used_at ?? "never"}`)
      .join("\n");

    const systemPrompt = await getCurationPrompt();
    const llmResult = await callAuxLlm(systemPrompt, `Skills:\n${metaTable}`, "skill_curation");

    let actions: Array<{ name: string; action: string; reason: string }> = [];
    let auxLlmCost = 0;
    let parseError: string | undefined;

    if (!("content" in llmResult)) {
      parseError = llmResult.error;
    } else {
      auxLlmCost = llmResult.costUsd;
      try {
        const cleaned = stripJsonFences(llmResult.content);
        const parsed = JSON.parse(cleaned);
        actions = Array.isArray(parsed.actions) ? parsed.actions : [];
      } catch (err) {
        parseError = `failed to parse LLM response: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    let skillsPinned = 0;
    let skillsArchived = 0;
    let skillsProposedConsolidate = 0;
    let skillsProposedPatch = 0;

    const now = new Date();

    for (const action of actions) {
      const skill = candidates.find((c) => c.name === action.name);
      if (!skill) continue;

      const lastUsed = skill.last_used_at ? new Date(skill.last_used_at) : null;
      const daysSince = lastUsed
        ? Math.floor((now.getTime() - lastUsed.getTime()) / (1000 * 60 * 60 * 24))
        : 999;

      if (
        action.action === "pin" &&
        skill.use_count! > AUTO_PIN_USE_COUNT &&
        daysSince <= AUTO_PIN_DAYS
      ) {
        await sql`UPDATE agent_created_skills SET pinned = true WHERE name = ${action.name}`;
        skillsPinned++;
      } else if (action.action === "archive" && daysSince > AUTO_ARCHIVE_DAYS) {
        await sql`UPDATE agent_created_skills SET status = 'archived', archived_at = now() WHERE name = ${action.name}`;
        skillsArchived++;
      } else if (action.action.startsWith("consolidate_with:")) {
        await queuePendingAction(action.name, action.action, action.reason, runId);
        skillsProposedConsolidate++;
      } else if (action.action.startsWith("patch:") || action.action === "patch") {
        await queuePendingAction(action.name, action.action, action.reason, runId);
        skillsProposedPatch++;
      }
    }

    const durationMs = Date.now() - startTime;
    // Status: 'success' on clean run, 'partial' when LLM response failed to parse
    // (auto-actions still applied for any actions that were extracted).
    const status: "success" | "partial" = parseError ? "partial" : "success";
    const summary = parseError
      ? `examined=${candidates.length} pinned=${skillsPinned} archived=${skillsArchived} consolidate=${skillsProposedConsolidate} patch=${skillsProposedPatch} parse_error=${parseError}`
      : `examined=${candidates.length} pinned=${skillsPinned} archived=${skillsArchived} consolidate=${skillsProposedConsolidate} patch=${skillsProposedPatch}`;

    await sql`
      UPDATE curator_runs SET
        status = ${status},
        finished_at = now(),
        duration_ms = ${durationMs},
        skills_examined = ${candidates.length},
        skills_pinned = ${skillsPinned},
        skills_archived = ${skillsArchived},
        skills_proposed_consolidate = ${skillsProposedConsolidate},
        skills_proposed_patch = ${skillsProposedPatch},
        aux_llm_cost_usd = ${auxLlmCost},
        error_message = ${parseError ?? null},
        summary = ${summary}
      WHERE id = ${runId}
    `;

    return {
      id: runId,
      startedAt,
      finishedAt: new Date(),
      durationMs,
      status,
      skillsExamined: candidates.length,
      skillsPinned,
      skillsArchived,
      skillsProposedConsolidate,
      skillsProposedPatch,
      auxLlmCostUsd: auxLlmCost,
      errorMessage: parseError,
      summary,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    await sql`UPDATE curator_runs SET status = 'error', finished_at = now(), duration_ms = ${durationMs}, error_message = ${errorMsg} WHERE id = ${runId}`;
    return {
      id: runId,
      startedAt,
      durationMs,
      status: "error",
      skillsExamined: 0,
      skillsPinned: 0,
      skillsArchived: 0,
      skillsProposedConsolidate: 0,
      skillsProposedPatch: 0,
      errorMessage: errorMsg,
    };
  }
}

export async function getCuratorRuns(limit = 10) {
  return sql`
    SELECT * FROM curator_runs
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
}

export async function getLastCuratorRun(): Promise<{ started_at: Date } | null> {
  const rows = await sql`SELECT started_at FROM curator_runs ORDER BY started_at DESC LIMIT 1`;
  return rows.length > 0 ? (rows[0] as { started_at: Date }) : null;
}

export async function getPendingCuratorActions() {
  return sql`
    SELECT id, run_id, skill_name, action, reason, created_at
    FROM curator_pending_actions
    WHERE status = 'pending' AND created_at > now() - interval '24 hours'
    ORDER BY created_at DESC
  `;
}
