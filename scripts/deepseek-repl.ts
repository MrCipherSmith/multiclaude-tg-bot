#!/usr/bin/env bun
/**
 * scripts/deepseek-repl.ts
 *
 * Long-running REPL: stdin -> DeepSeek API -> stdout.
 * Used as the launcher for agents with runtime_type = "deepseek-cli".
 *
 * Usage:
 *   bun scripts/deepseek-repl.ts                            # uses 'deepseek-default' profile
 *   MODEL_PROFILE_ID=N bun scripts/deepseek-repl.ts         # explicit profile id
 *   bun scripts/deepseek-repl.ts --profile-name <name>      # by name
 *   bun scripts/deepseek-repl.ts --profile-id <id>          # by id
 *
 * stdin:  one user message per line (newline-terminated). Multi-line via "\\n".
 * stdout: full assistant response, then a separator line "---" to mark turn end.
 * stderr: errors and banner.
 *
 * NOTE: streamResponse() is an AsyncGenerator that requires a `system` string
 * positional argument. To keep this REPL simple and avoid wiring deltas
 * synchronously to stdout (Bun's stdin handling is async), we use
 * generateResponse() which buffers and returns the full reply.
 */

import { sql } from "../memory/db.ts";
import { resolveProfile } from "../llm/profile-resolver.ts";
import { generateResponse } from "../llm/client.ts";
import type { MessageParam, ResolvedProvider } from "../llm/types.ts";

interface CliArgs {
  profileId?: number;
  profileName?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile-id" && argv[i + 1]) {
      out.profileId = parseInt(argv[++i], 10);
    } else if (argv[i] === "--profile-name" && argv[i + 1]) {
      out.profileName = argv[++i];
    }
  }
  return out;
}

async function resolveStartupProfile(): Promise<ResolvedProvider> {
  const args = parseArgs(process.argv.slice(2));
  let id: number | undefined = args.profileId;

  if (!id && process.env.MODEL_PROFILE_ID) {
    id = parseInt(process.env.MODEL_PROFILE_ID, 10);
  }

  if (!id) {
    const lookupName = args.profileName ?? "deepseek-default";
    const rows = (await sql`
      SELECT id FROM model_profiles WHERE name = ${lookupName} LIMIT 1
    `) as Array<{ id: number }>;
    const row = rows[0];
    if (!row) {
      throw new Error(
        `model_profile "${lookupName}" not found. ` +
          `Run migration v24 or pass --profile-id <id>.`,
      );
    }
    id = Number(row.id);
  }

  return await resolveProfile(id);
}

function banner(p: ResolvedProvider): string {
  return [
    "============================================================",
    "  Helyx DeepSeek REPL",
    `  provider:  ${p.providerType}`,
    `  model:     ${p.model}`,
    `  base_url:  ${p.baseUrl ?? "(SDK default)"}`,
    `  api_key:   ${p.apiKey ? "*** set" : "(missing — check env)"}`,
    "============================================================",
    "Type a message and press Enter. Ctrl+D to exit.",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  let provider: ResolvedProvider;
  try {
    provider = await resolveStartupProfile();
  } catch (err) {
    console.error(`[deepseek-repl] FATAL: ${String(err)}`);
    process.exit(1);
  }

  console.error(banner(provider));

  if (!provider.apiKey) {
    console.error(`[deepseek-repl] WARN: api key is empty — requests will fail`);
  }

  const messages: MessageParam[] = [];
  const systemPrompt = provider.systemPrompt ?? "You are a helpful assistant.";

  // Serialize handler invocations so concurrent stdin chunks don't interleave
  // turns. We chain promises through `inflight`.
  let inflight: Promise<void> = Promise.resolve();

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;

    messages.push({ role: "user", content: trimmed });

    try {
      const reply = await generateResponse(messages, systemPrompt, {
        provider,
        operation: "deepseek-repl",
      });
      process.stdout.write(reply);
      process.stdout.write("\n---\n");
      messages.push({ role: "assistant", content: reply });
    } catch (err) {
      console.error(`[deepseek-repl] error: ${String(err)}`);
      // Don't push the failed turn into history — let the user retry
      messages.pop();
      process.stdout.write("(error — see stderr)\n---\n");
    }
  };

  process.stdin.setEncoding("utf-8");
  let buffer = "";

  // setEncoding('utf-8') above guarantees data events deliver strings
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      inflight = inflight.then(() => handleLine(line));
    }
  });

  process.stdin.on("end", () => {
    inflight
      .catch((err) => {
        console.error(`[deepseek-repl] last turn rejected during shutdown: ${String(err)}`);
      })
      .finally(() => {
        console.error("[deepseek-repl] stdin closed, exiting");
        process.exit(0);
      });
  });

  // Graceful shutdown
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      console.error(`[deepseek-repl] received ${sig}, exiting`);
      inflight.finally(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error(`[deepseek-repl] uncaught: ${String(err)}`);
  process.exit(1);
});
