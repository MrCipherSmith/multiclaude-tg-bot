import { describe, test, expect } from "bun:test";

/**
 * Session lifecycle — pure state transition logic tests.
 *
 * These tests do NOT hit a database. They verify the pure rules:
 *   remote session → 'inactive' on disconnect
 *   local session  → 'terminated' on disconnect
 *   terminal states (terminated, inactive-not-remote) cannot go active
 */

type SessionSource = "remote" | "local" | "standalone";
type SessionStatus = "active" | "inactive" | "terminated" | "disconnected";

/**
 * Pure function: determine the next status on disconnect.
 * Extracted from sessions/manager.ts disconnect() logic.
 */
function nextStatusOnDisconnect(source: SessionSource): SessionStatus {
  return source === "remote" ? "inactive" : "terminated";
}

/**
 * Pure function: is a given status transition valid?
 * Rules:
 *   active     → inactive (remote disconnect)
 *   active     → terminated (local disconnect)
 *   inactive   → active (remote reconnect)
 *   terminated → any — NOT allowed (terminal state)
 */
const VALID_STATUS_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  active: ["inactive", "terminated"],
  inactive: ["active"],
  terminated: [],
  disconnected: ["active", "inactive", "terminated"],
};

function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return VALID_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Pure function: build display name. From sessions/manager.ts sessionDisplayName().
 */
function sessionDisplayName(s: {
  id: number;
  project: string | null;
  source: string;
  name: string | null;
  clientId: string;
}): string {
  if (s.id === 0) return "standalone";
  if (s.project) return `${s.project} · ${s.source}`;
  return s.name ?? s.clientId;
}

// --- Tests ---

describe("Session state transitions", () => {
  test("remote session → inactive on disconnect", () => {
    expect(nextStatusOnDisconnect("remote")).toBe("inactive");
  });

  test("local session → terminated on disconnect", () => {
    expect(nextStatusOnDisconnect("local")).toBe("terminated");
  });

  test("standalone session → terminated on disconnect", () => {
    expect(nextStatusOnDisconnect("standalone")).toBe("terminated");
  });

  test("inactive → active is valid (remote reconnect)", () => {
    expect(canTransition("inactive", "active")).toBe(true);
  });

  test("active → inactive is valid", () => {
    expect(canTransition("active", "inactive")).toBe(true);
  });

  test("active → terminated is valid", () => {
    expect(canTransition("active", "terminated")).toBe(true);
  });

  test("terminated → active is NOT valid (terminal state)", () => {
    expect(canTransition("terminated", "active")).toBe(false);
  });

  test("terminated → inactive is NOT valid (terminal state)", () => {
    expect(canTransition("terminated", "inactive")).toBe(false);
  });

  test("terminated → terminated is NOT valid", () => {
    expect(canTransition("terminated", "terminated")).toBe(false);
  });

  test("active → active is NOT valid (no self-loop)", () => {
    expect(canTransition("active", "active")).toBe(false);
  });
});

describe("sessionDisplayName", () => {
  test("id=0 always returns 'standalone'", () => {
    expect(sessionDisplayName({ id: 0, project: "myapp", source: "local", name: "test", clientId: "abc" })).toBe("standalone");
  });

  test("with project returns 'project · source'", () => {
    expect(sessionDisplayName({ id: 1, project: "myapp", source: "remote", name: null, clientId: "xyz" })).toBe("myapp · remote");
  });

  test("without project falls back to name", () => {
    expect(sessionDisplayName({ id: 2, project: null, source: "local", name: "My Session", clientId: "xyz" })).toBe("My Session");
  });

  test("without project or name falls back to clientId", () => {
    expect(sessionDisplayName({ id: 3, project: null, source: "local", name: null, clientId: "cli-abc123" })).toBe("cli-abc123");
  });
});
