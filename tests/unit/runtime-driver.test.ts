/**
 * Unit tests for `TmuxDriver` — pure, no-network, no-tmux tests.
 *
 * The driver's external dependency is a single injected `runShell` function,
 * so every test stubs that. We verify:
 *   - Constructor validation (rejects missing config)
 *   - `start()` validates path/name against shell-injection regexes
 *   - `start()` returns a handle with session/window populated
 *   - `start()` creates the tmux session if missing
 *   - `stop()` is idempotent and validates the window name
 *   - `health()` reports running / stopped correctly
 *   - `sendInput()` produces the expected tmux send-keys commands
 *   - `snapshot()` toggles between `-S -N` and visible-only modes
 */

import { describe, test, expect } from "bun:test";
import {
  TmuxDriver,
  type ShellRunner,
  type ShellResult,
} from "../../runtime/drivers/tmux-driver.ts";
import { RuntimeDriverError } from "../../runtime/types.ts";

interface MockResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

/**
 * Build a mock ShellRunner that returns canned responses based on substring
 * matching against the issued command. Returns the runner plus a `calls` array
 * for inspection.
 */
function makeMockShell(
  responses: Map<string, MockResponse>,
): { runShell: ShellRunner; calls: string[] } {
  const calls: string[] = [];
  const runShell: ShellRunner = async (cmd: string): Promise<ShellResult> => {
    calls.push(cmd);
    for (const [pattern, response] of responses) {
      if (cmd.includes(pattern)) {
        return {
          stdout: response.stdout ?? "",
          stderr: response.stderr ?? "",
          exitCode: response.exitCode ?? 0,
        };
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { runShell, calls };
}

function makeDriver(runShell: ShellRunner): TmuxDriver {
  return new TmuxDriver({
    defaultSession: "bots",
    runCliPath: "/path/to/run-cli.sh",
    runShell,
  });
}

describe("TmuxDriver", () => {
  describe("constructor", () => {
    test("throws if runCliPath is missing", () => {
      expect(
        () =>
          new TmuxDriver({
            runShell: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
          } as never),
      ).toThrow(RuntimeDriverError);
    });

    test("throws if runShell is missing", () => {
      expect(
        () => new TmuxDriver({ runCliPath: "/x" } as never),
      ).toThrow(RuntimeDriverError);
    });
  });

  describe("start()", () => {
    test("rejects invalid projectPath (path injection)", async () => {
      const { runShell } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await expect(
        driver.start(
          { driver: "tmux" },
          { projectPath: "/path; rm -rf /", projectName: "x" },
        ),
      ).rejects.toThrow(/invalid projectPath/);
    });

    test("rejects invalid projectName", async () => {
      const { runShell } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await expect(
        driver.start(
          { driver: "tmux" },
          { projectPath: "/valid/path", projectName: "x;y" },
        ),
      ).rejects.toThrow(/invalid projectName/);
    });

    test("rejects projectPath with `..` segment (traversal)", async () => {
      const { runShell } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await expect(
        driver.start(
          { driver: "tmux" },
          { projectPath: "/foo/../etc", projectName: "p" },
        ),
      ).rejects.toThrow(/invalid projectPath/);
    });

    test("rejects projectPath with `.` segment", async () => {
      const { runShell } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await expect(
        driver.start(
          { driver: "tmux" },
          { projectPath: "/foo/./bar", projectName: "p" },
        ),
      ).rejects.toThrow(/invalid projectPath/);
    });

    test("rejects projectPath with empty segment (//)", async () => {
      const { runShell } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await expect(
        driver.start(
          { driver: "tmux" },
          { projectPath: "/foo//bar", projectName: "p" },
        ),
      ).rejects.toThrow(/invalid projectPath/);
    });

    test("returns updated handle with session and window set", async () => {
      const { runShell } = makeMockShell(
        new Map([
          ["has-session", { exitCode: 0 }],
          // Simulated tmux idx capture for new-window -P -F "#{window_index}"
          ["new-window", { exitCode: 0, stdout: "1" }],
        ]),
      );
      const driver = makeDriver(runShell);
      const handle = await driver.start(
        { driver: "tmux" },
        { projectPath: "/home/user/proj", projectName: "myproj" },
      );
      expect(handle.tmuxSession).toBe("bots");
      expect(handle.tmuxWindow).toBe("myproj");
      expect(handle.driver).toBe("tmux");
    });

    test("creates session if has-session fails", async () => {
      const { runShell, calls } = makeMockShell(
        new Map([
          ["has-session", { exitCode: 1 }],
          ["new-session", { exitCode: 0 }],
          ["new-window", { exitCode: 0, stdout: "1" }],
        ]),
      );
      const driver = makeDriver(runShell);
      await driver.start(
        { driver: "tmux" },
        { projectPath: "/x", projectName: "p" },
      );
      expect(calls.some((c) => c.includes("new-session"))).toBe(true);
    });

    test("appends runtimeType to default command", async () => {
      const { runShell, calls } = makeMockShell(
        new Map([
          ["has-session", { exitCode: 0 }],
          ["new-window", { exitCode: 0, stdout: "1" }],
        ]),
      );
      const driver = makeDriver(runShell);
      await driver.start(
        { driver: "tmux" },
        { projectPath: "/x", projectName: "p", runtimeType: "codex-cli" },
      );
      // The send-keys call carries the launcher command; runtimeType is the
      // 2nd positional arg to run-cli.sh (1st is projectPath).
      const sendKeys = calls.find(
        (c) => c.includes("send-keys") && c.includes("/path/to/run-cli.sh"),
      );
      expect(sendKeys).toBeDefined();
      expect(sendKeys).toContain("/path/to/run-cli.sh /x codex-cli");
    });

    test("defaults runtimeType to claude-code when omitted", async () => {
      const { runShell, calls } = makeMockShell(
        new Map([
          ["has-session", { exitCode: 0 }],
          ["new-window", { exitCode: 0, stdout: "1" }],
        ]),
      );
      const driver = makeDriver(runShell);
      await driver.start(
        { driver: "tmux" },
        { projectPath: "/x", projectName: "p" }, // no runtimeType
      );
      const sendKeys = calls.find(
        (c) => c.includes("send-keys") && c.includes("/path/to/run-cli.sh"),
      );
      expect(sendKeys).toBeDefined();
      expect(sendKeys).toContain("/path/to/run-cli.sh /x claude-code");
    });

    test("rejects malicious tmuxSession on the handle (shell injection)", async () => {
      const { runShell } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await expect(
        driver.start(
          { driver: "tmux", tmuxSession: "bots; rm -rf /" },
          { projectPath: "/x", projectName: "p" },
        ),
      ).rejects.toThrow(/invalid tmuxSession/);
    });

    test("rejects unsupported runtimeType (shell injection)", async () => {
      const { runShell } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await expect(
        driver.start(
          { driver: "tmux" },
          { projectPath: "/x", projectName: "p", runtimeType: "evil; reboot" },
        ),
      ).rejects.toThrow(/invalid runtimeType/);
    });

    test("escapes backtick and dollar in command override", async () => {
      const { runShell, calls } = makeMockShell(
        new Map([
          ["has-session", { exitCode: 0 }],
          ["new-window", { exitCode: 0, stdout: "1" }],
        ]),
      );
      const driver = makeDriver(runShell);
      await driver.start(
        { driver: "tmux" },
        {
          projectPath: "/x",
          projectName: "p",
          command: "echo `id` $(whoami) $HOME",
        },
      );
      const sendKeys = calls.find((c) => c.includes("send-keys"));
      expect(sendKeys).toBeDefined();
      // Backticks must be escaped — substring "\`" must appear (TS source: \\`)
      expect(sendKeys).toContain("\\`id\\`");
      // Dollar signs must be escaped — substring "\$" must appear (TS source: \\$)
      expect(sendKeys).toContain("\\$(whoami)");
      expect(sendKeys).toContain("\\$HOME");
    });

    test("explicit command override ignores runtimeType", async () => {
      const { runShell, calls } = makeMockShell(
        new Map([
          ["has-session", { exitCode: 0 }],
          ["new-window", { exitCode: 0, stdout: "1" }],
        ]),
      );
      const driver = makeDriver(runShell);
      await driver.start(
        { driver: "tmux" },
        {
          projectPath: "/x",
          projectName: "p",
          runtimeType: "codex-cli",
          command: "echo hello",
        },
      );
      const sendKeys = calls.find((c) => c.includes("send-keys"));
      expect(sendKeys).toBeDefined();
      expect(sendKeys).toContain("echo hello");
      // Override path bypasses the launcher entirely — runtimeType is ignored.
      expect(sendKeys).not.toContain("/path/to/run-cli.sh");
      expect(sendKeys).not.toContain("codex-cli");
    });

    test("command override skips runtimeType whitelist (custom-launcher path)", async () => {
      // When the caller supplies a custom command, runtimeType is irrelevant
      // (it's never interpolated into the shell). Whitelist must NOT fire,
      // otherwise valid custom-launcher use cases get spurious rejections.
      const { runShell, calls } = makeMockShell(
        new Map([
          ["has-session", { exitCode: 0 }],
          ["new-window", { exitCode: 0, stdout: "1" }],
        ]),
      );
      const driver = makeDriver(runShell);
      await expect(
        driver.start(
          { driver: "tmux" },
          {
            projectPath: "/x",
            projectName: "p",
            runtimeType: "future-runtime-not-yet-whitelisted",
            command: "/usr/local/bin/my-custom-launcher",
          },
        ),
      ).resolves.toBeDefined();
      const sendKeys = calls.find((c) => c.includes("send-keys"));
      expect(sendKeys).toContain("my-custom-launcher");
    });

    test("escapes backslash in command override (start path)", async () => {
      const { runShell, calls } = makeMockShell(
        new Map([
          ["has-session", { exitCode: 0 }],
          ["new-window", { exitCode: 0, stdout: "1" }],
        ]),
      );
      const driver = makeDriver(runShell);
      await driver.start(
        { driver: "tmux" },
        {
          projectPath: "/x",
          projectName: "p",
          command: "echo \\path\\to\\file",
        },
      );
      const sendKeys = calls.find((c) => c.includes("send-keys"));
      expect(sendKeys).toBeDefined();
      // Each `\` must become `\\` in the shell string. TS source `\\\\` is two
      // runtime backslashes; the driver doubles them to four (= `\\\\` source).
      expect(sendKeys).toContain("\\\\path\\\\to\\\\file");
    });
  });

  describe("stop()", () => {
    test("idempotent — does not throw if window missing", async () => {
      const { runShell } = makeMockShell(
        new Map([["kill-window", { exitCode: 1 }]]),
      );
      const driver = makeDriver(runShell);
      // Should resolve without throwing.
      await driver.stop({
        driver: "tmux",
        tmuxSession: "bots",
        tmuxWindow: "nonexistent",
      });
    });

    test("rejects invalid window name", async () => {
      const { runShell } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await expect(
        driver.stop({
          driver: "tmux",
          tmuxSession: "bots",
          tmuxWindow: "x;y",
        }),
      ).rejects.toThrow(/invalid/i);
    });

    test("loops kill-window until it exits non-zero", async () => {
      // First two attempts succeed (zombies present), third returns non-zero.
      let attempt = 0;
      const runShell: ShellRunner = async (cmd) => {
        if (cmd.includes("kill-window")) {
          attempt += 1;
          return {
            stdout: "",
            stderr: "",
            exitCode: attempt <= 2 ? 0 : 1,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const driver = makeDriver(runShell);
      await driver.stop({
        driver: "tmux",
        tmuxSession: "bots",
        tmuxWindow: "myproj",
      });
      expect(attempt).toBe(3);
    });
  });

  describe("health()", () => {
    test("returns 'stopped' when session does not exist", async () => {
      const { runShell } = makeMockShell(
        new Map([["has-session", { exitCode: 1 }]]),
      );
      const driver = makeDriver(runShell);
      const health = await driver.health({
        driver: "tmux",
        tmuxSession: "bots",
        tmuxWindow: "x",
      });
      expect(health.state).toBe("stopped");
    });

    test("returns 'running' when window exists in session", async () => {
      const { runShell } = makeMockShell(
        new Map<string, MockResponse>([
          ["has-session", { exitCode: 0 }],
          ["list-windows", { exitCode: 0, stdout: "myproj\nother\n" }],
        ]),
      );
      const driver = makeDriver(runShell);
      const health = await driver.health({
        driver: "tmux",
        tmuxSession: "bots",
        tmuxWindow: "myproj",
      });
      expect(health.state).toBe("running");
    });

    test("returns 'stopped' when window not in list", async () => {
      const { runShell } = makeMockShell(
        new Map<string, MockResponse>([
          ["has-session", { exitCode: 0 }],
          ["list-windows", { exitCode: 0, stdout: "other1\nother2\n" }],
        ]),
      );
      const driver = makeDriver(runShell);
      const health = await driver.health({
        driver: "tmux",
        tmuxSession: "bots",
        tmuxWindow: "missing",
      });
      expect(health.state).toBe("stopped");
    });

    test("returns 'running' (session-level) when no window on handle", async () => {
      const { runShell } = makeMockShell(
        new Map([["has-session", { exitCode: 0 }]]),
      );
      const driver = makeDriver(runShell);
      const health = await driver.health({
        driver: "tmux",
        tmuxSession: "bots",
      });
      expect(health.state).toBe("running");
    });
  });

  describe("sendInput()", () => {
    test("esc action sends Escape and tolerates no-confirm path", async () => {
      const { runShell, calls } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await driver.sendInput(
        { driver: "tmux", tmuxSession: "bots", tmuxWindow: "x" },
        { kind: "esc" },
      );
      expect(calls.some((c) => c.includes("Escape"))).toBe(true);
    });

    test("esc action sends Enter when confirm dialog appears", async () => {
      const { runShell, calls } = makeMockShell(
        new Map<string, MockResponse>([
          // capture-pane returns the confirm dialog so the driver issues a
          // follow-up `send-keys "" Enter`.
          [
            "capture-pane",
            { exitCode: 0, stdout: "press enter to confirm or esc to cancel" },
          ],
        ]),
      );
      const driver = makeDriver(runShell);
      await driver.sendInput(
        { driver: "tmux", tmuxSession: "bots", tmuxWindow: "x" },
        { kind: "esc" },
      );
      expect(calls.some((c) => c.includes("Escape"))).toBe(true);
      expect(calls.some((c) => c.includes("Enter"))).toBe(true);
    });

    test("close_editor sends Escape then :q!", async () => {
      const { runShell, calls } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await driver.sendInput(
        { driver: "tmux", tmuxSession: "bots", tmuxWindow: "x" },
        { kind: "close_editor" },
      );
      expect(calls.some((c) => c.includes("Escape"))).toBe(true);
      expect(calls.some((c) => c.includes(":q!"))).toBe(true);
    });

    test("text action escapes double quotes", async () => {
      const { runShell, calls } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await driver.sendInput(
        { driver: "tmux", tmuxSession: "bots", tmuxWindow: "x" },
        { kind: "text", text: 'hello "world"' },
      );
      expect(calls.some((c) => c.includes('hello \\"world\\"'))).toBe(true);
    });

    test("text action escapes backtick, dollar, and backslash", async () => {
      const { runShell, calls } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await driver.sendInput(
        { driver: "tmux", tmuxSession: "bots", tmuxWindow: "x" },
        { kind: "text", text: "boom `id` $(rm -rf /) $HOME \\path" },
      );
      const sendKeys = calls.find(
        (c) => c.includes("send-keys") && c.includes("boom"),
      );
      expect(sendKeys).toBeDefined();
      // Backticks → \`id\`
      expect(sendKeys).toContain("\\`id\\`");
      // Dollar signs → \$(...) and \$HOME
      expect(sendKeys).toContain("\\$(rm -rf /)");
      expect(sendKeys).toContain("\\$HOME");
      // Backslash → \\ (TS source `\\\\` is two backslashes in the runtime string)
      expect(sendKeys).toContain("\\\\path");
    });

    test("rejects malicious tmuxSession on the handle (shell injection)", async () => {
      const { runShell } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await expect(
        driver.sendInput(
          { driver: "tmux", tmuxSession: "bots; rm -rf /", tmuxWindow: "x" },
          { kind: "esc" },
        ),
      ).rejects.toThrow(/invalid tmuxSession/);
    });

    test("rejects invalid window name", async () => {
      const { runShell } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await expect(
        driver.sendInput(
          { driver: "tmux", tmuxSession: "bots", tmuxWindow: "x;y" },
          { kind: "esc" },
        ),
      ).rejects.toThrow(/invalid/i);
    });

    test("key action allows chord forms like C-c", async () => {
      const { runShell, calls } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await driver.sendInput(
        { driver: "tmux", tmuxSession: "bots", tmuxWindow: "x" },
        { kind: "key", key: "C-c" },
      );
      expect(calls.some((c) => c.includes("C-c"))).toBe(true);
    });

    test("key action rejects shell-special characters", async () => {
      const { runShell } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await expect(
        driver.sendInput(
          { driver: "tmux", tmuxSession: "bots", tmuxWindow: "x" },
          { kind: "key", key: 'rm; ls"' },
        ),
      ).rejects.toThrow(/invalid key/i);
    });
  });

  describe("snapshot()", () => {
    test("captures pane lines", async () => {
      const { runShell } = makeMockShell(
        new Map([
          ["capture-pane", { exitCode: 0, stdout: "line 1\nline 2\nline 3" }],
        ]),
      );
      const driver = makeDriver(runShell);
      const snap = await driver.snapshot({
        driver: "tmux",
        tmuxSession: "bots",
        tmuxWindow: "x",
      });
      expect(snap.lines).toContain("line 1");
      expect(snap.lines.length).toBeGreaterThanOrEqual(3);
    });

    test("uses -S for scroll-back when lines option set", async () => {
      const { runShell, calls } = makeMockShell(
        new Map([["capture-pane", { exitCode: 0, stdout: "" }]]),
      );
      const driver = makeDriver(runShell);
      await driver.snapshot(
        { driver: "tmux", tmuxSession: "bots", tmuxWindow: "x" },
        { lines: 100 },
      );
      expect(calls.some((c) => c.includes("-S -100"))).toBe(true);
    });

    test("visible-only does not use -S", async () => {
      const { runShell, calls } = makeMockShell(
        new Map([["capture-pane", { exitCode: 0, stdout: "" }]]),
      );
      const driver = makeDriver(runShell);
      await driver.snapshot(
        { driver: "tmux", tmuxSession: "bots", tmuxWindow: "x" },
        { visibleOnly: true },
      );
      expect(
        calls.find((c) => c.includes("capture-pane") && c.includes("-S")),
      ).toBeUndefined();
    });

    test("rejects invalid window name", async () => {
      const { runShell } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await expect(
        driver.snapshot({
          driver: "tmux",
          tmuxSession: "bots",
          tmuxWindow: "x;y",
        }),
      ).rejects.toThrow(/invalid/i);
    });

    test("rejects non-integer lines value (shell injection guard)", async () => {
      // `lines` is typed `number | undefined`, but at runtime the value can
      // come from a JSON payload or coerced caller. A value like "100; reboot"
      // would interpolate raw into the shell — guard must reject it.
      const { runShell } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await expect(
        driver.snapshot(
          { driver: "tmux", tmuxSession: "bots", tmuxWindow: "x" },
          { lines: "100; reboot" as unknown as number },
        ),
      ).rejects.toThrow(/invalid lines/);
    });

    test("rejects out-of-range lines value", async () => {
      const { runShell } = makeMockShell(new Map());
      const driver = makeDriver(runShell);
      await expect(
        driver.snapshot(
          { driver: "tmux", tmuxSession: "bots", tmuxWindow: "x" },
          { lines: 0 },
        ),
      ).rejects.toThrow(/invalid lines/);
      await expect(
        driver.snapshot(
          { driver: "tmux", tmuxSession: "bots", tmuxWindow: "x" },
          { lines: 1_000_000 },
        ),
      ).rejects.toThrow(/invalid lines/);
    });
  });
});
