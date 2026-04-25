/**
 * TmuxDriver — runtime driver that hosts agent CLI processes inside tmux
 * windows. Ports the existing `proj_start` flow from
 * `scripts/admin-daemon.ts` behind the {@link RuntimeDriver} contract.
 *
 * Constraints (from analysis report R5):
 *  - This driver runs on the HOST process (admin-daemon), not inside Docker.
 *  - All configuration is provided via the constructor — the driver itself
 *    imports nothing outside `runtime/types.ts`.
 *  - The shell runner is injected so the driver works in any environment
 *    (host process, Docker container, tests with a stub).
 */
import {
  RuntimeDriver,
  RuntimeDriverError,
  RuntimeHandle,
  RuntimeHealth,
  RuntimeInputAction,
  RuntimeStartConfig,
  SnapshotOptions,
  SnapshotResult,
} from "../types.ts";

/**
 * Result shape produced by an injected shell runner. Mirrors the common
 * `{ stdout, stderr, exitCode }` triple emitted by Bun.spawn / child_process.
 */
export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * A function that executes a shell command and returns its result. Callers
 * inject this so the driver works on any host (admin-daemon, docker, tests).
 */
export type ShellRunner = (cmd: string) => Promise<ShellResult>;

export interface TmuxDriverConfig {
  /** Default tmux session name. Default: `"bots"`. Override per-handle via `handle.tmuxSession`. */
  defaultSession?: string;
  /** Absolute path to the `run-cli.sh` launcher. Required. */
  runCliPath: string;
  /** Shell runner — caller injects this so the driver works in any environment (host or Docker). */
  runShell: ShellRunner;
  /** Optional logger. */
  log?: (msg: string, meta?: unknown) => void;
}

/** Path validation regex — mirrors admin-daemon.ts proj_start (line ~165). */
const PATH_REGEX = /^[a-zA-Z0-9/_.-]+$/;
/** Project-name validation regex — mirrors admin-daemon.ts tmux_send_keys (line ~220). */
const NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

export class TmuxDriver implements RuntimeDriver {
  readonly name = "tmux" as const;

  constructor(private readonly config: TmuxDriverConfig) {
    if (!config.runCliPath) {
      throw new RuntimeDriverError(
        "tmux",
        "validation",
        "runCliPath is required in TmuxDriverConfig",
      );
    }
    if (!config.runShell) {
      throw new RuntimeDriverError(
        "tmux",
        "validation",
        "runShell is required in TmuxDriverConfig",
      );
    }
  }

