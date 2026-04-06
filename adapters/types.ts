export interface MessageMeta {
  chatId: string;
  fromUser: string;
  messageId?: string;
}

export interface CliConfig {
  port?: number;        // opencode: default 4096
  autostart?: boolean;  // default false
  tmuxSession?: string; // optional tmux session for autostart spawn
  model?: string;       // selected model override
}

export interface CliAdapter {
  readonly type: "claude" | "opencode";

  /**
   * Send a user message to the CLI session.
   * ClaudeAdapter: INSERT INTO message_queue
   * OpencodeAdapter: POST /session/:id/prompt_async
   */
  send(sessionId: number, text: string, meta: MessageMeta): Promise<void>;

  /**
   * Check if the CLI process is reachable/running.
   * Used before autostart decision.
   */
  isAlive(config: CliConfig): Promise<boolean>;
}

// Global adapter registry — populated at startup
const registry = new Map<string, CliAdapter>();

export function registerAdapter(adapter: CliAdapter): void {
  registry.set(adapter.type, adapter);
}

export function getAdapter(cliType: string): CliAdapter {
  const adapter = registry.get(cliType);
  if (!adapter) throw new Error(`No adapter registered for cli_type: ${cliType}`);
  return adapter;
}
