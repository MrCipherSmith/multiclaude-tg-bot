import { registerAdapter } from "./types.ts";
import { claudeAdapter } from "./claude.ts";

// Register all adapters at startup
registerAdapter(claudeAdapter);

export { claudeAdapter };
export { getAdapter, registerAdapter } from "./types.ts";
export type { CliAdapter, CliConfig, MessageMeta } from "./types.ts";