  /**
   * Start a project window inside tmux.
   *
   * Behavior matches `admin-daemon.ts` `proj_start` 1:1:
   *  1. Validate `projectPath` and `projectName` against shell-injection regexes.
   *  2. Ensure the tmux session exists (create detached if missing).
   *  3. Kill any pre-existing windows with the same name (loop, because
   *     `kill-window` only kills the first match — prevents zombie buildup).
   *  4. Create the new window via `new-window … -P -F "#{window_index}"` and
   *     send the launch command using the captured numeric index. This avoids
   *     the race where the shell auto-renames the window before `send-keys`.
   */
  async start(handle: RuntimeHandle, startConfig: RuntimeStartConfig): Promise<RuntimeHandle> {
    // 1. Validate inputs.
    if (!PATH_REGEX.test(startConfig.projectPath)) {
      throw new RuntimeDriverError(
        "tmux",
        "validation",
        `invalid projectPath: ${startConfig.projectPath}`,
      );
    }
    if (!NAME_REGEX.test(startConfig.projectName)) {
      throw new RuntimeDriverError(
        "tmux",
        "validation",
        `invalid projectName: ${startConfig.projectName}`,
      );
    }

    const session = handle.tmuxSession ?? this.config.defaultSession ?? "bots";
    const window = handle.tmuxWindow ?? startConfig.projectName;
    const runCli = this.config.runCliPath;

    // 2. Ensure tmux session exists. `has-session` exits non-zero when missing.
    const hasSession = await this.config.runShell(`tmux has-session -t ${session} 2>/dev/null`);
    if (hasSession.exitCode !== 0) {
      const newSession = await this.config.runShell(`tmux new-session -d -s ${session}`);
      if (newSession.exitCode !== 0) {
        throw new RuntimeDriverError(
          "tmux",
          "shell_error",
          `failed to create tmux session ${session}: ${newSession.stderr}`,
        );
      }
    }

    // 3. Kill ALL existing windows with this name to avoid zombie accumulation.
    //    `tmux kill-window` by name kills only the first match, so loop until none.
    await this.config.runShell(
      `while tmux kill-window -t "${session}:${window}" 2>/dev/null; do :; done`,
    );

    // 4. Create the new window AND send-keys in one shell invocation, capturing
    //    the numeric index so subsequent send-keys is not racing the shell's
    //    auto-rename of the window. Matches admin-daemon.ts proj_start exactly.
    const command = startConfig.command ?? `${runCli} ${startConfig.projectPath}`;
    const escapedCommand = command.replace(/"/g, '\\"');
    const startResult = await this.config.runShell(
      `idx=$(tmux new-window -t ${session} -n "${window}" -c "${startConfig.projectPath}" -P -F "#{window_index}") && ` +
        `tmux send-keys -t "${session}:$idx" "${escapedCommand}" Enter`,
    );
    if (startResult.exitCode !== 0) {
      throw new RuntimeDriverError(
        "tmux",
        "shell_error",
        `failed to start window ${session}:${window}: ${startResult.stderr || startResult.stdout}`,
      );
    }

    this.config.log?.(`[tmux] started window ${session}:${window} with command: ${command}`);

    // 5. Return updated handle with driver-specific fields filled in.
    return {
      ...handle,
      driver: "tmux",
      tmuxSession: session,
      tmuxWindow: window,
    };
  }

  // ---------------------------------------------------------------------------
  // Stubs for Wave 3 — the rest of the driver lives there.
  // ---------------------------------------------------------------------------

  /**
   * Stop a tmux window.
   *
   * Behavior matches `admin-daemon.ts` `proj_stop` 1:1:
   *  - Loop `tmux kill-window -t "session:window"` until it exits non-zero
   *    (no more windows by that name). tmux only kills the first match per
   *    invocation, so a loop is required to clean up zombies from races where
   *    multiple windows share the same name.
   *
   * Idempotency: calling `stop()` on a non-existent window is a no-op (the
   *   first `kill-window` invocation will exit non-zero and we return cleanly).
   */
  async stop(handle: RuntimeHandle): Promise<void> {
    const session = handle.tmuxSession ?? this.config.defaultSession ?? "bots";
    const window = handle.tmuxWindow;
    if (!window || !NAME_REGEX.test(window)) {
      throw new RuntimeDriverError(
        "tmux",
        "invalid_handle",
        `tmux window name missing or invalid in handle: ${window}`,
      );
    }

    // Loop kill-window until gone (matches admin-daemon proj_stop pattern).
    // A bound is in place so a pathologically respawning window cannot wedge
    // the driver indefinitely — admin-daemon uses an unbounded shell-side loop,
    // but the host-side loop here is safer in JS.
    const MAX_ATTEMPTS = 10;
    let killed = 0;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const result = await this.config.runShell(
        `tmux kill-window -t "${session}:${window}" 2>/dev/null`,
      );
      if (result.exitCode !== 0) {
        // No more windows with that name — done (idempotent semantic).
        this.config.log?.(
          `[tmux] stop: killed ${killed} window(s) named ${session}:${window}`,
        );
        return;
      }
      killed += 1;
    }
    // Hit the limit — log but don't throw (idempotent semantic).
    this.config.log?.(
      `[tmux] stop: hit max attempts (${MAX_ATTEMPTS}) killing window ${session}:${window}`,
    );
  }

  async sendInput(_handle: RuntimeHandle, _action: RuntimeInputAction): Promise<void> {
    throw new RuntimeDriverError(
      "tmux",
      "validation",
      "sendInput() not implemented in this wave — see Wave 3",
    );
  }

  async health(_handle: RuntimeHandle): Promise<RuntimeHealth> {
    throw new RuntimeDriverError(
      "tmux",
      "validation",
      "health() not implemented in this wave — see Wave 3",
    );
  }

  async snapshot(_handle: RuntimeHandle, _options?: SnapshotOptions): Promise<SnapshotResult> {
    throw new RuntimeDriverError(
      "tmux",
      "validation",
      "snapshot() not implemented in this wave — see Wave 3",
    );
  }
}
