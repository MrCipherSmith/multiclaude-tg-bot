import { ALL_JOBS } from "./jobs.ts";
import { sessionManager } from "../sessions/manager.ts";

export async function runCleanup(dryRun = false, skipMarkStale = false): Promise<void> {
  const prefix = dryRun ? "[cleanup:dry-run]" : "[cleanup]";

  // Mark stale sessions (unless skipped at startup to allow clients to reconnect)
  if (!skipMarkStale && !dryRun) {
    const stale = await sessionManager.markStale(600);
    if (stale > 0) console.log(`${prefix} stale-sessions rowsAffected=${stale}`);
  }

  for (const job of ALL_JOBS) {
    const start = Date.now();
    try {
      const { rowsAffected } = await job.run(dryRun);
      const durationMs = Date.now() - start;
      if (rowsAffected > 0 || dryRun) {
        console.log(`${prefix} job=${job.name} rowsAffected=${rowsAffected} durationMs=${durationMs}`);
      }
    } catch (err) {
      console.error(`${prefix} job=${job.name} error:`, err);
    }
  }

  // Reset sequence to keep IDs compact (non-destructive, always run)
  if (!dryRun) {
    await sessionManager.resetSequence();
  }
}
