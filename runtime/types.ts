/**
 * Runtime driver interfaces.
 *
 * These types define the abstract contract for any runtime that can host an
 * agent CLI process (tmux, pty, raw process, docker, etc.). Wave 1 only
 * defines the shapes — concrete drivers and integration land in later waves.
 *
 * Design notes:
 *  - `RuntimeHandle` is intentionally JSONB-shaped so it can be persisted as-is
 *    in the database. Driver-specific fields are allowed via the index
 *    signature.
 *  - `RuntimeInputAction` is a discriminated union that mirrors the existing
 *    admin-daemon `tmux_send_keys` flows ("esc", "close_editor") so drivers
 *    can be swapped without changing call sites.
 */

/**
 * Opaque, JSONB-shaped descriptor for a runtime instance. Persisted in the
 * database and passed back to the driver on every operation.
 */
export interface RuntimeHandle {
  /** Registered driver name — matches `RuntimeDriver.name`. */
  driver: string;
  /** For the tmux driver: session name (e.g., "bots"). */
  tmuxSession?: string;
  /** For the tmux driver: window name (e.g., the project name). */
  tmuxWindow?: string;
  /** Driver-specific extras (pid, container id, pty fd, etc.). */
  [key: string]: unknown;
}

/**
 * Configuration passed to {@link RuntimeDriver.start}.
 */
export interface RuntimeStartConfig {
  /** Absolute path to the project directory. */
  projectPath: string;
  /** Sanitized name used for tmux window naming and other identifiers. */
  projectName: string;
  /** Optional command override; default: the project's run-cli.sh path. */
  command?: string;
  /** Additional environment variables for the spawned process. */
  env?: Record<string, string>;
}

/**
 * Discriminated union of input actions accepted by {@link RuntimeDriver.sendInput}.
 *
 * The `esc` and `close_editor` variants mirror the admin-daemon's existing
 * `tmux_send_keys` flows so drivers stay drop-in compatible.
 */
export type RuntimeInputAction =
  | { kind: "text"; text: string }
  | { kind: "key"; key: "Escape" | "Enter" | string }
  | { kind: "esc" }
  | { kind: "close_editor" };

/**
 * High-level health states reported by a runtime driver.
 */
export type RuntimeHealthState = "running" | "stopped" | "unknown";

/**
 * Health snapshot returned by {@link RuntimeDriver.health}.
 */
export interface RuntimeHealth {
  state: RuntimeHealthState;
  lastChecked: Date;
  /** Driver-specific details (e.g., pid, uptime, pane line count). */
  details?: Record<string, unknown>;
}

/**
 * Options for {@link RuntimeDriver.snapshot}.
 */
export interface SnapshotOptions {
  /** How many lines back to capture; default: visible only. */
  lines?: number;
  /** If true, do not include scroll-back history. */
  visibleOnly?: boolean;
}

/**
 * Result of {@link RuntimeDriver.snapshot}.
 */
export interface SnapshotResult {
  /** Captured lines, oldest first. */
  lines: string[];
  capturedAt: Date;
  /** Echo of the handle for traceability. */
  handle: RuntimeHandle;
}

/**
 * The main runtime driver interface. Each concrete driver (tmux, pty, etc.)
 * implements this contract and is registered under a unique {@link name}.
 */
export interface RuntimeDriver {
  /** Driver identifier — must match {@link RuntimeHandle.driver}. */
  readonly name: string;

  /**
   * Start a runtime. Returns the (possibly mutated) handle — drivers may add
   * fields such as tmux session/window names, pids, container ids, etc.
   */
  start(handle: RuntimeHandle, config: RuntimeStartConfig): Promise<RuntimeHandle>;

  /** Stop a runtime. Idempotent — safe to call on an already-stopped handle. */
  stop(handle: RuntimeHandle): Promise<void>;

  /** Send an input action to the runtime. */
  sendInput(handle: RuntimeHandle, action: RuntimeInputAction): Promise<void>;

  /**
   * Check health. Cheap operation, called frequently by watchdog loops.
   */
  health(handle: RuntimeHandle): Promise<RuntimeHealth>;

  /** Capture a pane / output snapshot. */
  snapshot(handle: RuntimeHandle, options?: SnapshotOptions): Promise<SnapshotResult>;
}

/**
 * Custom error class for driver-level failures (validation, missing handle,
 * shell errors). Carries a structured `code` so callers can branch without
 * string-matching on messages.
 */
export class RuntimeDriverError extends Error {
  constructor(
    public readonly driver: string,
    public readonly code: "invalid_handle" | "not_found" | "shell_error" | "validation",
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${driver}] ${code}: ${message}`);
    this.name = "RuntimeDriverError";
  }
}
