import { registerAdapter } from "./types.ts";
import { claudeAdapter } from "./claude.ts";
import { opencodeAdapter } from "./opencode.ts";

// Register all adapters at startup
registerAdapter(claudeAdapter);
registerAdapter(opencodeAdapter);

export { claudeAdapter, opencodeAdapter };
export { getAdapter, registerAdapter } from "./types.ts";
export type { CliAdapter, CliConfig, MessageMeta } from "./types.ts";
