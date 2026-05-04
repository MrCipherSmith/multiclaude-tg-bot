import type postgres from "postgres";
import { buildCorrectionPrompt, loadStateMatrix, validateMatrixArtifact } from "./matrix.ts";
import { enqueueCorrection, getOrCreateRun, markRunStatus, recordValidationFailure } from "./store.ts";

export type ReplyGateResult =
  | { kind: "allow"; mode: "disabled" | "valid" | "warn" }
  | { kind: "config_error"; message: string }
  | { kind: "blocked"; correction: string; attempt: number; maxAttempts: number }
  | { kind: "exhausted"; attempt: number; maxAttempts: number };

export async function validateReplyGate(params: {
  sql: postgres.Sql;
  sessionId: number | null;
  chatId: string;
  projectPath: string | null | undefined;
  text: string;
}): Promise<ReplyGateResult> {
  if (!params.projectPath) return { kind: "allow", mode: "disabled" };

  let matrix;
  try {
    matrix = await loadStateMatrix(params.projectPath);
  } catch (err: any) {
    return {
      kind: "config_error",
      message: err?.message ?? "State Matrix configuration is invalid",
    };
  }

  if (!matrix || matrix.mode === "disabled") return { kind: "allow", mode: "disabled" };

  const validation = validateMatrixArtifact({
    type: "reply",
    text: params.text,
    sessionId: params.sessionId,
    chatId: params.chatId,
    projectPath: params.projectPath,
  }, matrix);

  const run = await getOrCreateRun({
    sql: params.sql,
    sessionId: params.sessionId,
    chatId: params.chatId,
    projectPath: params.projectPath,
    artifactType: "reply",
    matrix,
  });

  // H3: DB unavailable (sessionId present but run is null) — fail open to avoid infinite block
  if (run === null && params.sessionId !== null) {
    return { kind: "allow", mode: "valid" };
  }

  if (!validation.isValid && matrix.mode === "warn") {
    // H4: log warn violations unconditionally regardless of DB availability
    console.warn("[state-matrix] reply warn-mode violations:", JSON.stringify(validation.violations));
    await markRunStatus({ sql: params.sql, run, status: "valid", phase: "warn" });
    return { kind: "allow", mode: "warn" };
  }

  if (validation.isValid) {
    await markRunStatus({ sql: params.sql, run, status: "valid", phase: "reply_valid" });
    return { kind: "allow", mode: "valid" };
  }

  const failedRun = await recordValidationFailure({ sql: params.sql, run, validation });
  const attempt = failedRun?.attempt ?? 1;
  const maxAttempts = failedRun?.maxAttempts ?? matrix.maxCorrectionAttempts;

  // C2: use > not >= so maxCorrectionAttempts=N means N correction attempts before exhaustion
  if (attempt > maxAttempts) {
    await markRunStatus({ sql: params.sql, run: failedRun, status: "failed", phase: "exhausted" });
    return { kind: "exhausted", attempt, maxAttempts };
  }

  const correction = buildCorrectionPrompt({
    validation,
    attempt,
    maxAttempts,
    artifactType: "reply",
  });

  // C3: enqueue correction as a system message so Claude receives it in proper turn order
  await enqueueCorrection({
    sql: params.sql,
    sessionId: params.sessionId,
    chatId: params.chatId,
    content: correction,
    run: failedRun,
  });

  return { kind: "blocked", attempt, maxAttempts, correction };
}

