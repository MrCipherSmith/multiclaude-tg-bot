import { registerAdapter } from "./types.ts";
import { claudeAdapter } from "./claude.ts";
import { codexCliAdapter } from "./codex-cli.ts";
import { openCodeAdapter } from "./opencode.ts";
import { deepseekCliAdapter } from "./deepseek-cli.ts";

// Register all adapters at startup
registerAdapter(claudeAdapter);
registerAdapter(codexCliAdapter);
registerAdapter(openCodeAdapter);
registerAdapter(deepseekCliAdapter);

export { claudeAdapter };
export { codexCliAdapter };
export { openCodeAdapter };
export { deepseekCliAdapter };
export { getAdapter, registerAdapter } from "./types.ts";
export type { CliAdapter, CliConfig, MessageMeta } from "./types.ts";
export { ClaudeCodeAdapter } from "./claude.ts";
export { CodexCliAdapter } from "./codex-cli.ts";
export { OpenCodeAdapter } from "./opencode.ts";
export { DeepseekCliAdapter } from "./deepseek-cli.ts";
