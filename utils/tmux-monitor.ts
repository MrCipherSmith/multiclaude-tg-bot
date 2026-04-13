/**
 * Monitors tmux pane output from Claude Code CLI sessions.
 * Parses tool calls, thinking status, and progress from terminal output.
 * Forwards parsed status to Telegram via callback.
 */

const POLL_INTERVAL_MS = 2000;

export interface TmuxMonitorHandle {
  stop: () => void;
}

type StatusCallback = (status: string) => void;

/** Resolve actual tmux target for a project name.
 *  Tries:
 *  1. Exact session: <name>
 *  2. Window in "bots" session: bots:<name> (prefix match — tmux accepts partial window names)
 *  Returns the resolved target string or null if not found.
 */
async function resolveTmuxTarget(projectName: string): Promise<string | null> {
  // 1. Try exact session name
  try {
    const proc = Bun.spawn(["tmux", "has-session", "-t", projectName], { stdout: "pipe", stderr: "pipe" });
    if ((await proc.exited) === 0) return projectName;
  } catch {}

  // 2. Try as window in "bots" session (helyx up uses bots:<window>)
  const botsTarget = `bots:${projectName}`;
  try {
    const proc = Bun.spawn(["tmux", "has-session", "-t", botsTarget], { stdout: "pipe", stderr: "pipe" });
    if ((await proc.exited) === 0) return botsTarget;
  } catch {}

  // 3. List all windows in "bots" and find one that starts with projectName
  try {
    const proc = Bun.spawn(
      ["tmux", "list-windows", "-t", "bots", "-F", "#W"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const window = out.split("\n").map((l) => l.trim()).find((w) => w && w.startsWith(projectName));
    if (window) return `bots:${window}`;
  } catch {}

  return null;
}

/** Capture current visible screen from tmux pane (no scrollback).
 *  Current activity (spinner, tool calls) is always at the bottom of the
 *  visible screen — scrollback only adds stale historical content that
 *  causes ghost detections and inflates the status with old tool calls.
 */
async function captureTmux(target: string): Promise<string> {
  try {
    const proc = Bun.spawn(
      ["tmux", "capture-pane", "-t", target, "-p"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output;
  } catch {
    return "";
  }
}

// UI chrome patterns to skip
const SKIP_PATTERNS = [
  /^─+$/,
  /^❯/,
  /^\? for shortcuts/,
  /^esc to interrupt/,
  /^Enter to confirm/,
  /ctrl\+[a-z] to/,
  /^\s*$/,
];

function isChrome(line: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(line.trim()));
}

/** Parse a single line into a status entry or null */
function parseLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || isChrome(trimmed)) return null;

  // Spinner/thinking: · Brewing… (10s · ↓ 386 tokens · thinking)
  const spinnerMatch = trimmed.match(/^[·✶✻]\s+(.+)/);
  if (spinnerMatch) {
    return `⏳ ${spinnerMatch[1]}`;
  }

  // Tool call: ● ToolName(args)
  const toolMatch = trimmed.match(/^●\s+(.+)/);
  if (toolMatch) {
    const call = toolMatch[1];
    if (call.includes("reply (MCP)") || call.includes("update_status")) return null;

    // Agent/Explore
    const agentMatch = call.match(/^(Explore|Agent)\((.+)\)/);
    if (agentMatch) return `● ${agentMatch[1]}: ${agentMatch[2].slice(0, 50)}`;

    // Bash(command)
    const bashMatch = call.match(/^Bash\((.+)\)$/);
    if (bashMatch) return `● $ ${bashMatch[1].slice(0, 60)}`;

    // Read/Edit/Write(path)
    const fileMatch = call.match(/^(Read|Edit|Write)\((.+)\)$/);
    if (fileMatch) return `● ${fileMatch[1]}: ${fileMatch[2].split("/").pop()}`;

    // MCP tool
    const mcpMatch = call.match(/^\S+\s*-\s*(\w+)\s*\(MCP\)/);
    if (mcpMatch) return `● MCP: ${mcpMatch[1]}`;

    return `● ${call.slice(0, 60)}`;
  }

  // Sub-operation: ⎿ details
  const subMatch = trimmed.match(/^⎿\s+(.+)/);
  if (subMatch) {
    const sub = subMatch[1];
    // Search/Read/Grep with args
    const subTool = sub.match(/^(\w+)\((.+)\)/);
    if (subTool) return `  └ ${subTool[1]}: ${subTool[2].slice(0, 50)}`;

    // "Read 2 files, listed 1 directory"
    if (sub.match(/^(Read|Search|Grep|Glob|Write|Edit)\s/)) return `  └ ${sub.slice(0, 55)}`;

    // Error output
    if (sub.startsWith("Error:")) return `  └ ❌ ${sub.slice(0, 55)}`;

    return `  └ ${sub.slice(0, 55)}`;
  }

  // "+N more tool uses"
  if (trimmed.match(/^\+\d+ more tool uses/)) return `  ${trimmed}`;

  // Sub-agent lines: "Running N agents…" or "Running agent…"
  if (trimmed.match(/^Running \d+ agents?/)) return `🔄 ${trimmed}`;

  // Agent tree: ├─ Name · N tool uses · Nk tokens
  const agentTreeMatch = trimmed.match(/^[├└│][\s─]+(.+)/);
  if (agentTreeMatch) {
    const content = agentTreeMatch[1];
    // Sub-agent status: ⎿ Done / Update: file.ts
    if (content.match(/^⎿\s+/)) {
      const sub = content.replace(/^⎿\s+/, "");
      return `  │ ⎿ ${sub.slice(0, 55)}`;
    }
    // Agent name with stats
    return `  ${trimmed.slice(0, 65)}`;
  }

  // Tip line
  if (trimmed.startsWith("Tip:")) return null;

  return null;
}

/** Parse Claude Code terminal output into a multi-line status block */
function parseStatus(output: string): string | null {
  const lines = output.split("\n");
  const parsed: string[] = [];

  // Scan from bottom up, collect activity lines
  for (let i = lines.length - 1; i >= 0; i--) {
    const result = parseLine(lines[i]);
    if (result) {
      parsed.unshift(result);
      // Collect up to 12 lines (enough for agent tree with sub-agents)
      if (parsed.length >= 12) break;
    }
    // Stop at prompt line (previous command boundary)
    if (lines[i].trim().startsWith("❯") && parsed.length > 0) break;
  }

  if (parsed.length === 0) return null;
  return parsed.join("\n");
}

/** Strip elapsed time/token counters from spinner lines for comparison.
 *  Prevents re-sending status every 2s just because the timer incremented.
 *  Example: "⏳ Brewing… (10s · ↓ 386 tokens · thinking)" →
 *           "⏳ Brewing… ( · ↓  tokens · thinking)"
 */
export function normalizeForComparison(s: string): string {
  return s
    .replace(/\d+m\s*\d+s/g, "") // "1m 23s"
    .replace(/\d+s/g, "")         // "10s"
    .replace(/↓\s*\d+\s*tokens/g, "↓ tokens") // "↓ 386 tokens"
    .replace(/↑\s*\d+\s*tokens/g, "↑ tokens") // "↑ 123 tokens"
    .replace(/\(\s*[·\s]*\)/g, "")             // empty parens "(  · )"
    .trim();
}

/** Start monitoring a tmux session, calling onStatus with updates */
export async function startTmuxMonitor(
  projectName: string,
  onStatus: StatusCallback,
): Promise<TmuxMonitorHandle | null> {
  const target = await resolveTmuxTarget(projectName);
  if (!target) return null;

  let running = true;
  let lastStatus = "";

  const poll = async () => {
    while (running) {
      try {
        const output = await captureTmux(target);
        const status = parseStatus(output);

        if (status && normalizeForComparison(status) !== normalizeForComparison(lastStatus)) {
          lastStatus = status;
          onStatus(status);
        }
      } catch {}

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  };

  poll().catch((err) => console.error("[tmux-monitor] fatal error:", err));

  return {
    stop: () => { running = false; },
  };
}
