import { sql } from "../memory/db.ts";

export type PermissionStatus = "pending" | "approved" | "rejected" | "expired";

const VALID_TRANSITIONS: Record<PermissionStatus, PermissionStatus[]> = {
  pending: ["approved", "rejected", "expired"],
  approved: [],
  rejected: [],
  expired: [],
};

export class PermissionService {
  /**
   * Transition a permission request to a new status.
   * Idempotent: already-terminal states are silently ignored.
   * Returns true if the transition was applied, false if the request
   * doesn't exist or the transition is invalid.
   */
  async transition(id: string, next: PermissionStatus): Promise<boolean> {
    const rows = await sql`SELECT status FROM permission_requests WHERE id = ${id}`;
    if (!rows[0]) return false;
    const current = rows[0].status as PermissionStatus;
    if (!VALID_TRANSITIONS[current]?.includes(next)) return false;
    await sql`UPDATE permission_requests SET status = ${next} WHERE id = ${id}`;
    return true;
  }

  /**
   * On startup, expire any pending requests older than timeoutMs that
   * were left pending by a previous process that crashed mid-timeout.
   */
  async expireStale(timeoutMs: number): Promise<number> {
    const result = await sql`
      UPDATE permission_requests
      SET status = 'expired'
      WHERE status = 'pending'
        AND created_at < NOW() - make_interval(secs => ${timeoutMs / 1000})
      RETURNING id
    `;
    return result.length;
  }
}

export const permissionService = new PermissionService();
