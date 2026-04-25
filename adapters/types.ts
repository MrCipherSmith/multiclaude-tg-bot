export interface MessageMeta {
  chatId: string;
  fromUser: string;
  messageId?: string;
}

export interface CliConfig {
  model?: string;       // selected Claude model override
}

/** Forward-compat alias — use AgentRuntimeAdapter in new code */
export type AgentRuntimeAdapter = CliAdapter;

export interface CliAdapter {
  readonly type: string;

  /**
   * Send a user message to the CLI session.
   * ClaudeAdapter: INSERT INTO message_queue → channel.ts picks up via stdio MCP
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
  if (!adapter) throw new Error(`No adapter registered for runtime_type: ${cliType}`);
  return adapter;
}
