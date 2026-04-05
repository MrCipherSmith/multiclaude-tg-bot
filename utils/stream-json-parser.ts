/**
 * Parses Claude CLI stream-json output for progress monitoring.
 * Alternative to tmux-monitor — works without tmux by reading
 * Claude's structured JSON output.
 *
 * Stream-json format: one JSON object per line, types:
 *   system (init), assistant (tool_use/text/thinking),
 *   user (tool_result), result (completion)
 */

export interface StreamEvent {
  type: "system" | "assistant" | "user" | "result" | "rate_limit_event";
  subtype?: string;
  session_id?: string;
  message?: {
    content: Array<{
      type: string;
      name?: string;
      input?: Record<string, unknown>;
      text?: string;
      thinking?: string;
      tool_use_id?: string;
    }>;
    usage?: { input_tokens: number; output_tokens: number };
  };
  tool_use_result?: {
    type?: string;
    stdout?: string;
    stderr?: string;
    file?: { filePath: string };
  };
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
}

export interface ProgressUpdate {
  type: "init" | "thinking" | "tool_start" | "tool_result" | "text" | "done" | "error";
  status: string; // formatted status line (same style as tmux-monitor)
  tool?: string;
  detail?: string;
}

/** Format a tool call into a status line (matching tmux-monitor style) */
function formatToolStatus(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return `● $ ${String(input.command ?? "").slice(0, 60)}`;
    case "Read":
      return `● Read: ${String(input.file_path ?? "").split("/").pop()}`;
    case "Edit":
      return `● Edit: ${String(input.file_path ?? "").split("/").pop()}`;
    case "Write":
      return `● Write: ${String(input.file_path ?? "").split("/").pop()}`;
    case "Glob":
      return `● Glob: ${String(input.pattern ?? "").slice(0, 50)}`;
    case "Grep":
      return `● Grep: ${String(input.pattern ?? "").slice(0, 50)}`;
    case "Agent":
    case "Explore":
      return `● ${name}: ${String(input.description ?? input.prompt ?? "").slice(0, 50)}`;
    default: {
      // MCP tools
      if (name.startsWith("mcp__")) {
        const parts = name.split("__");
        const toolName = parts[parts.length - 1];
        return `● MCP: ${toolName}`;
      }
      return `● ${name}`;
    }
  }
}

/** Format a tool result into a status line */
function formatToolResult(event: StreamEvent): string | null {
  const result = event.tool_use_result;
  if (!result) return null;

  if (result.stderr) {
    return `  └ ❌ ${result.stderr.split("\n")[0].slice(0, 55)}`;
  }
  if (result.file) {
    return `  └ ${result.file.filePath.split("/").pop()}`;
  }
  if (result.stdout) {
    const firstLine = result.stdout.split("\n")[0].slice(0, 55);
    return firstLine ? `  └ ${firstLine}` : null;
  }
  return null;
}

/** Parse a single stream-json line into a progress update */
export function parseStreamEvent(line: string): ProgressUpdate | null {
  let event: StreamEvent;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  switch (event.type) {
    case "system":
      return { type: "init", status: "⏳ Initializing..." };

    case "assistant": {
      const content = event.message?.content;
      if (!content?.length) return null;

      const block = content[0];

      if (block.type === "thinking") {
        const preview = (block.thinking ?? "").slice(0, 40).replace(/\n/g, " ");
        return { type: "thinking", status: `⏳ Thinking... ${preview}` };
      }

      if (block.type === "tool_use" && block.name) {
        const status = formatToolStatus(block.name, block.input ?? {});
        // Skip our own MCP tools
        if (block.name.includes("reply") || block.name.includes("update_status")) return null;
        return { type: "tool_start", status, tool: block.name, detail: JSON.stringify(block.input) };
      }

      if (block.type === "text") {
        return { type: "text", status: `💬 Responding...` };
      }

      return null;
    }

    case "user": {
      const resultStatus = formatToolResult(event);
      if (resultStatus) {
        return { type: "tool_result", status: resultStatus };
      }
      return null;
    }

    case "result": {
      if (event.is_error) {
        return { type: "error", status: `❌ Error after ${event.num_turns ?? 0} turns` };
      }
      const cost = event.total_cost_usd ? ` · $${event.total_cost_usd.toFixed(4)}` : "";
      const duration = event.duration_ms ? ` · ${(event.duration_ms / 1000).toFixed(1)}s` : "";
      return {
        type: "done",
        status: `✅ Done (${event.num_turns ?? 0} turns${duration}${cost})`,
      };
    }

    default:
      return null;
  }
}

/**
 * Accumulates stream events into a multi-line status block.
 * Keeps last N relevant lines, similar to tmux-monitor's parseStatus.
 */
export class StreamStatusAccumulator {
  private lines: string[] = [];
  private maxLines: number;

  constructor(maxLines = 6) {
    this.maxLines = maxLines;
  }

  /** Process a new event, return updated status block or null if unchanged */
  push(update: ProgressUpdate): string | null {
    if (update.type === "tool_start") {
      // New tool — add as main line
      this.lines.push(update.status);
    } else if (update.type === "tool_result") {
      // Result — add as sub-line
      this.lines.push(update.status);
    } else if (update.type === "thinking") {
      // Replace previous thinking line or add
      const thinkIdx = this.lines.findIndex((l) => l.startsWith("⏳ Thinking"));
      if (thinkIdx >= 0) {
        this.lines[thinkIdx] = update.status;
      } else {
        this.lines.push(update.status);
      }
    } else if (update.type === "done" || update.type === "error") {
      this.lines = [update.status];
    } else {
      return null;
    }

    // Trim to max lines (keep most recent)
    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.slice(-this.maxLines);
    }

    return this.lines.join("\n");
  }

  reset(): void {
    this.lines = [];
  }
}
