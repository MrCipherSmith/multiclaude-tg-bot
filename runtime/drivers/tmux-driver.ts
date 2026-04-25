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

  /**
   * Send an input action to the tmux window.
   *
   * Each variant of {@link RuntimeInputAction} maps to an admin-daemon flow:
   *  - `text`        — `tmux send-keys -t target "<text>" Enter` (with quote escape)
   *  - `key`         — `tmux send-keys -t target <KeyName>` (single named key)
   *  - `esc`         — Escape + poll for Claude's confirm dialog + Enter on match
   *                    (matches admin-daemon `tmux_send_keys` action="esc"|"interrupt")
   *  - `close_editor`— Escape + 200 ms + `:q!` Enter (matches admin-daemon `close_editor`)
   */
  async sendInput(handle: RuntimeHandle, action: RuntimeInputAction): Promise<void> {
    const session = handle.tmuxSession ?? this.config.defaultSession ?? "bots";
    const window = handle.tmuxWindow;
    if (!window || !NAME_REGEX.test(window)) {
      throw new RuntimeDriverError(
        "tmux",
        "invalid_handle",
        `tmux window name missing or invalid: ${window}`,
      );
    }
    const target = `${session}:${window}`;

    switch (action.kind) {
      case "text": {
        // Escape double quotes in the user-supplied text for shell safety.
        // The window name is regex-validated above, so the target is safe.
        const escaped = action.text.replace(/"/g, '\\"');
        const r = await this.config.runShell(
          `tmux send-keys -t "${target}" "${escaped}" Enter`,
        );
        if (r.exitCode !== 0) {
          throw new RuntimeDriverError(
            "tmux",
            "shell_error",
            `send text failed: ${r.stderr || r.stdout}`,
          );
        }
        return;
      }
      case "key": {
        // Allow tmux-named keys ("Enter", "Escape", "C-c", etc.). Keep the
        // validation strict but slightly broader than alphanumeric to permit
        // chord forms like "C-c" and "M-x" that tmux understands.
        if (!/^[A-Za-z0-9_-]+$/.test(action.key)) {
          throw new RuntimeDriverError(
            "tmux",
            "validation",
            `invalid key name: ${action.key}`,
          );
        }
        const r = await this.config.runShell(
          `tmux send-keys -t "${target}" ${action.key}`,
        );
        if (r.exitCode !== 0) {
          throw new RuntimeDriverError(
            "tmux",
            "shell_error",
            `send key failed: ${r.stderr || r.stdout}`,
          );
        }
        return;
      }
      case "esc": {
        // Matches admin-daemon `tmux_send_keys` action="esc"|"interrupt" 1:1:
        //   1. Send Escape to trigger Claude's interrupt flow.
        //   2. Poll the pane every 200ms for up to 1500ms looking for the
        //      "enter to confirm / esc to cancel" dialog.
        //   3. If found, send `Enter` to confirm the interrupt.
        //   4. If never found within the deadline, silently return — admin-daemon
        //      reports "Sent Escape" without any error in that case, so this is
        //      the "soft" path (no exception).
        await this.config.runShell(`tmux send-keys -t "${target}" Escape`);

        const CONFIRM_RE = /enter to confirm|esc to cancel/i;
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline) {
          await new Promise((res) => setTimeout(res, 200));
          const out = await this.config.runShell(
            `tmux capture-pane -t "${target}" -p -S -5 2>/dev/null || true`,
          );
          if (CONFIRM_RE.test(out.stdout)) {
            // admin-daemon sends an empty literal then Enter to confirm.
            const r = await this.config.runShell(
              `tmux send-keys -t "${target}" "" Enter`,
            );
            if (r.exitCode !== 0) {
              throw new RuntimeDriverError(
                "tmux",
                "shell_error",
                `esc confirm failed: ${r.stderr || r.stdout}`,
              );
            }
            return;
          }
        }
        // No confirm dialog appeared — that's fine, Escape may have done the
        // job by itself. Match admin-daemon's "Sent Escape" no-error path.
        return;
      }
      case "close_editor": {
        // Matches admin-daemon `tmux_send_keys` action="close_editor" 1:1:
        //   1. Send Escape to leave insert mode.
        //   2. Wait 200 ms (not 100ms — admin-daemon uses 200ms).
        //   3. Send `:q!` Enter to force-quit vim.
        await this.config.runShell(`tmux send-keys -t "${target}" Escape`);
        await new Promise((res) => setTimeout(res, 200));
        const r = await this.config.runShell(
          `tmux send-keys -t "${target}" ':q!' Enter`,
        );
        if (r.exitCode !== 0) {
          throw new RuntimeDriverError(
            "tmux",
            "shell_error",
            `close_editor failed: ${r.stderr || r.stdout}`,
          );
        }
        return;
      }
    }
  }

  /**
   * Check tmux session/window health.
   *
   *  - If the session itself is missing → `stopped` with `reason: "session_missing"`.
   *  - If no `tmuxWindow` is set on the handle → session-level `running`.
   *  - Otherwise list windows in the session and report `running` if the
   *    window name is present, `stopped` otherwise.
   *
   * Cheap operation: at most two `tmux` calls (`has-session`, `list-windows`).
   */
  async health(handle: RuntimeHandle): Promise<RuntimeHealth> {
    const session = handle.tmuxSession ?? this.config.defaultSession ?? "bots";
    const window = handle.tmuxWindow;

    // 1. Check that the session exists at all.
    const sessionCheck = await this.config.runShell(
      `tmux has-session -t ${session} 2>/dev/null`,
    );
    if (sessionCheck.exitCode !== 0) {
      return {
        state: "stopped",
        lastChecked: new Date(),
        details: { reason: "session_missing", session },
      };
    }

    // 2. No window on the handle → just report session-level running.
    if (!window) {
      return {
        state: "running",
        lastChecked: new Date(),
        details: { session },
      };
    }

    // 3. Window name validation — return "unknown" rather than throwing,
    //    health is meant to be a cheap status probe.
    if (!NAME_REGEX.test(window)) {
      return {
        state: "unknown",
        lastChecked: new Date(),
        details: { reason: "invalid_window_name", window },
      };
    }

    // 4. List windows and check for the target name.
    const windows = await this.config.runShell(
      `tmux list-windows -t ${session} -F "#{window_name}"`,
    );
    if (windows.exitCode !== 0) {
      return {
        state: "unknown",
        lastChecked: new Date(),
        details: { reason: "list_windows_failed", stderr: windows.stderr },
      };
    }

    const found = windows.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(window);

    return {
      state: found ? "running" : "stopped",
      lastChecked: new Date(),
      details: { session, window, found },
    };
  }

  /**
   * Capture pane content from the tmux window.
   *
   * Matches `tmux-watchdog.ts` shell commands 1:1 so watchdog detection
   * heuristics (permission prompts, stalls, editor open) keep working
   * unchanged when callers route through the driver:
   *
   *  - visible only (no scroll-back): `tmux capture-pane -t "session:window" -p`
   *  - scroll-back N lines:           `tmux capture-pane -t "session:window" -p -S -N`
   *
   * Selection rule: if `visibleOnly === true` OR `lines` is undefined →
   *   visible only. Otherwise → `-S -${lines}`.
   */
  async snapshot(handle: RuntimeHandle, options?: SnapshotOptions): Promise<SnapshotResult> {
    const session = handle.tmuxSession ?? this.config.defaultSession ?? "bots";
    const window = handle.tmuxWindow;
    if (!window || !NAME_REGEX.test(window)) {
      throw new RuntimeDriverError(
        "tmux",
        "invalid_handle",
        `tmux window name missing or invalid: ${window}`,
      );
    }
    const target = `${session}:${window}`;

    const useVisibleOnly = options?.visibleOnly === true || options?.lines === undefined;
    const cmd = useVisibleOnly
      ? `tmux capture-pane -t "${target}" -p`
      : `tmux capture-pane -t "${target}" -p -S -${options!.lines}`;

    const result = await this.config.runShell(cmd);
    if (result.exitCode !== 0) {
      throw new RuntimeDriverError(
        "tmux",
        "shell_error",
        `capture-pane failed: ${result.stderr || result.stdout}`,
      );
    }

    return {
      lines: result.stdout.split("\n"),
      capturedAt: new Date(),
      handle: { ...handle, driver: "tmux", tmuxSession: session, tmuxWindow: window },
    };
  }
}
