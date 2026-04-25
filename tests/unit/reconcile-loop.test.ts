/**
 * Unit tests for `RuntimeManager.reconcileInstance` — the core reconciliation
 * step that converges agent_instance.actual_state to desired_state.
 *
 * Strategy:
 *   - Inject a fully mocked `RuntimeDriver` (start/stop/health/snapshot/sendInput).
 *   - Inject a fully mocked `AgentManager` (every method returns a Promise stub).
 *   - Call `reconcileInstance` directly via a `(mgr as any)` cast so we can
 *     observe single-tick behaviour without setInterval timing flakiness.
 *
 * The cast is deliberate: `reconcileInstance` is private to keep the public
 * surface small, but for unit testing the reconciliation rules we want
 * deterministic single-step assertions, not a `setInterval`-driven race.
 *
 * `startReconcileLoop` itself is exercised indirectly via the no-op return
 * path test at the bottom of this file.
 */
import { describe, test, expect, mock } from "bun:test";
import { RuntimeManager } from "../../runtime/runtime-manager.ts";
import type { RuntimeDriver, RuntimeHandle } from "../../runtime/types.ts";
import type { AgentInstance } from "../../agents/agent-manager.ts";

// ---------- Mock helpers ----------

function makeMockDriver(overrides?: Partial<RuntimeDriver>): RuntimeDriver {
  return {
    name: "tmux",
    start: mock(async (h: RuntimeHandle) => h),
    stop: mock(async () => {}),
    sendInput: mock(async () => {}),
    health: mock(async () => ({
      state: "running" as const,
      lastChecked: new Date(),
    })),
    snapshot: mock(async (h: RuntimeHandle) => ({
      lines: [],
      capturedAt: new Date(),
      handle: h,
    })),
    ...overrides,
  };
}

function makeMockAgentMgr() {
  return {
    listInstances: mock(async () => [] as AgentInstance[]),
    setActualState: mock(async () => {}),
    setDesiredState: mock(async () => makeInstance()),
    updateRuntimeHandle: mock(async () => {}),
    incrementRestartCount: mock(async () => {}),
    logEvent: mock(async () => {}),
    updateSnapshot: mock(async () => {}),
    linkSession: mock(async () => {}),
    getInstance: mock(async () => null),
    getInstanceByName: mock(async () => null),
    listDefinitions: mock(async () => []),
    getDefinition: mock(async () => null),
    getDefinitionByName: mock(async () => null),
    createInstance: mock(async () => makeInstance()),
  } as any;
}

function makeInstance(overrides: Partial<AgentInstance> = {}): AgentInstance {
  return {
    id: 1,
    definitionId: 1,
    projectId: 1,
    name: "test-agent",
    desiredState: "stopped",
    actualState: "new",
    runtimeHandle: {
      driver: "tmux",
      tmuxSession: "bots",
      tmuxWindow: "test",
    },
    lastSnapshot: null,
    lastSnapshotAt: null,
    lastHealthAt: null,
    restartCount: 0,
    lastRestartAt: null,
    sessionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------- Health helpers ----------

const stoppedHealth = mock(async () => ({
  state: "stopped" as const,
  lastChecked: new Date(),
}));

function makeStoppedDriver(overrides?: Partial<RuntimeDriver>): RuntimeDriver {
  return makeMockDriver({
    health: mock(async () => ({
      state: "stopped" as const,
      lastChecked: new Date(),
    })),
    ...overrides,
  });
}

// ---------- Tests: desired=stopped ----------

describe("reconcile-loop: desired=stopped", () => {
  test("does nothing when actual=stopped and health=stopped (terminal converged state)", async () => {
    const driver = makeStoppedDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "stopped",
      actualState: "stopped",
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.stop).not.toHaveBeenCalled();
    expect(driver.start).not.toHaveBeenCalled();
    expect(agentMgr.setActualState).not.toHaveBeenCalled();
  });

  test("does nothing when actual=new and desired=stopped and health=stopped", async () => {
    const driver = makeStoppedDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "stopped",
      actualState: "new",
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.stop).not.toHaveBeenCalled();
    expect(driver.start).not.toHaveBeenCalled();
  });

  test("no-op when desired=stopped and health=stopped (actual=stopped)", async () => {
    const driver = makeStoppedDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "stopped",
      actualState: "stopped",
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.stop).not.toHaveBeenCalled();
    expect(driver.start).not.toHaveBeenCalled();
    expect(agentMgr.setActualState).not.toHaveBeenCalled();
  });

  test("stops when desired=stopped and health=running (actual=running)", async () => {
    const driver = makeMockDriver(); // default health=running
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "stopped",
      actualState: "running",
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.stop).toHaveBeenCalled();
    // Should transition stopping -> stopped
    expect(agentMgr.setActualState).toHaveBeenCalled();
    const calls = (agentMgr.setActualState as any).mock.calls;
    const states = calls.map((c: any[]) => c[1]);
    expect(states).toContain("stopping");
    expect(states).toContain("stopped");
  });

  test("calls driver.stop when health=running and actual=starting", async () => {
    const driver = makeMockDriver(); // default health=running
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "stopped",
      actualState: "starting",
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.stop).toHaveBeenCalled();
  });

  test("marks failed when driver.stop throws", async () => {
    const driver = makeMockDriver({
      stop: mock(async () => {
        throw new Error("kaboom");
      }),
    });
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "stopped",
      actualState: "running",
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    const calls = (agentMgr.setActualState as any).mock.calls;
    const sawFailed = calls.some((c: any[]) => c[1] === "failed");
    expect(sawFailed).toBe(true);
  });
});

