import type postgres from "postgres";
import type { MatrixArtifact, MatrixValidationResult, StateMatrix } from "./matrix.ts";

export type OrchestrationStatus = "validating" | "correcting" | "waiting_permission" | "valid" | "failed";

export interface OrchestrationRun {
  id: number;
  attempt: number;
  maxAttempts: number;
}

export async function getOrCreateRun(params: {
  sql: postgres.Sql;
  sessionId: number | null;
  chatId: string;
  projectPath: string;
  artifactType: MatrixArtifact["type"];
  matrix: StateMatrix;
}): Promise<OrchestrationRun | null> {
  if (params.sessionId === null) return null;

  const existing = await params.sql`
    SELECT id, attempt, max_attempts
    FROM orchestration_runs
    WHERE session_id = ${params.sessionId}
      AND chat_id = ${params.chatId}
      AND project_path = ${params.projectPath}
      AND artifact_type = ${params.artifactType}
      AND status IN ('validating', 'correcting', 'waiting_permission')
    ORDER BY updated_at DESC
    LIMIT 1
  `.catch(() => []);

  if (existing.length > 0) {
    const row = existing[0] as any;
    return {
      id: Number(row.id),
      attempt: Number(row.attempt),
      maxAttempts: Number(row.max_attempts),
    };
  }

  const inserted = await params.sql`
    INSERT INTO orchestration_runs
      (session_id, chat_id, project_path, artifact_type, matrix_hash, status, phase, attempt, max_attempts)
    VALUES
      (${params.sessionId}, ${params.chatId}, ${params.projectPath}, ${params.artifactType}, ${params.matrix.hash},
       'validating', 'validating', 0, ${params.matrix.maxCorrectionAttempts})
    RETURNING id, attempt, max_attempts
  `.catch(() => []);

  if (inserted.length === 0) return null;
  const row = inserted[0] as any;
  return {
    id: Number(row.id),
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
  };
}

export async function recordValidationFailure(params: {
  sql: postgres.Sql;
  run: OrchestrationRun | null;
  validation: MatrixValidationResult;
}): Promise<OrchestrationRun | null> {
  if (!params.run) return null;

  const nextAttempt = params.run.attempt + 1;
  await params.sql`
    UPDATE orchestration_runs
    SET attempt = ${nextAttempt},
        status = 'correcting',
        phase = 'correcting',
        updated_at = now()
    WHERE id = ${params.run.id}
  `.catch(() => {});

  for (const violation of params.validation.violations) {
    await params.sql`
      INSERT INTO matrix_violations
        (run_id, attempt, code, message, severity, rule)
      VALUES
        (${params.run.id}, ${nextAttempt}, ${violation.code}, ${violation.message}, ${violation.severity}, ${violation.rule ?? null})
    `.catch(() => {});
  }

  return {
    ...params.run,
    attempt: nextAttempt,
  };
}

export async function markRunStatus(params: {
  sql: postgres.Sql;
  run: OrchestrationRun | null;
  status: OrchestrationStatus;
  phase?: string;
}): Promise<void> {
  if (!params.run) return;
  await params.sql`
    UPDATE orchestration_runs
    SET status = ${params.status},
        phase = ${params.phase ?? params.status},
        completed_at = CASE WHEN ${params.status} IN ('valid', 'failed') THEN now() ELSE completed_at END,
        updated_at = now()
    WHERE id = ${params.run.id}
  `.catch(() => {});
}

export async function enqueueCorrection(params: {
  sql: postgres.Sql;
  sessionId: number | null;
  chatId: string;
  content: string;
  run: OrchestrationRun | null;
}): Promise<void> {
  if (params.sessionId === null) return;
  const messageId = params.run ? `matrix:${params.run.id}:${params.run.attempt}` : `matrix:${Date.now()}`;
  await params.sql`
    INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
    VALUES (${params.sessionId}, ${params.chatId}, 'helyx-orchestrator', ${params.content}, ${messageId})
    ON CONFLICT (chat_id, message_id)
      WHERE message_id IS NOT NULL AND message_id != '' AND message_id != 'tool'
    DO NOTHING
  `.catch(() => {});
}

