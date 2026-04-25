/**
 * RuntimeManager — minimal facade over a registry of {@link RuntimeDriver}s.
 *
 * Each consumer (admin-daemon on the host, channel/ inside Docker, tests)
 * instantiates and registers its own configured drivers. Drivers are NOT
 * auto-registered here because they require environment-specific config
 * (e.g. `TmuxDriver` needs a `runCliPath` and a `runShell` injection).
 */
import { RuntimeDriver, RuntimeDriverError } from "./types.ts";
import type { AgentManager, AgentInstance } from "../agents/agent-manager.ts";
import { CONFIG } from "../config.ts";
import { logger } from "../logger.ts";
import { sql } from "../memory/db.ts";

export class RuntimeManager {
  private readonly drivers = new Map<string, RuntimeDriver>();

  /** Register a driver. Throws if a driver with the same name already exists. */
  registerDriver(driver: RuntimeDriver): void {
    if (this.drivers.has(driver.name)) {
      throw new RuntimeDriverError(
        driver.name,
        "validation",
        `driver "${driver.name}" already registered`,
      );
    }
    this.drivers.set(driver.name, driver);
  }

  /** Look up a driver by name. Throws {@link RuntimeDriverError} if missing. */
  getDriver(name: string): RuntimeDriver {
    const driver = this.drivers.get(name);
    if (!driver) {
      const available = [...this.drivers.keys()].join(", ") || "(none)";
      throw new RuntimeDriverError(
        name,
        "not_found",
        `no driver registered for "${name}". Available: ${available}`,
      );
    }
    return driver;
  }

  /** Returns true iff a driver with the given name is registered. */
  hasDriver(name: string): boolean {
    return this.drivers.has(name);
  }

  /** List all registered driver names. */
  listDrivers(): string[] {
    return [...this.drivers.keys()];
  }