// ---------- Tests: desired=running ----------

describe("reconcile-loop: desired=running", () => {
  test("normalizes actualState to running when health=running and runtime_handle lacks projectPath", async () => {
    // Health-first semantics: probe runs BEFORE deciding to start.
    // Even if projectPath/projectName are missing, a healthy probe means the
    // window already exists — we just sync actualState to reflect reality.
    const driver = makeMockDriver(); // default health=running
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "new",
      runtimeHandle: {
        driver: "tmux",
        tmuxSession: "bots",
        tmuxWindow: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.health).toHaveBeenCalled();
    expect(driver.start).not.toHaveBeenCalled();
    const calls = (agentMgr.setActualState as any).mock.calls;
    const states = calls.map((c: any[]) => c[1]);
    expect(states).toContain("running");
  });

  test("starts when health=stopped and handle has projectPath", async () => {
    const driver = makeStoppedDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "stopped", // post-first-observation
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
        tmuxSession: "bots",
        tmuxWindow: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.start).toHaveBeenCalled();
    expect(agentMgr.updateRuntimeHandle).toHaveBeenCalled();
    expect(agentMgr.logEvent).toHaveBeenCalled();
  });

  test("first-observation grace period: actual=new only records, no driver action", async () => {
    const driver = makeStoppedDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "new", // first observation
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    // No driver action on first observation — just records observed state
    expect(driver.start).not.toHaveBeenCalled();
    expect(driver.stop).not.toHaveBeenCalled();
    // Should have set actual_state to 'stopped' (matching health probe)
    const calls = (agentMgr.setActualState as any).mock.calls;
    const states = calls.map((c: any[]) => c[1]);
    expect(states).toContain("stopped");
  });

  test("first-observation grace period: actual=new + desired=stopped + health=running does NOT call stop", async () => {
    // Critical regression test: bootstrapped instances with desired=stopped
    // but live tmux windows must NOT be killed on first reconcile tick.
    const driver = makeMockDriver(); // health returns 'running' by default
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "stopped",
      actualState: "new",
      runtimeHandle: { driver: "tmux", tmuxSession: "bots", tmuxWindow: "test" },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.stop).not.toHaveBeenCalled();
    expect(driver.start).not.toHaveBeenCalled();
    // Should have just recorded observed state
    const calls = (agentMgr.setActualState as any).mock.calls;
    const states = calls.map((c: any[]) => c[1]);
    expect(states).toContain("running");
  });

  test("calls driver.start when actual=stopped and health=stopped (cold restart)", async () => {
    const driver = makeStoppedDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "stopped",
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.start).toHaveBeenCalled();
  });

  test("respects restart limit when actual=failed and restartCount >= limit", async () => {
    const driver = makeStoppedDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "failed",
      restartCount: 5,
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.start).not.toHaveBeenCalled();
    expect(agentMgr.setActualState).not.toHaveBeenCalled();
  });

  test("retries start when actual=failed, health=stopped, and restartCount < limit", async () => {
    const driver = makeStoppedDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "failed",
      restartCount: 1,
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.start).toHaveBeenCalled();
  });

  test("increments restart count when driver.start throws", async () => {
    const driver = makeStoppedDriver({
      start: mock(async () => {
        throw new Error("start failure");
      }),
    });
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "stopped", // post-first-observation
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(agentMgr.incrementRestartCount).toHaveBeenCalled();
    const calls = (agentMgr.setActualState as any).mock.calls;
    const sawFailed = calls.some((c: any[]) => c[1] === "failed");
    expect(sawFailed).toBe(true);
  });

  test("probes health when actual=running", async () => {
    const driver = makeMockDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "running",
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.health).toHaveBeenCalled();
    expect(driver.start).not.toHaveBeenCalled();
  });

  test("probes health when actual=starting and promotes to running on success", async () => {
    const driver = makeMockDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "starting",
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.health).toHaveBeenCalled();
    const calls = (agentMgr.setActualState as any).mock.calls;
    const states = calls.map((c: any[]) => c[1]);
    expect(states).toContain("running");
  });

  test("starts (does not increment restart) when health=stopped under restart limit", async () => {
    // Health-first: when desired=running and health=stopped, we simply (re)start.
    // The previous "mark stopped + increment restart count" semantics are gone —
    // the start path itself handles failures via try/catch.
    const driver = makeStoppedDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "running",
      restartCount: 1,
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.start).toHaveBeenCalled();
    // Successful start does NOT increment restart count.
    expect(agentMgr.incrementRestartCount).not.toHaveBeenCalled();
    const calls = (agentMgr.setActualState as any).mock.calls;
    const states = calls.map((c: any[]) => c[1]);
    expect(states).toContain("starting");
  });

  test("respects restart limit only when actualState=failed (otherwise still attempts start)", async () => {
    // Under new semantics, the budget check is `restartCount >= limit && actualState === "failed"`.
    // If actualState is e.g. "running" but health says stopped, we still attempt to start.
    const driver = makeStoppedDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "running",
      restartCount: 5,
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    // Start IS attempted (actualState !== 'failed', so budget check doesn't gate it).
    expect(driver.start).toHaveBeenCalled();
  });

  test("ignores health=unknown (leaves state alone, no transitions)", async () => {
    const driver = makeMockDriver({
      health: mock(async () => ({
        state: "unknown" as const,
        lastChecked: new Date(),
      })),
    });
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "running",
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.health).toHaveBeenCalled();
    expect(agentMgr.setActualState).not.toHaveBeenCalled();
    expect(agentMgr.incrementRestartCount).not.toHaveBeenCalled();
  });

  test("swallows health probe errors and treats as unknown (no transitions)", async () => {
    const driver = makeMockDriver({
      health: mock(async () => {
        throw new Error("probe failed");
      }),
    });
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "running",
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    // Should NOT throw — reconciler swallows probe errors
    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.health).toHaveBeenCalled();
    // Probe error → healthState=unknown → no state transitions, no start, no stop.
    expect(driver.start).not.toHaveBeenCalled();
    expect(driver.stop).not.toHaveBeenCalled();
  });
});

