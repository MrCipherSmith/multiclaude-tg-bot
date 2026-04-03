import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Maps client_id (session UUID) -> McpServer instance
const mcpServers = new Map<string, McpServer>();

export function registerMcpSession(clientId: string, server: McpServer): void {
  mcpServers.set(clientId, server);
}

export function unregisterMcpSession(clientId: string): void {
  mcpServers.delete(clientId);
}

export function getMcpServer(clientId: string): McpServer | undefined {
  return mcpServers.get(clientId);
}

export async function sendNotificationToSession(
  clientId: string,
  chatId: string,
  fromUser: string,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<boolean> {
  const server = mcpServers.get(clientId);
  if (!server) return false;

  try {
    // Send as a logging message — this is the standard way to push info to the client
    await server.server.sendLoggingMessage({
      level: "info",
      data: JSON.stringify({
        type: "telegram_message",
        chat_id: chatId,
        from: fromUser,
        text,
        timestamp: new Date().toISOString(),
        ...metadata,
      }),
    });
    return true;
  } catch (err) {
    console.error(`[bridge] failed to notify session ${clientId}:`, err);
    return false;
  }
}
