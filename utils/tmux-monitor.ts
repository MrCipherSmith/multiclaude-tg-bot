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

/** Check if tmux is available and session exists */
async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "has-session", "-t", sessionName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** Capture last N lines from tmux pane */
async function captureTmux(sessionName: string, lines = 15): Promise<string> {
  try {
    const proc = Bun.spawn(
      ["tmux", "capture-pane", "-t", sessionName, "-p", "-S", `-${lines}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output;
  } catch {
    return "";
  }
}

/** Parse Claude Code terminal output into a status string */
function parseStatus(output: string): string | null {
  const lines = output.split("\n").filter((l) => l.trim());

  // Scan from bottom up for the most recent activity
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();

    // Skip UI chrome
    if (line.startsWith("─") || line.startsWith("❯") || line.startsWith("?") || line === "") continue;
    if (line.includes("for shortcuts") || line.includes("esc to interrupt") || line.includes("ctrl+o")) continue;

    // Spinner/thinking lines: · Brewing… (10s · ↓ 386 tokens · thinking)
    const spinnerMatch = line.match(/^[·✶✻⏳]\s+(.+?)(?:\s+\((.+?)\))?$/);
    if (spinnerMatch) {
      const action = spinnerMatch[1].replace(/…$/, "");
      const details = spinnerMatch[2] ?? "";
      if (details) return `${action} (${details})`;
      return action;
    }

    // Tool call: ● ToolName(args) or ● Explore(description)
    const toolMatch = line.match(/^●\s+(.+)/);
    if (toolMatch) {
      const toolCall = toolMatch[1];

      // Skip our own MCP reply calls
      if (toolCall.includes("reply (MCP)") || toolCall.includes("update_status")) continue;

      // Parse tool name and args
      const parsed = toolCall.match(/^(\w+)\((.+)\)$/);
      if (parsed) {
        const [, tool, args] = parsed;
        const shortArgs = args.length > 60 ? args.slice(0, 60) + "..." : args;
        return `${tool}: ${shortArgs}`;
      }

      // MCP tool call: claude-bot - tool_name (MCP)(args)
      const mcpMatch = toolCall.match(/^\S+\s*-\s*(\w+)\s*\(MCP\)/);
      if (mcpMatch) {
        return `MCP: ${mcpMatch[1]}`;
      }

      // Agent/Explore with description
      const agentMatch = toolCall.match(/^(Explore|Agent)\((.+)\)/);
      if (agentMatch) {
        return `${agentMatch[1]}: ${agentMatch[2].slice(0, 60)}`;
      }

      // Simple tool reference
      return toolCall.slice(0, 70);
    }

    // Sub-operation: ⎿ Read(file), Search(pattern)
    const subMatch = line.match(/^⎿\s+(.+)/);
    if (subMatch) {
      const sub = subMatch[1];
      const subParsed = sub.match(/^(\w+)\((.+)\)/);
      if (subParsed) {
        return `  └ ${subParsed[1]}: ${subParsed[2].slice(0, 50)}`;
      }
      // "Read 2 files, listed 1 directory"
      if (sub.match(/^(Read|Search|Grep|Glob|Write|Edit)\s/)) {
        return `  └ ${sub.slice(0, 60)}`;
      }
    }

    // "+N more tool uses"
    if (line.match(/^\+\d+ more tool uses/)) {
      return line;
    }
  }

  return null;
}

/** Start monitoring a tmux session, calling onStatus with updates */
export async function startTmuxMonitor(
  sessionName: string,
  onStatus: StatusCallback,
): Promise<TmuxMonitorHandle | null> {
  const exists = await tmuxSessionExists(sessionName);
  if (!exists) return null;

  let running = true;
  let lastStatus = "";

  const poll = async () => {
    while (running) {
      try {
        const output = await captureTmux(sessionName);
        const status = parseStatus(output);

        if (status && status !== lastStatus) {
          lastStatus = status;
          onStatus(status);
        }
      } catch {}

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  };

  poll();

  return {
    stop: () => { running = false; },
  };
}