  /**
   * Start a reconcile loop that converges agent_instance.actual_state to desired_state.
   *
   * Reconciliation rules:
   *   desired=running, actual ∈ {new, stopped, failed} → call driver.start, set actual=starting
   *   desired=running, actual=starting             → probe driver.health; if running, set actual=running
   *   desired=running, actual ∈ {idle, busy, running}, health ∈ {stopped, unknown} → restart (if restartCount < limit)
   *   desired=stopped, actual ∈ {running, idle, busy, starting} → call driver.stop, set actual=stopping
   *   desired=stopped, actual=stopping              → probe; if stopped, set actual=stopped
   *   desired=paused                               → no-op for Phase 4 (forward compat)
   *
   * Loop runs every CONFIG.AGENT_RECONCILE_INTERVAL_MS ms.
   * Skipped if env DEFAULT_RUNTIME_DRIVER is empty or AGENT_RECONCILE_INTERVAL_MS is 0.
   *
   * Returns a stop function.
   */
  startReconcileLoop(agentMgr: AgentManager): () => void {
    const intervalMs = CONFIG.AGENT_RECONCILE_INTERVAL_MS;
    if (intervalMs <= 0) {
      logger.info("[runtime] reconcile loop disabled (AGENT_RECONCILE_INTERVAL_MS <= 0)");
      return () => {};
    }
    const restartLimit = CONFIG.AGENT_RESTART_LIMIT;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const instances = await agentMgr.listInstances();
        for (const inst of instances) {
          await this.reconcileInstance(inst, agentMgr, restartLimit).catch((err) => {
            logger.warn({ instanceId: inst.id, err: String(err) }, "reconcile error for instance");
          });
        }
      } catch (err) {
        logger.error({ err: String(err) }, "reconcile loop iteration failed");
      }
    };

    logger.info({ intervalMs, restartLimit }, "[runtime] reconcile loop started");
    const handle = setInterval(tick, intervalMs);
    return () => {
      stopped = true;
      clearInterval(handle);
      logger.info("[runtime] reconcile loop stopped");
    };
  }

  private async reconcileInstance(
    inst: AgentInstance,
    agentMgr: AgentManager,
    restartLimit: number,
  ): Promise<void> {
    const driverName = (inst.runtimeHandle.driver as string) ?? CONFIG.DEFAULT_RUNTIME_DRIVER ?? "tmux";
    if (!this.hasDriver(driverName)) {
      // Driver not registered in this process — skip. (Other processes may handle it.)
      return;
    }
    const driver = this.getDriver(driverName);
    const handle = inst.runtimeHandle as any; // RuntimeHandle shape

    // desired=paused — no-op (forward compat). Skip BEFORE health probe so paused
    // instances incur zero driver work.
    if (inst.desiredState === "paused") return;

    // === Health-first probe ===
    // Always probe driver.health() before deciding to start. This handles:
    //   - bootstrapped instances with actual_state='new' but tmux window already exists
    //   - drift cases where actual_state in DB doesn't match reality
    let healthState: "running" | "stopped" | "unknown" = "unknown";
    try {
      const health = await driver.health(handle);
      healthState = health.state;
    } catch (err) {
      logger.warn({ instanceId: inst.id, err: String(err) }, "health probe threw — treating as unknown");
    }

    // === First-observation grace period ===
    // If actual_state is still 'new' (never reconciled), do NOT take any action.
    // Just record what we observed and let the operator review desired_state
    // before the next tick. This prevents the cold-boot regression where the
    // reconciler kills tmux windows whose desired_state in DB happens to be
    // 'stopped' but were running pre-restart.
    if (inst.actualState === "new") {
      const observed: typeof inst.actualState =
        healthState === "running" ? "running" :
        healthState === "stopped" ? "stopped" : "new";
      if (observed !== "new") {
        await agentMgr.setActualState(
          inst.id,
          observed,
          `first observation: health=${healthState}, desired=${inst.desiredState}`,
        );
      }
      return;
    }

    // === desired=running ===
    if (inst.desiredState === "running") {
      if (healthState === "running") {
        // Reality matches desired — just normalize actual_state if needed.
        if (
          inst.actualState !== "running" &&
          inst.actualState !== "idle" &&
          inst.actualState !== "busy"
        ) {
          await agentMgr.setActualState(inst.id, "running", "health probe found running window");
        } else {
          await agentMgr.setActualState(inst.id, inst.actualState); // touch lastHealthAt
        }
        return;
      }

      if (healthState === "stopped") {
        // Need to start. Check restart budget first — if we already gave up, stay there.
        if (inst.restartCount >= restartLimit && inst.actualState === "failed") {
          logger.warn(
            { instanceId: inst.id, restartCount: inst.restartCount },
            "restart limit reached, leaving in failed state",
          );
          return;
        }

        // Resolve projectPath / projectName: prefer handle, fallback to projects table.
        let projectPath = handle.projectPath as string | undefined;
        let projectName = handle.projectName as string | undefined;
        if ((!projectPath || !projectName) && inst.projectId) {
          try {
            const rows = (await sql`
              SELECT path, name FROM projects WHERE id = ${inst.projectId} LIMIT 1
            `) as any[];
            const proj = rows[0];
            if (proj) {
              projectPath = projectPath ?? proj.path;
              projectName = projectName ?? proj.name;
            }
          } catch (err) {
            logger.warn(
              { instanceId: inst.id, projectId: inst.projectId, err: String(err) },
              "project lookup failed",
            );
          }
        }

        if (!projectPath || !projectName) {
          logger.warn(
            { instanceId: inst.id, projectId: inst.projectId },
            "cannot resolve projectPath/projectName — marking failed",
          );
          await agentMgr.setActualState(
            inst.id,
            "failed",
            "cannot resolve projectPath/projectName",
          );
          return;
        }

        // Resolve runtime_type from agent_definition for the start command.
        let runtimeType: string | undefined;
        try {
          const defRows = (await sql`
            SELECT runtime_type FROM agent_definitions WHERE id = ${inst.definitionId} LIMIT 1
          `) as any[];
          runtimeType = defRows[0]?.runtime_type as string | undefined;
        } catch (err) {
          logger.warn(
            { instanceId: inst.id, definitionId: inst.definitionId, err: String(err) },
            "agent_definition lookup failed",
          );
        }

        try {
          await agentMgr.setActualState(inst.id, "starting");
          await agentMgr.logEvent({ agentInstanceId: inst.id, eventType: "start_attempt" });
          const updatedHandle = await driver.start(handle, {
            projectPath,
            projectName,
            runtimeType,
          });
          await agentMgr.updateRuntimeHandle(inst.id, updatedHandle);
          // Don't immediately mark as running — let next tick verify via health
        } catch (err) {
          await agentMgr.setActualState(inst.id, "failed", `start failed: ${String(err)}`);
          await agentMgr.incrementRestartCount(inst.id);
        }
        return;
      }

      // healthState === "unknown" — leave actualState alone, will retry next tick.
      return;
    }

    // === desired=stopped ===
    if (inst.desiredState === "stopped") {
      if (healthState === "running") {
        // Need to stop.
        try {
          await agentMgr.setActualState(inst.id, "stopping");
          await driver.stop(handle);
          await agentMgr.setActualState(inst.id, "stopped");
        } catch (err) {
          await agentMgr.setActualState(inst.id, "failed", `stop failed: ${String(err)}`);
        }
        return;
      }

      // healthState === "stopped" or "unknown" — already where we want; just normalize.
      if (inst.actualState !== "stopped" && inst.actualState !== "new") {
        await agentMgr.setActualState(inst.id, "stopped");
      }
      // If already stopped or new — no-op (no need to touch lastHealthAt for terminal state).
    }
  }
}

/**
 * Singleton instance — STARTS EMPTY by design.
 *
 * Callers MUST call `runtimeManager.registerDriver(driver)` before any
 * `runtimeManager.getDriver(name)` call. There is no auto-registration here
 * because driver construction requires environment-specific config that only
 * the entry point (admin-daemon, channel/) knows.
 *
 * Today only `admin-daemon.ts` registers a driver (TmuxDriver, on host).
 * If Phase 4+ adds more entry points, each must register the drivers it needs.
 * Calling `getDriver("tmux")` before registration throws
 * `RuntimeDriverError(code: "not_found")` — wrap in a try/catch or use
 * `hasDriver(name)` to probe.
 */
export const runtimeManager = new RuntimeManager();
