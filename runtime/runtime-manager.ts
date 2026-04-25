/**
 * RuntimeManager — minimal facade over a registry of {@link RuntimeDriver}s.
 *
 * Each consumer (admin-daemon on the host, channel/ inside Docker, tests)
 * instantiates and registers its own configured drivers. Drivers are NOT
 * auto-registered here because they require environment-specific config
 * (e.g. `TmuxDriver` needs a `runCliPath` and a `runShell` injection).
 */
import { RuntimeDriver, RuntimeDriverError } from "./types.ts";

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
