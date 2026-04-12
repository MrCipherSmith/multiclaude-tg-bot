import { describe, test, expect } from "bun:test";

/**
 * tmux-watchdog — pure unit tests.
 *
 * No I/O, no database, no tmux calls. Tests cover:
 *   - stripAnsi: ANSI escape code stripping
 *   - detectPermissionPrompt: Claude Code MCP tool permission dialog detection
 *   - detectSpinner: active thinking/spinner line detection
 *   - detectEditor: vim / nano blocking session detection
 *   - detectCredential: git/ssh credential prompt detection
 *   - detectCrash: run-cli.sh non-zero exit detection
 *   - canAlert / markAlerted: cooldown logic
 *   - tmux_send_keys action mapping: esc→key 1/2, deny→key 3
 */

// ---------------------------------------------------------------------------
// Pure functions copied from scripts/tmux-watchdog.ts
// ---------------------------------------------------------------------------

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/[\x00-\x09\x0b-\x1f]/g, "");
}

const PERM_SIGNAL_RE = /do you want to proceed\?/i;
const PERM_CHOICE_RE = /❯\s*1[.)]\s*yes/i;
const SPINNER_RE     = /^[·✶✻]\s+.+/;
const VIM_RE         = /--\s*(INSERT|NORMAL|VISUAL|REPLACE)\s*--/;
const NANO_RE        = /\^G\s*(Get Help|Help)|\^X\s*(Exit|Close)/i;
const CREDENTIAL_RE  = /(password|passphrase|username for\s+['"]https?:|token).*:\s*$/i;
const CRASH_RE       = /\[run-cli\] Exited with code ([1-9]\d*)/;

function detectPermissionPrompt(
  lines: string[],
): { toolName: string; description: string } | null {
  let signalIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PERM_SIGNAL_RE.test(lines[i])) { signalIdx = i; break; }
  }
  if (signalIdx === -1) return null;

  const after = lines.slice(signalIdx, Math.min(lines.length, signalIdx + 6));
  if (!after.some((l) => PERM_CHOICE_RE.test(l))) return null;

  const ctx = lines.slice(Math.max(0, signalIdx - 25), signalIdx);
  let toolName = "";
  for (let i = ctx.length - 1; i >= 0; i--) {
    const line = ctx[i].trim();
    const m1 = line.match(/\b(mcp__[\w]+__[\w]+)\b/);
    if (m1) { toolName = m1[1]; break; }
    const m2 = line.match(/\b(\w+)\s*-\s*([\w_]+)\s*\(MCP\)/i);
    if (m2) { toolName = `mcp__${m2[1]}__${m2[2]}`; break; }
    const m3 = line.match(/(\w+)\s+wants\s+to\s+use\s+([\w_]+)/i);
    if (m3) { toolName = `mcp__${m3[1]}__${m3[2]}`; break; }
  }
  if (!toolName) toolName = "mcp:unknown";

  const description = ctx
    .map((l) => l.trim())
    .filter((l) => l && !/^[╭╰│─ ]+$/.test(l) && !/^[·✶✻●⎿]/.test(l))
    .slice(-4)
    .join("\n")
    .trim() || toolName;

  return { toolName, description };
}

function detectSpinner(lines: string[]): boolean {
  return lines.slice(-10).some((l) => SPINNER_RE.test(l.trim()));
}

function detectEditor(lines: string[]): "vim" | "nano" | null {
  for (const l of lines.slice(-20)) {
    if (VIM_RE.test(l))  return "vim";
    if (NANO_RE.test(l)) return "nano";
  }
  return null;
}

function detectCredential(lines: string[]): string | null {
  for (const l of lines.slice(-5)) {
    const m = l.trim().match(CREDENTIAL_RE);
    if (m) return m[0].trim();
  }
  return null;
}

