import { describe, test, expect } from "bun:test";

/**
 * Permission flow — pure state machine tests.
 *
 * These tests do NOT hit a database. They verify:
 *   - Valid transitions from 'pending' to approved/rejected/expired
 *   - Terminal states (approved/rejected/expired) reject further transitions
 *   - Idempotency guard: duplicate callbacks on already-resolved requests → no-op
 *   - Auto-approve pattern matching logic
 */

type PermissionStatus = "pending" | "approved" | "rejected" | "expired";

const VALID_TRANSITIONS: Record<PermissionStatus, PermissionStatus[]> = {
  pending: ["approved", "rejected", "expired"],
  approved: [],
  rejected: [],
  expired: [],
};

/** Pure: can we transition from `current` to `next`? */
function isValidTransition(current: PermissionStatus, next: PermissionStatus): boolean {
  return VALID_TRANSITIONS[current]?.includes(next) ?? false;
}

/**
 * Pure simulation of the DB-backed transition() method in PermissionService.
 * Returns true if the transition was applied, false if invalid.
 */
function simulateTransition(
  currentStatus: PermissionStatus,
  next: PermissionStatus,
): { applied: boolean; newStatus: PermissionStatus } {
  if (!isValidTransition(currentStatus, next)) {
    return { applied: false, newStatus: currentStatus };
  }
  return { applied: true, newStatus: next };
}

/**
 * Auto-approve pattern matching (from channel/permissions.ts isAutoApproved).
 * Pure function — no I/O.
 */
function isAutoApproved(toolName: string, patterns: Set<string>): boolean {
  if (patterns.has(`${toolName}(*)`)) return true;
  if (patterns.has(toolName)) return true;
  return false;
}

// --- Tests ---

describe("Permission state machine — valid transitions", () => {
  test("pending → approved is valid (allow callback)", () => {
    const { applied, newStatus } = simulateTransition("pending", "approved");
    expect(applied).toBe(true);
    expect(newStatus).toBe("approved");
  });

  test("pending → rejected is valid (deny callback)", () => {
    const { applied, newStatus } = simulateTransition("pending", "rejected");
    expect(applied).toBe(true);
    expect(newStatus).toBe("rejected");
  });

  test("pending → expired is valid (timeout)", () => {
    const { applied, newStatus } = simulateTransition("pending", "expired");
    expect(applied).toBe(true);
    expect(newStatus).toBe("expired");
  });
});

describe("Permission idempotency — duplicate callbacks are no-ops", () => {
  test("approved → approved is rejected (already terminal)", () => {
    const { applied } = simulateTransition("approved", "approved");
    expect(applied).toBe(false);
  });

  test("approved → rejected is rejected (can't change terminal state)", () => {
    const { applied } = simulateTransition("approved", "rejected");
    expect(applied).toBe(false);
  });

  test("rejected → approved is rejected (can't reverse denial)", () => {
    const { applied } = simulateTransition("rejected", "approved");
    expect(applied).toBe(false);
  });

  test("expired → approved is rejected (late callback after timeout)", () => {
    const { applied } = simulateTransition("expired", "approved");
    expect(applied).toBe(false);
  });

  test("expired → rejected is rejected", () => {
    const { applied } = simulateTransition("expired", "rejected");
    expect(applied).toBe(false);
  });

  test("second allow callback on already-approved request leaves status unchanged", () => {
    // Simulate: first callback approves, second callback tries to approve again
    let status: PermissionStatus = "pending";
    const first = simulateTransition(status, "approved");
    status = first.newStatus;

    const second = simulateTransition(status, "approved");
    expect(second.applied).toBe(false);
    expect(second.newStatus).toBe("approved"); // unchanged
  });
});

describe("Auto-approve pattern matching", () => {
  test("exact tool name match", () => {
    const patterns = new Set(["Read", "Glob"]);
    expect(isAutoApproved("Read", patterns)).toBe(true);
    expect(isAutoApproved("Edit", patterns)).toBe(false);
  });

  test("wildcard pattern matches all calls to tool", () => {
    const patterns = new Set(["Bash(*)"]);
    expect(isAutoApproved("Bash", patterns)).toBe(true);
  });

  test("wildcard for one tool does not match another", () => {
    const patterns = new Set(["Read(*)"]);
    expect(isAutoApproved("Edit", patterns)).toBe(false);
  });

  test("empty patterns set approves nothing", () => {
    const patterns = new Set<string>();
    expect(isAutoApproved("Read", patterns)).toBe(false);
    expect(isAutoApproved("Bash", patterns)).toBe(false);
  });

  test("mixed patterns: exact and wildcard", () => {
    const patterns = new Set(["Read", "Bash(*)"]);
    expect(isAutoApproved("Read", patterns)).toBe(true);
    expect(isAutoApproved("Bash", patterns)).toBe(true);
    expect(isAutoApproved("Edit", patterns)).toBe(false);
  });
});
