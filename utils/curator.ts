import { sql } from "../memory/db.ts";
import { callAuxLlm } from "./aux-llm-client.ts";

const AUTO_ARCHIVE_DAYS = parseInt(process.env.HELYX_CURATOR_ARCHIVE_DAYS ?? "90");
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

const CURATOR_PROMPT = `You are skill-curation aux. Given a list of agent-created skills with metadata,
propose lifecycle actions per skill. Allowed actions: pin, archive,
consolidate_with:<target_name>, patch:<diff>, no_action.

Auto-applied: pin (high use, recent) and archive (stale).
Confirmation-required: consolidate (merging) and patch (body edit).

Constraints:
- Never propose archive for skills used within 90 days
- Propose pin only if use_count > 10 AND last_used_at within 14 days
- Propose consolidate_with only when names + descriptions show >70% overlap
- Propose patch only for clearly improvable bodies
- When in doubt, choose no_action

Output JSON: { actions: [{ name, action, reason }] }`;

export async function runCurator(): Promise<CuratorRun> {
  const startTime = Date.now();

  const runRow = await sql`
    INSERT INTO curator_runs (status, skills_examined)
    VALUES ('running', 0)
    RETURNING id
  `;
  const runId = runRow[0]!.id;

  try {
    // Pause check
    if (process.env.HELYX_CURATOR_PAUSED === "true") {
      await sql`UPDATE curator_runs SET status = 'skipped', finished_at = now(), summary = 'CURATOR_PAUSED=true' WHERE id = ${runId}`;
      return { id: runId, startedAt: new Date(), status: "skipped", skillsExamined: 0, skillsPinned: 0, skillsArchived: 0, skillsProposedConsolidate: 0, skillsProposedPatch: 0 };
    }

    // Select candidate skills
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
      return { id: runId, startedAt: new Date(), finishedAt: new Date(), durationMs, status: "success", skillsExamined: 0, skillsPinned: 0, skillsArchived: 0, skillsProposedConsolidate: 0, skillsProposedPatch: 0 };
    }

    // Build metadata table
    const metaTable = candidates.map((c) => `${c.name} | ${c.description} | use_count=${c.use_count ?? 0} | last_used_at=${c.last_used_at ?? "never"}`).join("\n");

    // Call aux-LLM
    const llmResult = await callAuxLlm(CURATOR_PROMPT, `Skills:\n${metaTable}`, "skill_curation");

    let actions: Array<{ name: string; action: string; reason: string }> = [];
    let parseError: string | undefined;

    if (!("content" in llmResult)) {
      parseError = llmResult.error;
    } else {
      try {
        const parsed = JSON.parse(llmResult.content);
        actions = parsed.actions ?? [];
      } catch {
        parseError = "failed to parse LLM response";
      }
    }

    // Apply auto-actions: pin, archive
    let skillsPinned = 0;
    let skillsArchived = 0;
    let skillsProposedConsolidate = 0;
    let skillsProposedPatch = 0;

    const now = new Date();

    for (const action of actions) {
      const skill = candidates.find((c) => c.name === action.name);
      if (!skill) continue;

      const lastUsed = skill.last_used_at ? new Date(skill.last_used_at) : null;
      const daysSince = lastUsed ? Math.floor((now.getTime() - lastUsed.getTime()) / (1000 * 60 * 60 * 24)) : 999;

      if (action.action === "pin" && skill.use_count! > AUTO_PIN_USE_COUNT && daysSince <= AUTO_PIN_DAYS) {
        await sql`UPDATE agent_created_skills SET pinned = true WHERE name = ${action.name}`;
        skillsPinned++;
      } else if (action.action === "archive" && daysSince > AUTO_ARCHIVE_DAYS) {
        await sql`UPDATE agent_created_skills SET status = 'archived', archived_at = now() WHERE name = ${action.name}`;
        skillsArchived++;
      } else if (action.action.startsWith("consolidate_with:")) {
        skillsProposedConsolidate++;
      } else if (action.action.startsWith("patch:")) {
        skillsProposedPatch++;
      }
    }

    const durationMs = Date.now() - startTime;
    const auxLlmCost = "content" in llmResult ? (llmResult as any).costUsd ?? 0.01 : 0;
    const summary = `examined=${candidates.length}, pinned=${skillsPinned}, archived=${skillsArchived}, consolidate=${skillsProposedConsolidate}, patch=${skillsProposedPatch}`;

    await sql`
      UPDATE curator_runs SET
        status = 'success',
        finished_at = now(),
        duration_ms = ${durationMs},
        skills_examined = ${candidates.length},
        skills_pinned = ${skillsPinned},
        skills_archived = ${skillsArchived},
        skills_proposed_consolidate = ${skillsProposedConsolidate},
        skills_proposed_patch = ${skillsProposedPatch},
        aux_llm_cost_usd = ${auxLlmCost},
        summary = ${summary}
      WHERE id = ${runId}
    `;

    return {
      id: runId,
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs,
      status: "success",
      skillsExamined: candidates.length,
      skillsPinned,
      skillsArchived,
      skillsProposedConsolidate: skillsProposedConsolidate,
      skillsProposedPatch: skillsProposedPatch,
      auxLlmCostUsd: auxLlmCost,
      summary,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    await sql`UPDATE curator_runs SET status = 'error', finished_at = now(), duration_ms = ${durationMs}, error_message = ${errorMsg} WHERE id = ${runId}`;
    return { id: runId, startedAt: new Date(), durationMs, status: "error", skillsExamined: 0, skillsPinned: 0, skillsArchived: 0, skillsProposedConsolidate: 0, skillsProposedPatch: 0, errorMessage: errorMsg };
  }
}

export async function getCuratorRuns(limit = 10) {
  return sql`
    SELECT * FROM curator_runs
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
}