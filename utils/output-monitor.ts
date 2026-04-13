/**
 * File-based output monitor for Claude CLI sessions.
 * Alternative to tmux-monitor — reads Claude's terminal output
 * captured to a file via `script` command.
 *
 * Uses the same interface as tmux-monitor for drop-in replacement.
 */

import { existsSync } from "fs";
import { normalizeForComparison } from "./tmux-monitor.ts";

const POLL_INTERVAL_MS = 2000;
const TAIL_LINES = 40;

export interface OutputMonitorHandle {
  stop: () => void;
}

type StatusCallback = (status: string) => void;

// Re-use tmux-monitor's parsing logic for terminal output
const SKIP_PATTERNS = [
  /^─+$/,
  /^❯/,
  /^\? for shortcuts/,
  /^esc to interrupt/,
  /^Enter to confirm/,
  /ctrl\+[a-z] to/,
  /^\s*$/,
  /^\x1b/,           // Escape sequences
  /^Script started/,  // script command header
  /^Script done/,     // script command footer
];

function isChrome(line: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(line.trim()));
}

/** Strip ANSI escape codes from terminal output */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
            .replace(/\x1b\][^\x07]*\x07/g, "")
            .replace(/[\x00-\x09\x0b-\x1f]/g, "");
}

function parseLine(line: string): string | null {
  const trimmed = stripAnsi(line).trim();
  if (!trimmed || isChrome(trimmed)) return null;

  // Spinner/thinking
  const spinnerMatch = trimmed.match(/^[·✶✻]\s+(.+)/);
  if (spinnerMatch) return `⏳ ${spinnerMatch[1]}`;

  // Tool call
  const toolMatch = trimmed.match(/^●\s+(.+)/);
  if (toolMatch) {
    const call = toolMatch[1];
    if (call.includes("reply (MCP)") || call.includes("update_status")) return null;

    const agentMatch = call.match(/^(Explore|Agent)\((.+)\)/);
    if (agentMatch) return `● ${agentMatch[1]}: ${agentMatch[2].slice(0, 50)}`;

    const bashMatch = call.match(/^Bash\((.+)\)$/);
    if (bashMatch) return `● $ ${bashMatch[1].slice(0, 60)}`;

    const fileMatch = call.match(/^(Read|Edit|Write)\((.+)\)$/);
    if (fileMatch) return `● ${fileMatch[1]}: ${fileMatch[2].split("/").pop()}`;

    const mcpMatch = call.match(/^\S+\s*-\s*(\w+)\s*\(MCP\)/);
    if (mcpMatch) return `● MCP: ${mcpMatch[1]}`;

    return `● ${call.slice(0, 60)}`;
  }

  // Sub-operation
  const subMatch = trimmed.match(/^⎿\s+(.+)/);
  if (subMatch) {
    const sub = subMatch[1];
    if (sub.startsWith("Error:")) return `  └ ❌ ${sub.slice(0, 55)}`;
    const subTool = sub.match(/^(\w+)\((.+)\)/);
    if (subTool) return `  └ ${subTool[1]}: ${subTool[2].slice(0, 50)}`;
    if (sub.match(/^(Read|Search|Grep|Glob|Write|Edit)\s/)) return `  └ ${sub.slice(0, 55)}`;
    return `  └ ${sub.slice(0, 55)}`;
  }

  if (trimmed.match(/^\+\d+ more tool uses/)) return `  ${trimmed}`;

  // Sub-agent lines
  if (trimmed.match(/^Running \d+ agents?/)) return `🔄 ${trimmed}`;

  const agentTreeMatch = trimmed.match(/^[├└│][\s─]+(.+)/);
  if (agentTreeMatch) {
    const content = agentTreeMatch[1];
    if (content.match(/^⎿\s+/)) {
      const sub = content.replace(/^⎿\s+/, "");
      return `  │ ⎿ ${sub.slice(0, 55)}`;
    }
    return `  ${trimmed.slice(0, 65)}`;
  }

  if (trimmed.startsWith("Tip:")) return null;

  return null;
}

function parseStatus(output: string): string | null {
  const lines = output.split("\n");
  const parsed: string[] = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    const result = parseLine(lines[i]);
    if (result) {
      parsed.unshift(result);
      if (parsed.length >= 12) break;
    }
    if (stripAnsi(lines[i]).trim().startsWith("❯") && parsed.length > 0) break;
  }

  if (parsed.length === 0) return null;
  return parsed.join("\n");
}

/** Read last N lines from a file */
async function tailFile(filePath: string, lines: number): Promise<string> {
  try {
    const file = Bun.file(filePath);
    const content = await file.text();
    const allLines = content.split("\n");
    return allLines.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Start monitoring a captured output file.
 * The file should be written by `script` command wrapping the Claude CLI process.
 */
export async function startOutputMonitor(
  outputFile: string,
  onStatus: StatusCallback,
): Promise<OutputMonitorHandle | null> {
  if (!existsSync(outputFile)) return null;

  let running = true;
  let lastStatus = "";

  const poll = async () => {
    while (running) {
      try {
        const output = await tailFile(outputFile, TAIL_LINES);
        const status = parseStatus(output);

        if (status && normalizeForComparison(status) !== normalizeForComparison(lastStatus)) {
          lastStatus = status;
          onStatus(status);
        }
      } catch {}

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  };

  poll().catch((err) => console.error("[output-monitor] fatal error:", err));

  return {
    stop: () => { running = false; },
  };
}

/** Get the output file path for a project */
export function getOutputFilePath(projectName: string): string {
  return `/tmp/claude-output-${projectName}.log`;
}