function detectCrash(lines: string[]): number | null {
  for (const l of lines.slice(-10)) {
    const m = l.match(CRASH_RE);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

type AlertKind = "stall" | "editor" | "credential" | "crash";
interface WindowState {
  sessionId: number;
  alerts: Partial<Record<AlertKind, number>>;
}

function canAlert(state: WindowState, kind: AlertKind, cooldownMs: number): boolean {
  const last = state.alerts[kind];
  return !last || Date.now() - last > cooldownMs;
}

function markAlerted(state: WindowState, kind: AlertKind): void {
  state.alerts[kind] = Date.now();
}

/** Maps permission behavior to tmux key number (mirrors admin-daemon tmux_send_keys esc action) */
function behaviorToKey(behavior: string): string {
  return behavior === "deny" ? "3" : behavior === "always" ? "2" : "1";
}

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

describe("stripAnsi", () => {
  test("strips basic SGR escape codes", () => {
    expect(stripAnsi("\x1b[32mGreen\x1b[0m")).toBe("Green");
  });

  test("strips OSC sequences", () => {
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
  });

  test("leaves plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  test("strips nested codes", () => {
    expect(stripAnsi("\x1b[1m\x1b[33mBold yellow\x1b[0m")).toBe("Bold yellow");
  });
});

// ---------------------------------------------------------------------------
// detectPermissionPrompt
// ---------------------------------------------------------------------------

describe("detectPermissionPrompt — basic detection", () => {
  test("returns null when no signal present", () => {
    const lines = ["● Bash(ls)", "  ⎿ Read 3 files", "· Thinking..."];
    expect(detectPermissionPrompt(lines)).toBeNull();
  });

  test("returns null when signal present but choice line missing", () => {
    const lines = [
      "  mcp__docker__docker_container_list",
      "  Do you want to proceed?",
      "  1. Yes",  // no ❯ prefix — not the active choice
    ];
    expect(detectPermissionPrompt(lines)).toBeNull();
  });

  test("detects prompt with ❯ 1. Yes", () => {
    const lines = [
      "  mcp__docker__docker_container_list",
      "  Do you want to proceed?",
      "  ❯ 1. Yes",
      "    2. Yes, and don't ask again",
      "    3. No",
    ];
    const result = detectPermissionPrompt(lines);
    expect(result).not.toBeNull();
  });

  test("detects prompt case-insensitively", () => {
    const lines = [
      "  DO YOU WANT TO PROCEED?",
      "  ❯ 1. Yes",
    ];
    expect(detectPermissionPrompt(lines)).not.toBeNull();
  });
});

describe("detectPermissionPrompt — tool name extraction", () => {
  test("extracts mcp__server__tool format", () => {
    const lines = [
      "  ● mcp__docker__docker_container_list (MCP)",
      "  Do you want to proceed?",
      "  ❯ 1. Yes",
    ];
    const result = detectPermissionPrompt(lines);
    expect(result?.toolName).toBe("mcp__docker__docker_container_list");
  });

  test("extracts 'server - tool_name (MCP)' format", () => {
    const lines = [
      "  docker - docker_container_list (MCP)",
      "  Do you want to proceed?",
      "  ❯ 1. Yes",
    ];
    const result = detectPermissionPrompt(lines);
    expect(result?.toolName).toBe("mcp__docker__docker_container_list");
  });

  test("extracts 'server wants to use tool_name' format", () => {
    const lines = [
      "  github wants to use create_issue",
      "  Do you want to proceed?",
      "  ❯ 1. Yes",
    ];
    const result = detectPermissionPrompt(lines);
    expect(result?.toolName).toBe("mcp__github__create_issue");
  });

  test("falls back to mcp:unknown when tool name unrecognized", () => {
    const lines = [
      "  Some vague tool description",
      "  Do you want to proceed?",
      "  ❯ 1. Yes",
    ];
    const result = detectPermissionPrompt(lines);
    expect(result?.toolName).toBe("mcp:unknown");
  });

  test("picks the nearest tool name above the signal", () => {
    const lines = [
      "  ● mcp__github__list_issues (MCP)",
      "  · Thinking...",
      "  ● mcp__docker__docker_ps (MCP)",   // closest — should win
      "  Do you want to proceed?",
      "  ❯ 1. Yes",
    ];
    const result = detectPermissionPrompt(lines);
    expect(result?.toolName).toBe("mcp__docker__docker_ps");
  });
});

describe("detectPermissionPrompt — only detects active prompts", () => {
  test("old prompt text without ❯ choice is ignored", () => {
    // The output monitor scrolls; an old answered prompt might still be in buffer
    const lines = [
      "  Do you want to proceed?",
      "  1. Yes",        // already answered — no ❯
      "  · Thinking...", // Claude continued working
    ];
    expect(detectPermissionPrompt(lines)).toBeNull();
  });

  test("detects the last prompt when multiple appear in buffer", () => {
    const lines = [
      "  mcp__docker__docker_container_list",
      "  Do you want to proceed?",
      "  1. Yes",          // first already answered
      "  ·  Working...",
      "  mcp__github__add_issue_comment",
      "  Do you want to proceed?",
      "  ❯ 1. Yes",        // second is active
    ];
    const result = detectPermissionPrompt(lines);
    expect(result).not.toBeNull();
    expect(result?.toolName).toBe("mcp__github__add_issue_comment");
  });
});

// ---------------------------------------------------------------------------
// detectSpinner
// ---------------------------------------------------------------------------

describe("detectSpinner", () => {
  test("detects · spinner", () => {
    expect(detectSpinner(["· Brewing… (10s · ↓ 386 tokens · thinking)"])).toBe(true);
  });

  test("detects ✶ spinner", () => {
    expect(detectSpinner(["✶ Processing..."])).toBe(true);
  });

  test("detects ✻ spinner", () => {
    expect(detectSpinner(["✻ Loading context"])).toBe(true);
  });

  test("returns false for tool call lines", () => {
    expect(detectSpinner(["● Bash(ls -la)"])).toBe(false);
  });

  test("returns false for empty output", () => {
    expect(detectSpinner([])).toBe(false);
  });

  test("only checks last 10 lines", () => {
    // spinner is in line 0 (beyond the 10-line window from the end)
    const lines = [
      "· Old spinner",
      "", "", "", "", "", "", "", "", "", // 9 more lines
      "  ❯",  // prompt at end
    ];
    expect(detectSpinner(lines)).toBe(false);
  });

  test("detects spinner in the last 10 lines", () => {
    const lines = Array(5).fill("") as string[];
    lines.push("· Working...");
    expect(detectSpinner(lines)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectEditor
// ---------------------------------------------------------------------------

describe("detectEditor — vim", () => {
  test("detects INSERT mode", () => {
    expect(detectEditor(["-- INSERT --"])).toBe("vim");
  });

  test("detects NORMAL mode", () => {
    expect(detectEditor(["-- NORMAL --"])).toBe("vim");
  });

  test("detects VISUAL mode", () => {
    expect(detectEditor(["-- VISUAL --"])).toBe("vim");
  });

  test("detects REPLACE mode", () => {
    expect(detectEditor(["-- REPLACE --"])).toBe("vim");
  });
});

describe("detectEditor — nano", () => {
  test("detects nano via ^G Get Help", () => {
    expect(detectEditor(["^G Get Help  ^X Exit  ^R Read File"])).toBe("nano");
  });

  test("detects nano via ^X Exit", () => {
    expect(detectEditor(["^X Exit"])).toBe("nano");
  });
});

describe("detectEditor — no editor", () => {
  test("returns null for normal Claude output", () => {
    const lines = ["· Thinking...", "● Bash(git status)", "  ⎿ Read 3 files"];
    expect(detectEditor(lines)).toBeNull();
  });

  test("returns null for empty output", () => {
    expect(detectEditor([])).toBeNull();
  });

  test("only checks last 20 lines", () => {
    // vim line is at index 0, well beyond the 20-line window
    const lines = Array(25).fill("  normal output") as string[];
    lines[0] = "-- INSERT --";
    expect(detectEditor(lines)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectCredential
// ---------------------------------------------------------------------------

describe("detectCredential", () => {
  test("detects Password: prompt", () => {
    const result = detectCredential(["Password:"]);
    expect(result).not.toBeNull();
    expect(result).toContain("Password");
  });

  test("detects git https Username prompt", () => {
    const result = detectCredential(["Username for 'https://github.com':"]);
    expect(result).not.toBeNull();
  });

  test("detects SSH passphrase prompt", () => {
    const result = detectCredential(["Enter passphrase for key '/home/user/.ssh/id_rsa':"]);
    expect(result).not.toBeNull();
  });

  test("detects Token prompt", () => {
    const result = detectCredential(["Token:"]);
    expect(result).not.toBeNull();
  });

  test("returns null for normal output", () => {
    expect(detectCredential(["● Bash(git push origin main)"])).toBeNull();
  });

  test("returns null for empty lines", () => {
    expect(detectCredential([])).toBeNull();
  });

  test("only checks last 5 lines (ignores old credential prompts in buffer)", () => {
    const lines = [
      "Password:",        // index 0 — too old, beyond 5-line window
      "", "", "", "", "", // 5 more lines
      "· Thinking...",
    ];
    expect(detectCredential(lines)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectCrash
// ---------------------------------------------------------------------------

describe("detectCrash", () => {
  test("detects exit code 1", () => {
    expect(detectCrash(["[run-cli] Exited with code 1 at 2026-04-12 10:00:00"])).toBe(1);
  });

  test("detects exit code 127 (command not found)", () => {
    expect(detectCrash(["[run-cli] Exited with code 127"])).toBe(127);
  });

  test("detects exit code 137 (OOM kill)", () => {
    expect(detectCrash(["[run-cli] Exited with code 137"])).toBe(137);
  });

  test("ignores clean exit (code 0 is not a crash)", () => {
    // CRASH_RE only matches non-zero codes ([1-9]\d*)
    expect(detectCrash(["[run-cli] Exited with code 0"])).toBeNull();
  });

  test("returns null for normal output", () => {
    expect(detectCrash(["· Thinking...", "● Bash(ls)"])).toBeNull();
  });

  test("returns null for empty output", () => {
    expect(detectCrash([])).toBeNull();
  });

  test("only checks last 10 lines", () => {
    const lines = Array(15).fill("  normal") as string[];
    lines[0] = "[run-cli] Exited with code 1";
    expect(detectCrash(lines)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Alert cooldown — canAlert / markAlerted
// ---------------------------------------------------------------------------

describe("canAlert / markAlerted", () => {
  function makeState(): WindowState {
    return { sessionId: 1, alerts: {} };
  }

  test("canAlert returns true when no alert has been sent", () => {
    const state = makeState();
    expect(canAlert(state, "stall", 60_000)).toBe(true);
  });

  test("canAlert returns false immediately after markAlerted", () => {
    const state = makeState();
    markAlerted(state, "stall");
    expect(canAlert(state, "stall", 60_000)).toBe(false);
  });

  test("canAlert returns true after cooldown expires", () => {
    const state = makeState();
    // Fake a past alert time well beyond the cooldown
    state.alerts.stall = Date.now() - 120_000; // 2 min ago
    expect(canAlert(state, "stall", 60_000)).toBe(true); // cooldown is 1 min
  });

  test("canAlert returns false when still within cooldown", () => {
    const state = makeState();
    state.alerts.stall = Date.now() - 30_000; // 30s ago
    expect(canAlert(state, "stall", 60_000)).toBe(false); // cooldown is 1 min
  });

  test("different alert kinds are independent", () => {
    const state = makeState();
    markAlerted(state, "stall");
    expect(canAlert(state, "editor", 60_000)).toBe(true);
    expect(canAlert(state, "stall",  60_000)).toBe(false);
  });

  test("resetting alert (set to undefined) re-enables canAlert", () => {
    const state = makeState();
    markAlerted(state, "stall");
    state.alerts.stall = undefined;
    expect(canAlert(state, "stall", 60_000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// behaviorToKey — Telegram response → tmux key mapping
// ---------------------------------------------------------------------------

describe("behaviorToKey — permission response to tmux key", () => {
  test("allow → 1 (Yes once)", () => {
    expect(behaviorToKey("allow")).toBe("1");
  });

  test("always → 2 (Yes, and don't ask again)", () => {
    expect(behaviorToKey("always")).toBe("2");
  });

  test("deny → 3 (No)", () => {
    expect(behaviorToKey("deny")).toBe("3");
  });

  test("unknown behavior falls back to allow (key 1)", () => {
    // Defensive: anything that isn't deny/always should allow
    expect(behaviorToKey("unexpected")).toBe("1");
  });
});