// ---------- Tests: desired=paused ----------

describe("reconcile-loop: desired=paused", () => {
  test("is a no-op for forward compatibility", async () => {
    const driver = makeMockDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "paused",
      actualState: "running",
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.start).not.toHaveBeenCalled();
    expect(driver.stop).not.toHaveBeenCalled();
    expect(driver.health).not.toHaveBeenCalled();
    expect(agentMgr.setActualState).not.toHaveBeenCalled();
  });
});

// ---------- Tests: driver missing ----------

describe("reconcile-loop: driver not registered", () => {
  test("skips silently when driver missing (other process owns it)", async () => {
    const mgr = new RuntimeManager();
    // No driver registered
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "new",
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    // Nothing should have happened
    expect(agentMgr.setActualState).not.toHaveBeenCalled();
    expect(agentMgr.logEvent).not.toHaveBeenCalled();
  });

  test("uses driver name from runtime_handle.driver", async () => {
    const driver = makeMockDriver({ name: "tmux" });
    const otherDriver = makeMockDriver({ name: "other" });
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    mgr.registerDriver(otherDriver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "running",
      runtimeHandle: {
        driver: "other",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    // Only the "other" driver should have been probed
    expect(otherDriver.health).toHaveBeenCalled();
    expect(driver.health).not.toHaveBeenCalled();
  });
});

// ---------- Tests: startReconcileLoop public API ----------

describe("reconcile-loop: startReconcileLoop", () => {
  test("returns a callable stop function", () => {
    const mgr = new RuntimeManager();
    const agentMgr = makeMockAgentMgr();
    const stop = mgr.startReconcileLoop(agentMgr);
    expect(typeof stop).toBe("function");
    // Calling stop should not throw, even if loop hasn't started ticks yet
    stop();
  });

  test("stop is idempotent — multiple calls do not throw", () => {
    const mgr = new RuntimeManager();
    const agentMgr = makeMockAgentMgr();
    const stop = mgr.startReconcileLoop(agentMgr);
    stop();
    stop();
    stop();
  });
});
