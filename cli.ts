#!/usr/bin/env bun
/**
 * Helyx CLI — setup wizard and management commands.
 *
 * Usage:
 *   bun cli.ts setup          Interactive installation wizard
 *   bun cli.ts start          Start bot (docker compose up)
 *   bun cli.ts stop           Stop bot (docker compose down)
 *   bun cli.ts restart        Rebuild and restart bot
 *   bun cli.ts status         Show bot health and stats
 *   bun cli.ts sessions       List active sessions
 *   bun cli.ts logs           Show bot logs
 *   bun cli.ts backup         Run database backup
 *   bun cli.ts cleanup        Clean old sessions and data
 *   bun cli.ts connect [dir]  Start CLI session for a project
 *   bun cli.ts mcp-register   Register MCP servers in Claude Code
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, basename, dirname } from "path";
import { homedir } from "os";

// --- ANSI colors ---
const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

const BOT_DIR = import.meta.dir;

// --- Helpers ---

function ask(question: string, defaultValue = ""): string {
  const suffix = defaultValue ? ` ${c.dim(`[${defaultValue}]`)}` : "";
  process.stdout.write(`  ${question}${suffix}: `);
  const answer = prompt("")?.trim() ?? "";
  return answer || defaultValue;
}

function askChoice(question: string, options: string[]): number {
  console.log(`\n  ${c.bold(question)}`);
  options.forEach((opt, i) => console.log(`  ${c.cyan(`${i + 1}.`)} ${opt}`));
  const answer = ask(">");
  const idx = parseInt(answer) - 1;
  if (idx >= 0 && idx < options.length) return idx;
  return 0;
}

/**
 * Multi-select checkbox prompt. Returns a Set of selected indices.
 * Items in `required` are always checked and shown as [✓ locked].
 * User enters comma-separated numbers to toggle, or Enter to confirm.
 */
function askMultiCheck(question: string, options: string[], required: number[] = []): Set<number> {
  const selected = new Set<number>(required);
  console.log(`\n  ${c.bold(question)}`);
  console.log(c.dim("  Enter numbers to toggle, Enter to confirm (required items are locked)"));

  const render = () => {
    options.forEach((opt, i) => {
      const isRequired = required.includes(i);
      const isSelected = selected.has(i);
      const box = isSelected ? c.green("✓") : " ";
      const lock = isRequired ? c.dim(" (required)") : "";
      console.log(`  [${box}] ${c.cyan(`${i + 1}.`)} ${opt}${lock}`);
    });
  };

  while (true) {
    render();
    const answer = ask(">").trim();
    if (!answer) break;
    for (const part of answer.split(",")) {
      const idx = parseInt(part.trim()) - 1;
      if (idx < 0 || idx >= options.length) continue;
      if (required.includes(idx)) continue; // can't uncheck required
      if (selected.has(idx)) selected.delete(idx);
      else selected.add(idx);
    }
    console.log();
  }
  return selected;
}

async function run(cmd: string[], opts?: { cwd?: string; silent?: boolean; stream?: boolean }): Promise<{ ok: boolean; output: string }> {
  const stream = opts?.stream ?? false;
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd ?? BOT_DIR,
    stdout: stream ? "inherit" : "pipe",
    stderr: stream ? "inherit" : "pipe",
  });
  if (stream) {
    const code = await proc.exited;
    return { ok: code === 0, output: "" };
  }
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (!opts?.silent && code !== 0 && stderr) {
    console.error(c.red(`  Error: ${stderr.trim()}`));
  }
  return { ok: code === 0, output: stdout.trim() };
}

function step(msg: string) {
  process.stdout.write(`  ${msg}...`);
}

function done() {
  console.log(` ${c.green("done")}`);
}

function fail(msg?: string) {
  console.log(` ${c.red(msg ?? "failed")}`);
}

// --- Setup wizard ---

async function setup() {
  console.log(`\n  ${c.bold("Helyx Setup")}`);
  console.log(`  ${"─".repeat(40)}\n`);

  // 1. Deployment type
  const deployIdx = askChoice("Deployment type:", [
    "Docker (recommended — PostgreSQL included)",
    "Manual (PostgreSQL + Ollama already installed)",
  ]);
  const useDocker = deployIdx === 0;

  // 2. Telegram
  console.log();
  const botToken = ask("Telegram Bot Token (from @BotFather)");
  if (!botToken) {
    console.log(c.red("\n  Bot token is required. Get one from @BotFather in Telegram."));
    return;
  }
  const allowedUsers = ask("Your Telegram User ID");
  if (!allowedUsers) {
    console.log(c.red("\n  User ID is required. Send /start to @userinfobot to get yours."));
    return;
  }

  // 3. LLM Provider
  const providerIdx = askChoice("LLM Provider for standalone mode:", [
    "Anthropic (best quality, requires API key)",
    "Google AI (Gemma 4 models, free tier available)",
    "OpenRouter (many models, free & paid)",
    "Ollama (local, free)",
  ]);

  let anthropicKey = "";
  let googleAiKey = "";
  let googleAiModel = "gemma-4-31b-it";
  let openrouterKey = "";
  let openrouterModel = "qwen/qwen3-235b-a22b:free";
  let ollamaModel = "qwen3:8b";

  if (providerIdx === 0) {
    anthropicKey = ask("Anthropic API Key");
  } else if (providerIdx === 1) {
    googleAiKey = ask("Google AI API Key");
    googleAiModel = ask("Google AI Model", "gemma-4-31b-it");
  } else if (providerIdx === 2) {
    openrouterKey = ask("OpenRouter API Key");
    openrouterModel = ask("OpenRouter Model", "qwen/qwen3-235b-a22b:free");
  } else {
    ollamaModel = ask("Ollama Chat Model", "qwen3:8b");
  }

  // 4. Telegram transport
  const transportIdx = askChoice("Telegram transport:", [
    "Polling (default — works everywhere, no domain needed)",
    "Webhook (requires public URL, e.g. via Cloudflare Tunnel)",
  ]);
  const useWebhook = transportIdx === 1;

  let webhookUrl = "";
  let webhookSecret = "";
  if (useWebhook) {
    console.log(c.dim("\n  Webhook requires a public HTTPS URL pointing to this bot."));
    console.log(c.dim("  If your server is behind Cloudflare Tunnel:"));
    console.log(c.dim("    cloudflared tunnel route dns <tunnel-name> bot.yourdomain.com"));
    console.log(c.dim("  Then the URL would be: https://bot.yourdomain.com/telegram/webhook"));
    console.log(c.dim("  The secret is any random string to verify requests from Telegram.\n"));
    webhookUrl = ask("Webhook URL (e.g. https://bot.yourdomain.com/telegram/webhook)");
    if (!webhookUrl) {
      console.log(c.red("\n  Webhook URL is required."));
      return;
    }
    webhookSecret = ask("Webhook secret (random string)", crypto.randomUUID());
  }

  // 5. Voice transcription (Groq — also used for TTS normalization)
  console.log();
  const groqKey = ask("Groq API Key for voice transcription (Enter to skip, free at console.groq.com)");

  // 6. TTS (voice output)
  console.log();
  console.log(`  ${c.bold("TTS (voice output)")}`);
  const ttsIdx = askChoice("TTS provider:", [
    "auto (Piper → Yandex → Groq, recommended)",
    "Piper (local, Russian, offline — free)",
    "Yandex SpeechKit (Russian, best quality)",
    "Kokoro (local, English, offline — free)",
    "OpenAI TTS (multilingual)",
    "Groq Orpheus (English only)",
    "Disable TTS",
  ]);
  const ttsProviders = ["auto", "piper", "yandex", "kokoro", "openai", "groq", "none"] as const;
  const ttsProvider = ttsProviders[ttsIdx] ?? "auto";

  let piperDir = "";
  let piperModel = "";
  let yandexApiKey = "";
  let yandexFolderId = "";
  let yandexVoice = "alena";
  let yandexLang = "ru-RU";
  let kokoroDtype = "q8";
  let kokoroVoice = "af_bella";
  let openaiApiKey = "";
  let piperModelEn = "en_US-lessac-medium.onnx";
  let piperModelRu = "";
  let downloadPiperVoices = false;

  // Piper voice catalog: [label, filename, huggingface path]
  const PIPER_VOICES: Array<{ label: string; file: string; hfPath: string }> = [
    { label: "English — en_US-lessac-medium (male, neutral)", file: "en_US-lessac-medium.onnx", hfPath: "en/en_US/lessac/medium/en_US-lessac-medium.onnx" },
    { label: "Russian — ru_RU-irina-medium (female, neutral)", file: "ru_RU-irina-medium.onnx", hfPath: "ru/ru_RU/irina/medium/ru_RU-irina-medium.onnx" },
    { label: "Russian — ru_RU-denis-medium (male)", file: "ru_RU-denis-medium.onnx", hfPath: "ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx" },
    { label: "German — de_DE-thorsten-medium (male)", file: "de_DE-thorsten-medium.onnx", hfPath: "de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx" },
    { label: "Spanish — es_ES-sharvard-medium (male)", file: "es_ES-sharvard-medium.onnx", hfPath: "es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx" },
    { label: "French — fr_FR-upmc-medium (male)", file: "fr_FR-upmc-medium.onnx", hfPath: "fr/fr_FR/upmc/medium/fr_FR-upmc-medium.onnx" },
  ];
  const PIPER_HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

  if (ttsProvider === "piper" || ttsProvider === "auto") {
    console.log(c.dim("\n  Piper: local TTS, works offline. Requires piper binary + voice files."));
    piperDir = ask("Piper directory (Enter for default)", "");

    const voiceLabels = PIPER_VOICES.map(v => v.label);
    const selectedVoices = askMultiCheck("Select voices to download:", voiceLabels, [0]); // English (index 0) required

    // Pick model filenames for primary EN and RU
    const selectedVoiceList = [...selectedVoices].map(i => PIPER_VOICES[i]!);
    const enVoice = selectedVoiceList.find(v => v.file.startsWith("en_US"));
    const ruVoice = selectedVoiceList.find(v => v.file.startsWith("ru_RU"));
    piperModelEn = enVoice?.file ?? "en_US-lessac-medium.onnx";
    piperModelRu = ruVoice?.file ?? "";
    piperModel = piperModelRu || piperModelEn; // backward-compat primary model

    const doDownload = askChoice("Download selected voice models now?", ["Yes", "No"]);
    downloadPiperVoices = doDownload === 0;

    if (downloadPiperVoices) {
      const voicesDir = (piperDir || `${BOT_DIR}/piper`) + "/voices";
      await run(["mkdir", "-p", voicesDir], { silent: true });
      for (const idx of selectedVoices) {
        const voice = PIPER_VOICES[idx]!;
        const destOnnx = `${voicesDir}/${voice.file}`;
        const destJson = `${destOnnx}.json`;
        if (existsSync(destOnnx)) {
          console.log(`  ${c.dim(`  ${voice.file} — already exists, skipping`)}`);
          continue;
        }
        step(`Downloading ${voice.file}`);
        const dl = await run(["curl", "-fsSL", "-o", destOnnx, `${PIPER_HF_BASE}/${voice.hfPath}`]);
        dl.ok ? done() : fail("download failed");
        // also download .json config
        await run(["curl", "-fsSL", "-o", destJson, `${PIPER_HF_BASE}/${voice.hfPath}.json`], { silent: true });
      }
    }
  }

  if (ttsProvider === "yandex" || ttsProvider === "auto") {
    console.log();
    yandexApiKey = ask("Yandex SpeechKit API Key (Enter to skip)");
    if (yandexApiKey) {
      yandexFolderId = ask("Yandex Folder ID");
      const voiceIdx = askChoice("Yandex voice:", [
        "alena (female, neutral)",
        "filipp (male, neutral)",
        "jane (female, friendly)",
        "omazh (female, emotional)",
        "zahar (male, confident)",
      ]);
      yandexVoice = ["alena", "filipp", "jane", "omazh", "zahar"][voiceIdx] ?? "alena";
      const langIdx = askChoice("Language:", ["ru-RU (Russian)", "en-US (English)", "kk-KK (Kazakh)"]);
      yandexLang = ["ru-RU", "en-US", "kk-KK"][langIdx] ?? "ru-RU";
    }
  }

  if (ttsProvider === "kokoro") {
    const dtypeIdx = askChoice("Kokoro precision (q8 recommended):", ["q8", "q4", "fp16", "fp32"]);
    kokoroDtype = ["q8", "q4", "fp16", "fp32"][dtypeIdx] ?? "q8";
    kokoroVoice = ask("Kokoro voice", "af_bella");
  }

  if (ttsProvider === "openai") {
    openaiApiKey = ask("OpenAI API Key");
  }

  // 7. Database password
  const dbPassword = ask("PostgreSQL password", "helyx_secret");

  // 6. Port
  const port = ask("Bot port", "3847");

  // Generate .env
  console.log();
  step("Creating .env");

  const dbUrl = useDocker
    ? `postgres://helyx:${dbPassword}@localhost:5433/helyx`
    : `postgres://helyx:${dbPassword}@localhost:5432/helyx`;

  const envLines = [
    "# Telegram",
    `TELEGRAM_BOT_TOKEN=${botToken}`,
    `ALLOWED_USERS=${allowedUsers}`,
    `TELEGRAM_TRANSPORT=${useWebhook ? "webhook" : "polling"}`,
    ...(useWebhook ? [
      `TELEGRAM_WEBHOOK_URL=${webhookUrl}`,
      `TELEGRAM_WEBHOOK_SECRET=${webhookSecret}`,
    ] : []),
    "",
    "# LLM Provider",
    `ANTHROPIC_API_KEY=${anthropicKey}`,
    `CLAUDE_MODEL=claude-sonnet-4-20250514`,
    `MAX_TOKENS=8192`,
    `GOOGLE_AI_API_KEY=${googleAiKey}`,
    `GOOGLE_AI_MODEL=${googleAiModel}`,
    `OPENROUTER_API_KEY=${openrouterKey}`,
    `OPENROUTER_MODEL=${openrouterModel}`,
    `OPENROUTER_BASE_URL=https://openrouter.ai/api/v1`,
    `OLLAMA_CHAT_MODEL=${ollamaModel}`,
    "",
    "# PostgreSQL",
    `DATABASE_URL=${dbUrl}`,
    `POSTGRES_PASSWORD=${dbPassword}`,
    "",
    "# Ollama",
    `OLLAMA_URL=http://localhost:11434`,
    `EMBEDDING_MODEL=nomic-embed-text`,
    "",
    "# Voice transcription",
    `GROQ_API_KEY=${groqKey}`,
    `WHISPER_URL=http://localhost:9000`,
    "",
    "# TTS (voice output)",
    `TTS_PROVIDER=${ttsProvider}`,
    ...(piperDir ? [`PIPER_DIR=${piperDir}`] : []),
    ...(piperModelEn ? [`PIPER_MODEL_EN=${piperModelEn}`] : []),
    ...(piperModelRu ? [`PIPER_MODEL_RU=${piperModelRu}`] : []),
    ...(piperModel ? [`PIPER_MODEL=${piperModel}`] : []),
    `YANDEX_API_KEY=${yandexApiKey}`,
    `YANDEX_FOLDER_ID=${yandexFolderId}`,
    `YANDEX_VOICE=${yandexVoice}`,
    `YANDEX_LANG=${yandexLang}`,
    `KOKORO_DTYPE=${kokoroDtype}`,
    `KOKORO_VOICE=${kokoroVoice}`,
    `OPENAI_API_KEY=${openaiApiKey}`,
    "",
    "# Server",
    `PORT=${port}`,
    `SHORT_TERM_WINDOW=20`,
    `IDLE_TIMEOUT_MS=900000`,
    "",
    "# Host paths (used inside Docker to verify project existence)",
    `HOST_HOME=${process.env.HOME ?? "/root"}`,
    `HOST_PROJECTS_DIR=${process.env.HOME ?? "/root"}`,
  ];

  await Bun.write(`${BOT_DIR}/.env`, envLines.join("\n") + "\n");
  done();

  // Ensure required dirs exist with correct ownership (before Docker creates them as root)
  await run(["mkdir", "-p", `${BOT_DIR}/logs`], { silent: true });
  await run(["mkdir", "-p", `${BOT_DIR}/downloads`], { silent: true });

  // Install dependencies
  step("Installing dependencies");
  const install = await run(["bun", "install", "--frozen-lockfile"]);
  install.ok ? done() : fail();

  // Start services
  if (useDocker) {
    step("Starting Docker services");
    const up = await run(["docker", "compose", "up", "-d", "--build"]);
    up.ok ? done() : fail();

    // Wait for DB
    step("Waiting for database");
    for (let i = 0; i < 30; i++) {
      const check = await run(["docker", "compose", "exec", "-T", "postgres", "pg_isready", "-U", "helyx"], { silent: true });
      if (check.ok) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    done();
  } else {
    console.log(`\n  ${c.yellow("Ensure PostgreSQL and Ollama are running before continuing.")}`);
    ask("Press Enter when ready");
  }

  // Run migrations
  step("Running database migrations");
  if (useDocker) {
    // Migrations run automatically on bot start, but verify
    await new Promise((r) => setTimeout(r, 3000));
    const health = await run(["curl", "-sf", `http://localhost:${port}/health`], { silent: true });
    health.ok ? done() : fail("bot not responding yet, migrations may still be running");
  } else {
    const migrate = await run(["bun", "memory/db.ts"]);
    migrate.ok ? done() : fail();
  }

  // Register MCP servers
  step("Registering MCP servers in Claude Code");
  await run(["claude", "mcp", "remove", "helyx", "-s", "user"], { silent: true });
  await run(["claude", "mcp", "remove", "helyx-channel", "-s", "user"], { silent: true });

  await run(["claude", "mcp", "add", "--transport", "http", "-s", "user", "helyx", `http://localhost:${port}/mcp`]);

  const channelConfig = JSON.stringify({
    type: "stdio",
    command: "bun",
    args: [`${BOT_DIR}/channel.ts`],
    env: {
      DATABASE_URL: dbUrl,
      OLLAMA_URL: "http://localhost:11434",
      TELEGRAM_BOT_TOKEN: botToken,
    },
  });
  await run(["claude", "mcp", "add-json", "-s", "user", "helyx-channel", channelConfig]);
  done();

  await installMcpSharedServices();

  // Copy CLAUDE.md template
  step("Setting up global CLAUDE.md");
  const claudeMdPath = `${process.env.HOME}/.claude/CLAUDE.md`;
  if (!existsSync(claudeMdPath)) {
    const template = `# Global CLAUDE.md

## Telegram Status Updates

When responding to Telegram channel messages (messages from \`notifications/claude/channel\`), call \`update_status\` before each major step to keep the user informed. Use the \`chat_id\` from the channel message metadata.

Examples:
- Before reading files: \`update_status(chat_id, "Reading files...")\`
- Before running commands: \`update_status(chat_id, "Running git status...")\`
- Before editing: \`update_status(chat_id, "Editing code...")\`
- Before analysis: \`update_status(chat_id, "Analyzing...")\`

Keep status messages short (under 50 chars). The status is automatically deleted when you call \`reply\`.

## Project Memory

### Session start
At the beginning of any session where you will do significant work on a codebase,
call \`search_project_context(query="project architecture constraints conventions")\`
to load facts saved in previous sessions.

### Search memory proactively
Call \`recall(query="<topic>")\` before exploring unfamiliar code or starting a new task:
- Before touching a subsystem: \`recall("auth")\`, \`recall("database schema")\`
- When you see an unfamiliar pattern: \`recall("<pattern>")\`
- Before implementing something significant: \`recall("<feature area>")\`

### Save facts during work
Call \`remember(type="fact", tags=["project", "<category>"])\` when you discover:
- Architecture decisions and why they were made
- Non-obvious constraints (hardcoded ports, required env vars, ordering dependencies)
- Important file roles, setup quirks, naming conventions, gotchas

Write as self-contained sentences. Good: \`"Port 3847 serves both MCP and dashboard via the same HTTP server"\`
`;
    await Bun.write(claudeMdPath, template);
    done();
  } else {
    console.log(` ${c.yellow("exists, skipping")}`);
  }

  // Register Stop hook for auto fact extraction
  step("Registering Stop hook for memory auto-save");
  await setupStopHook();
  done();

  // Install systemd service (helyx@USER) for auto-start on boot
  step("Installing systemd service");
  const svcUser = process.env.USER ?? basename(homedir());
  const svcSrc = resolve(BOT_DIR, "scripts/helyx.service");
  const svcDst = `/etc/systemd/system/helyx@${svcUser}.service`;
  const svcCopy = await run(["sudo", "cp", svcSrc, svcDst]);
  if (svcCopy.ok) {
    await run(["sudo", "systemctl", "daemon-reload"], { silent: true });
    await run(["sudo", "systemctl", "enable", `helyx@${svcUser}`], { silent: true });
    done();
  } else {
    console.log(` ${c.yellow("skipped")} (no sudo — run manually):`);
    console.log(`    sudo cp scripts/helyx.service ${svcDst}`);
    console.log(`    sudo systemctl enable --now helyx@${svcUser}`);
  }

  // Register projects
  console.log(`  ${c.bold("Add projects (optional)")}`);
  console.log(`  You can register project directories now, or later with ${c.cyan("helyx add .")}\n`);
  let addMore = true;
  while (addMore) {
    const projPath = ask("Project path to register (Enter to skip)");
    if (!projPath) break;

    const absPath = resolve(projPath);
    if (!existsSync(absPath)) {
      console.log(c.red(`  Path not found: ${absPath}`));
      continue;
    }

    // Run registration inside the container — avoids Docker bridge NAT causing 401/403
    const result = await run([
      "docker", "compose", "exec", "-T", "bot",
      "bun", "/app/cli.ts", "_register",
      "--path", absPath,
      "--name", basename(absPath),
    ]);
    if (!result.ok) {
      console.log(c.yellow(`  Add later with: helyx add ${absPath}`));
    }

    const again = ask("Add another project? (y/N)", "N");
    addMore = again.toLowerCase() === "y";
  }

  // Summary
  console.log(`\n  ${c.green(c.bold("Setup complete!"))}\n`);
  console.log(`  ${c.bold("Next steps:")}\n`);
  console.log(`  1. Start all project sessions:`);
  console.log(`    ${c.cyan("helyx up")}\n`);
  console.log(`  2. (Optional) Set up Telegram Forum for per-project topics:`);
  console.log(`    • Create a Telegram supergroup and enable Topics`);
  console.log(`    • Add the bot as admin with ${c.bold("Manage Topics")} permission`);
  console.log(`    • Send ${c.cyan("/forum_setup")} in the group\n`);
  console.log(`  3. Add projects:`);
  console.log(`    ${c.cyan("/project_add /path/to/project")} — in Telegram`);
  console.log(`    ${c.cyan("helyx add /path/to/project")} — from CLI\n`);
  console.log(`  Manage the bot:`);
  console.log(`    ${c.cyan("helyx up")}       — start all sessions`);
  console.log(`    ${c.cyan("helyx bounce")}   — restart all sessions`);
  console.log(`    ${c.cyan("helyx ps")}       — list session status`);
  console.log(`    ${c.cyan("helyx down")}     — stop all sessions\n`);
}

// --- Stop hook registration ---

async function setupStopHook(): Promise<void> {
  const settingsPath = `${process.env.HOME}/.claude/settings.json`;
  const hookCmd = `${BOT_DIR}/scripts/save-session-facts.sh`;

  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch { /* start fresh */ }
  }

  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];

  // Check if hook already registered
  const alreadyAdded = settings.hooks.Stop.some((entry: any) =>
    Array.isArray(entry.hooks) && entry.hooks.some((h: any) => h.command === hookCmd)
  );
  if (alreadyAdded) return;

  settings.hooks.Stop.push({
    hooks: [{ type: "command", command: hookCmd, timeout: 60 }],
  });

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

// --- Management commands ---

async function dockerStart() {
  step("Starting bot");
  const result = await run(["docker", "compose", "up", "-d"]);
  result.ok ? done() : fail();
}

async function start(dir?: string) {
  // Resolve directory
  let resolvedDir = dir;
  if (!resolvedDir || resolvedDir.startsWith("--")) resolvedDir = ".";
  const projectDir = resolve(resolvedDir);
  if (!existsSync(projectDir)) {
    console.log(c.red(`  Directory not found: ${projectDir}`));
    return;
  }

  console.log(`  ${c.green("Starting Claude Code...")} ${c.dim("(Ctrl+C to stop)")}\n`);
  // Local session: spawn claude directly with CHANNEL_SOURCE=local so channel.ts creates
  // a temporary DB session (summarized and deleted on exit), not a persistent remote session.
  const proc = Bun.spawn(
    ["claude", "--dangerously-load-development-channels", "server:helyx-channel"],
    {
      stdout: "inherit", stderr: "inherit", stdin: "inherit", cwd: projectDir,
      env: { ...process.env, CHANNEL_SOURCE: "local" },
    },
  );
  await proc.exited;
}

async function stop() {
  // First kill tmux and clean DB (while postgres is still running)
  await tmuxStop();

  step("Stopping docker");
  const result = await run(["docker", "compose", "down"]);
  result.ok ? done() : fail();
}

async function syncChannelToken() {
  const envPath = resolve(BOT_DIR, ".env");
  if (!existsSync(envPath)) return;
  const env = Object.fromEntries(
    readFileSync(envPath, "utf8").split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("=").map((s) => s.trim()))
      .filter((p) => p.length === 2),
  );
  const botToken = env.TELEGRAM_BOT_TOKEN ?? "";
  if (!botToken) return;

  const claudeJson = resolve(homedir(), ".claude.json");
  if (!existsSync(claudeJson)) return;
  const data = JSON.parse(readFileSync(claudeJson, "utf8"));
  if (data?.mcpServers?.["helyx-channel"]?.env) {
    data.mcpServers["helyx-channel"].env.TELEGRAM_BOT_TOKEN = botToken;
    writeFileSync(claudeJson, JSON.stringify(data, null, 4));
    console.log(`  ${c.dim("channel token synced from .env")}`);
  }
}

async function restart() {
  console.log("  Rebuilding and restarting bot...\n");
  const result = await run(["docker", "compose", "up", "-d", "--build", "bot"], { stream: true });
  result.ok ? console.log(`\n  ${c.green("done")}`) : console.log(`\n  ${c.red("failed")}`);
  await syncChannelToken();
}

async function status() {
  const port = process.env.PORT ?? "3847";
  const result = await run(["curl", "-sf", `http://localhost:${port}/health`], { silent: true });

  if (!result.ok) {
    console.log(`\n  ${c.red("Bot is not running")}`);
    return;
  }

  const data = JSON.parse(result.output);
  console.log(`\n  ${c.bold("Bot Status")}`);
  console.log(`  ${"─".repeat(30)}`);
  console.log(`  Status:   ${data.status === "ok" ? c.green("running") : c.red("error")}`);
  console.log(`  Database: ${data.db === "connected" ? c.green("connected") : c.red("disconnected")}`);
  console.log(`  Uptime:   ${formatUptime(data.uptime)}`);
  console.log(`  Sessions: ${data.sessions}`);

  // Docker status
  const docker = await run(["docker", "compose", "ps", "--format", "table {{.Name}}\t{{.Status}}"], { silent: true });
  if (docker.ok) {
    console.log(`\n  ${c.bold("Docker")}`);
    console.log(`  ${docker.output.split("\n").join("\n  ")}`);
  }
}

async function sessions() {
  const port = process.env.PORT ?? "3847";
  const result = await run(["curl", "-sf", `http://localhost:${port}/health`], { silent: true });

  if (!result.ok) {
    console.log(`\n  ${c.red("Bot is not running")}`);
    return;
  }

  // Query sessions via docker exec
  const query = await run([
    "docker", "compose", "exec", "-T", "postgres",
    "psql", "-U", "helyx", "-d", "helyx", "-t", "-A",
    "-c", "SELECT id, name, status, EXTRACT(EPOCH FROM (now() - last_active))::int as ago FROM sessions WHERE name NOT LIKE 'cli-%' ORDER BY id",
  ], { silent: true });

  if (!query.ok) {
    console.log(`\n  ${c.red("Cannot query database")}`);
    return;
  }

  console.log(`\n  ${c.bold("Sessions")}`);
  console.log(`  ${"─".repeat(50)}`);

  for (const line of query.output.split("\n")) {
    if (!line.trim()) continue;
    const [id, name, s, ago] = line.split("|");
    const statusIcon = s === "active" ? c.green("active") : c.yellow("disconnected");
    const agoStr = formatUptime(parseInt(ago));
    console.log(`  ${c.cyan(`#${id}`)} ${name.padEnd(15)} ${statusIcon.padEnd(25)} ${c.dim(agoStr + " ago")}`);
  }
}

async function logs() {
  const proc = Bun.spawn(["docker", "compose", "logs", "bot", "-f", "--tail", "50"], {
    cwd: BOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}

async function backup() {
  step("Running database backup");
  const result = await run(["bash", `${BOT_DIR}/scripts/backup-db.sh`]);
  result.ok ? done() : fail();
  if (result.output) console.log(`  ${result.output}`);
}

async function cleanup() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`\n  ${c.bold(dryRun ? "Cleanup (dry run)" : "Cleanup")}`);
  console.log(`  ${"─".repeat(40)}\n`);

  const jobs = [
    { name: "message-queue",    query: dryRun
        ? `SELECT COUNT(*) FROM message_queue WHERE delivered = true AND created_at < now() - interval '24 hours'`
        : `DELETE FROM message_queue WHERE delivered = true AND created_at < now() - interval '24 hours'` },
    { name: "request-logs",     query: dryRun
        ? `SELECT COUNT(*) FROM request_logs WHERE created_at < now() - interval '7 days'`
        : `DELETE FROM request_logs WHERE created_at < now() - interval '7 days'` },
    { name: "api-stats",        query: dryRun
        ? `SELECT COUNT(*) FROM api_request_stats WHERE created_at < now() - interval '30 days'`
        : `DELETE FROM api_request_stats WHERE created_at < now() - interval '30 days'` },
    { name: "orphan-sessions",  query: dryRun
        ? `SELECT COUNT(*) FROM sessions WHERE source != 'remote' AND status IN ('disconnected', 'terminated') AND id != 0`
        : `DELETE FROM sessions WHERE source != 'remote' AND status IN ('disconnected', 'terminated') AND id != 0` },
  ];

  let total = 0;
  for (const job of jobs) {
    const res = await run([
      "docker", "compose", "exec", "-T", "postgres",
      "psql", "-U", "helyx", "-d", "helyx", "-t", "-A", "-c", job.query,
    ], { silent: true });
    const count = parseInt(res.output?.trim() ?? "0") || 0;
    total += count;
    if (count > 0 || dryRun) {
      const label = dryRun ? `${count} would be removed` : `${count} removed`;
      console.log(`  ${count > 0 ? c.yellow("•") : c.dim("•")} ${job.name}: ${label}`);
    }
  }

  console.log(`\n  ${dryRun ? c.yellow(`Dry run: ${total} rows would be removed`) : c.green(`Done: ${total} rows removed`)}\n`);
}

async function prune() {
  console.log(`\n  ${c.bold("Session Cleanup")}`);
  console.log(`  ${"─".repeat(40)}\n`);

  // Show current sessions
  const query = await run([
    "docker", "compose", "exec", "-T", "postgres",
    "psql", "-U", "helyx", "-d", "helyx", "-t", "-A",
    "-c", "SELECT id, name, status, EXTRACT(EPOCH FROM (now() - last_active))::int as ago FROM sessions WHERE id != 0 ORDER BY id",
  ], { silent: true });

  if (!query.ok || !query.output.trim()) {
    console.log(`  No sessions found.`);
    return;
  }

  const sessions: { id: string; name: string; status: string; ago: number }[] = [];
  for (const line of query.output.split("\n")) {
    if (!line.trim()) continue;
    const [id, name, status, ago] = line.split("|");
    sessions.push({ id, name, status, ago: parseInt(ago) });
  }

  console.log(`  Current sessions:\n`);
  for (const s of sessions) {
    const icon = s.status === "active" ? c.green("active") : c.yellow("disconnected");
    const agoStr = formatUptime(s.ago);
    console.log(`  ${c.cyan(`#${s.id}`)} ${s.name.padEnd(15)} ${icon}  ${c.dim(agoStr + " ago")}`);
  }

  // Find stale: inactive > 1 hour, unnamed (cli-*), or duplicates
  const staleIds: string[] = [];
  const seenPaths = new Set<string>();

  // Get project paths
  const pathQuery = await run([
    "docker", "compose", "exec", "-T", "postgres",
    "psql", "-U", "helyx", "-d", "helyx", "-t", "-A",
    "-c", "SELECT id, name, project_path FROM sessions WHERE id != 0 ORDER BY id",
  ], { silent: true });

  const pathMap = new Map<string, string>();
  for (const line of (pathQuery.output ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [id, , path] = line.split("|");
    pathMap.set(id, path ?? "");
  }

  for (const s of sessions) {
    const path = pathMap.get(s.id) ?? "";
    // cli-* unnamed
    if (s.name.startsWith("cli-")) {
      staleIds.push(s.id);
      continue;
    }
    // duplicate project_path
    if (path && seenPaths.has(path)) {
      staleIds.push(s.id);
      continue;
    }
    if (path) seenPaths.add(path);
    // inactive > 2 hours
    if (s.ago > 7200 && s.status !== "active") {
      staleIds.push(s.id);
    }
  }

  if (staleIds.length === 0) {
    console.log(`\n  ${c.green("Nothing to clean.")}`);
    return;
  }

  const staleNames = sessions.filter(s => staleIds.includes(s.id)).map(s => `#${s.id} ${s.name}`);
  console.log(`\n  Will remove ${c.yellow(String(staleIds.length))} sessions:`);
  for (const name of staleNames) {
    console.log(`    ${c.red("×")} ${name}`);
  }

  const confirm = ask("\n  Proceed? (y/n)", "y");
  if (confirm.toLowerCase() !== "y") {
    console.log("  Cancelled.");
    return;
  }

  await run([
    "docker", "compose", "exec", "-T", "postgres",
    "psql", "-U", "helyx", "-d", "helyx", "-t", "-A",
    "-c", `DELETE FROM sessions WHERE id IN (${staleIds.join(",")});
      SELECT setval('sessions_id_seq', GREATEST((SELECT MAX(id) FROM sessions), 1));`,
  ], { silent: true });

  console.log(`\n  ${c.green(`Removed ${staleIds.length} sessions. Sequence reset.`)}`);
}

// --- Tmux management ---

const TMUX_SESSION = "bots";

type Project = { name: string; path: string };

/** Run a psql query via docker compose exec, return rows as pipe-separated strings. */
async function dbQuery(sql: string): Promise<{ ok: boolean; rows: string[] }> {
  const result = await run([
    "docker", "compose", "exec", "-T", "postgres",
    "psql", "-U", "helyx", "-d", "helyx", "-t", "-A", "-c", sql,
  ], { silent: true });
  const rows = result.output.split("\n").map(l => l.trim()).filter(Boolean);
  return { ok: result.ok, rows };
}

async function loadProjects(): Promise<Project[]> {
  const { ok, rows } = await dbQuery("SELECT name, path FROM projects ORDER BY created_at");
  if (!ok || rows.length === 0) return [];
  return rows.map(row => {
    const [name, ...rest] = row.split("|");
    return { name: name.trim(), path: rest.join("|").trim() };
  });
}

function windowName(p: Project): string {
  return p.name;
}

async function startWindow(p: Project, first: boolean, usePanes: boolean, paneCount: number): Promise<void> {
  const wname = windowName(p);
  const cmd = `${BOT_DIR}/scripts/run-cli.sh ${p.path}`;

  if (first) {
    await run(["tmux", "new-session", "-d", "-s", TMUX_SESSION, "-n", wname, "-c", p.path]);
    // Use window index 0 to avoid race with shell renaming the window title
    await run(["tmux", "send-keys", "-t", `${TMUX_SESSION}:0`, cmd, "Enter"]);
  } else if (usePanes) {
    const direction = paneCount % 2 === 0 ? "-v" : "-h";
    await run(["tmux", "split-window", direction, "-t", TMUX_SESSION, "-c", p.path]);
    await run(["tmux", "send-keys", "-t", TMUX_SESSION, cmd, "Enter"]);
    await run(["tmux", "select-layout", "-t", TMUX_SESSION, "tiled"]);
  } else {
    await run(["tmux", "new-window", "-t", TMUX_SESSION, "-n", wname, "-c", p.path]);
    await run(["tmux", "send-keys", "-t", `${TMUX_SESSION}:${wname}`, cmd, "Enter"]);
  }
}

async function ensureAdminDaemon(): Promise<void> {
  const running = await run(["pgrep", "-f", "admin-daemon.ts"], { silent: true });
  if (running.ok) {
    console.log(`  ${c.dim("·")} admin-daemon — already running`);
    return;
  }
  const logFile = "/tmp/admin-daemon.log";
  Bun.spawn(["bun", resolve(BOT_DIR, "scripts/admin-daemon.ts")], {
    stdout: Bun.file(logFile),
    stderr: Bun.file(logFile),
    stdin: "ignore",
    cwd: BOT_DIR,
  });
  console.log(`  ${c.green("✓")} admin-daemon — started (log: ${logFile})`);
}

async function tmuxStart() {
  const exists = await run(["tmux", "has-session", "-t", TMUX_SESSION], { silent: true });

  let projects = await loadProjects();
  if (projects.length === 0) {
    console.log(`\n  ${c.yellow("No projects configured.")}`);
    console.log(`  Add projects first:\n`);
    console.log(`    ${c.cyan("helyx add /path/to/project")}`);
    console.log(`    ${c.cyan("helyx add .")} ${c.dim("(current directory)")}`);
    console.log(`    ${c.cyan("helyx add . --name work-session")} ${c.dim("(custom session name)")}\n`);
    return;
  }

  const usePanes = process.argv.includes("--split") || process.argv.includes("-s");

  if (exists.ok) {
    // Session already running — start any missing windows
    console.log(`\n  ${c.bold("Session")} ${c.cyan(TMUX_SESSION)} ${c.dim("already running — starting missing windows...")}\n`);
    let started = 0;
    for (const p of projects) {
      if (!existsSync(p.path)) continue;
      const wname = windowName(p);
      const winExists = await run(["tmux", "has-session", "-t", `${TMUX_SESSION}:${wname}`], { silent: true });
      if (winExists.ok) {
        console.log(`  ${c.dim("·")} ${wname} — already running`);
      } else {
        await run(["tmux", "new-window", "-t", TMUX_SESSION, "-n", wname, "-c", p.path]);
        const cmd = `${BOT_DIR}/scripts/run-cli.sh ${p.path}`;
        await run(["tmux", "send-keys", "-t", `${TMUX_SESSION}:${wname}`, cmd, "Enter"]);
        console.log(`  ${c.green("✓")} ${wname} — started`);
        started++;
      }
    }
    if (started === 0) {
      console.log(`\n  ${c.dim("All windows already running.")}`);
    }
    console.log(`\n  Attach: ${c.cyan(`tmux attach -t ${TMUX_SESSION}`)}`);
    await ensureAdminDaemon();
    return;
  }

  console.log(`\n  ${c.bold("Starting tmux session")} ${c.cyan(TMUX_SESSION)}${usePanes ? " (split panes)" : ""}\n`);

  let first = true;
  let paneCount = 0;
  for (const p of projects) {
    if (!existsSync(p.path)) {
      console.log(`  ${c.yellow("SKIP")} ${p.name} — ${p.path} not found`);
      continue;
    }

    const wname = windowName(p);
    await startWindow(p, first, usePanes, paneCount);
    first = false;
    paneCount++;
    console.log(`  ${c.green("✓")} ${wname} — ${p.path}`);
  }

  console.log(`\n  ${c.green("Done!")} Attach: ${c.cyan(`tmux attach -t ${TMUX_SESSION}`)}`);
  if (usePanes) {
    console.log(`  Navigate: ${c.dim("Ctrl+B,Arrow — switch pane / Ctrl+B,Z — zoom pane")}`);
  } else {
    console.log(`  Navigate: ${c.dim("Ctrl+B,N (next) / Ctrl+B,P (prev) / Ctrl+B,W (list)")}`);
  }

  await ensureAdminDaemon();

  if (process.argv.includes("--attach") || process.argv.includes("-a")) {
    const proc = Bun.spawn(["tmux", "attach", "-t", TMUX_SESSION], {
      stdout: "inherit", stderr: "inherit", stdin: "inherit",
    });
    await proc.exited;
  }
}

async function tmuxAttach(dir?: string) {
  // Check tmux session is running
  const exists = await run(["tmux", "has-session", "-t", TMUX_SESSION], { silent: true });
  if (!exists.ok) {
    console.log(c.red(`  Tmux session '${TMUX_SESSION}' not running. Start it first: helyx up`));
    return;
  }

  // Resolve directory
  let resolvedDir = dir;
  if (!resolvedDir || resolvedDir.startsWith("--")) resolvedDir = ".";
  const projectDir = resolve(resolvedDir);
  if (!existsSync(projectDir)) {
    console.log(c.red(`  Directory not found: ${projectDir}`));
    return;
  }

  const name = basename(projectDir);
  const wname = windowName({ name, path: projectDir });
  const cmd = `${BOT_DIR}/scripts/run-cli.sh ${projectDir}`;

  // Check if window already exists
  const winExists = await run(["tmux", "has-session", "-t", `${TMUX_SESSION}:${wname}`], { silent: true });
  if (winExists.ok) {
    console.log(`  ${c.yellow(`Window '${wname}' already exists in session '${TMUX_SESSION}'.`)}`);
    if (!process.env.TMUX) {
      const attach = Bun.spawn(["tmux", "attach", "-t", TMUX_SESSION], {
        stdout: "inherit", stderr: "inherit", stdin: "inherit",
      });
      await attach.exited;
    }
    return;
  }

  // Add new window to existing session
  await run(["tmux", "new-window", "-t", TMUX_SESSION, "-n", wname, "-c", projectDir]);
  await run(["tmux", "send-keys", "-t", `${TMUX_SESSION}:${wname}`, cmd, "Enter"]);
  console.log(`  ${c.green("✓")} Added window: ${wname}`);

  // Attach if not inside tmux
  if (!process.env.TMUX) {
    console.log(`  Attaching to ${c.cyan(TMUX_SESSION)}...\n`);
    const attach = Bun.spawn(["tmux", "attach", "-t", `${TMUX_SESSION}:${wname}`], {
      stdout: "inherit", stderr: "inherit", stdin: "inherit",
    });
    await attach.exited;
  } else {
    console.log(`  Switch to window: ${c.cyan(`Ctrl+B, '${wname}'`)}`);
  }
}

async function tmuxStop() {
  step("Killing tmux session");
  await run(["tmux", "kill-session", "-t", TMUX_SESSION], { silent: true });
  done();

  step("Cleaning DB sessions");
  await run([
    "docker", "compose", "exec", "-T", "postgres",
    "psql", "-U", "helyx", "-d", "helyx", "-c",
    "DELETE FROM sessions WHERE name LIKE 'cli-%'; UPDATE sessions SET status = 'inactive', lease_owner = NULL, lease_expires_at = NULL WHERE source = 'remote' AND id != 0;",
  ], { silent: true });
  done();

  console.log(`\n  ${c.green("Tmux sessions stopped, standalone untouched.")}`);
  console.log(`  Restart: ${c.cyan("helyx up")}`);
}

async function tmuxAdd(dir?: string) {
  console.log(`\n  ${c.bold("Add project")}\n`);

  // Ask for path interactively if not given
  let resolvedDir = dir;
  if (!resolvedDir || resolvedDir === "--name") {
    resolvedDir = ask("Project path", ".");
  }
  const projectDir = resolve(resolvedDir);
  if (!existsSync(projectDir)) {
    console.log(c.red(`  Directory not found: ${projectDir}`));
    return;
  }

  // Parse --name flag
  const nameIdx = process.argv.indexOf("--name");
  const customName = nameIdx >= 0 ? process.argv[nameIdx + 1] : undefined;
  const name = customName ?? basename(projectDir);

  // Upsert into DB
  const escapedName = name.replace(/'/g, "''");
  const escapedPath = projectDir.replace(/'/g, "''");
  const { ok } = await dbQuery(
    `INSERT INTO projects (name, path, tmux_session_name) VALUES ('${escapedName}', '${escapedPath}', '${escapedName}')
     ON CONFLICT (path) DO UPDATE SET name = EXCLUDED.name, tmux_session_name = EXCLUDED.name`
  );
  if (!ok) {
    console.log(c.red(`  Failed to save project to DB. Is Docker running?`));
    return;
  }
  console.log(`  ${c.green("✓")} Saved: ${windowName({ name, path: projectDir })}`);
  console.log(`\n  ${c.dim(`Run: helyx up to start all projects`)}`);
}

async function tmuxRun(dir?: string) {
  // Resolve directory
  let resolvedDir = dir;
  if (!resolvedDir || resolvedDir.startsWith("--")) resolvedDir = ".";
  const projectDir = resolve(resolvedDir);
  if (!existsSync(projectDir)) {
    console.log(c.red(`  Directory not found: ${projectDir}`));
    return;
  }

  console.log(`  ${c.green("Starting Claude Code...")} ${c.dim("(Ctrl+C to stop)")}\n`);
  const proc = Bun.spawn(
    ["bash", `${BOT_DIR}/scripts/run-cli.sh`, projectDir],
    { stdout: "inherit", stderr: "inherit", stdin: "inherit", cwd: projectDir },
  );
  await proc.exited;
}

async function tmuxRemove(name?: string) {
  if (!name) {
    console.log(c.red("  Usage: helyx remove <project-name>"));
    return;
  }

  const escaped = name.replace(/'/g, "''");
  const { ok, rows } = await dbQuery(
    `DELETE FROM projects WHERE name = '${escaped}' OR path LIKE '%/${escaped}' RETURNING name`
  );
  if (!ok || rows.length === 0) {
    console.log(`  ${c.yellow(name)} not found in DB.`);
    return;
  }

  console.log(`  ${c.green("Removed:")} ${name}`);
}

async function tmuxList() {
  const projects = await loadProjects();
  console.log(`\n  ${c.bold("Projects")}`);
  console.log(`  ${"─".repeat(50)}`);

  // Check tmux status
  const tmuxRunning = (await run(["tmux", "has-session", "-t", TMUX_SESSION], { silent: true })).ok;

  for (const p of projects) {
    const exists = existsSync(p.path);
    const wname = windowName(p);
    let tmuxStatus = "";
    if (tmuxRunning) {
      const capture = await run(["tmux", "capture-pane", "-t", `${TMUX_SESSION}:${wname}`, "-p"], { silent: true });
      tmuxStatus = capture.ok ? c.green(" [running]") : c.dim(" [no window]");
    }
    const dirStatus = exists ? "" : c.red(" (dir missing)");
    console.log(`  ${exists ? c.green("●") : c.red("●")} ${c.cyan(wname)} — ${p.path}${dirStatus}${tmuxStatus}`);
  }

  if (!tmuxRunning) {
    console.log(`\n  ${c.dim(`tmux not running. Start: helyx up`)}`);
  }
}

async function connect(dir?: string) {
  const projectDir = resolve(dir ?? ".");
  if (!existsSync(projectDir)) {
    console.log(c.red(`  Directory not found: ${projectDir}`));
    return;
  }

  const name = basename(projectDir);
  const useTmux = process.argv.includes("--tmux") || process.argv.includes("-t");

  if (useTmux) {
    // Check if tmux session already exists
    const exists = await run(["tmux", "has-session", "-t", name], { silent: true });
    if (exists.ok) {
      if (process.env.TMUX) {
        console.log(`  tmux session ${c.cyan(name)} already running.`);
        console.log(`  ${c.dim("You're inside tmux. Detach first (Ctrl+B, D), then:")} ${c.cyan(`tmux attach -t ${name}`)}`);
      } else {
        console.log(`  tmux session ${c.cyan(name)} already exists. Attaching...`);
        const proc = Bun.spawn(["tmux", "attach", "-t", name], {
          stdout: "inherit", stderr: "inherit", stdin: "inherit",
        });
        await proc.exited;
      }
      return;
    }

    // Create tmux session with claude
    console.log(`  Starting ${c.cyan(name)} in tmux (full Telegram monitoring)...\n`);
    await run(["tmux", "new-session", "-d", "-s", name, "-c", projectDir]);
    await run(["tmux", "send-keys", "-t", name,
      "claude --dangerously-load-development-channels server:helyx-channel", "Enter"]);

    // Wait for channel confirmation prompt and auto-confirm
    console.log(`  Waiting for Claude to start...`);
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const capture = await run(["tmux", "capture-pane", "-t", name, "-p"], { silent: true });
      if (capture.output.includes("Enter to confirm")) {
        await run(["tmux", "send-keys", "-t", name, "Enter"]);
        console.log(`  ${c.green("Channel confirmed!")}`);
        break;
      }
      if (capture.output.includes("Listening for channel")) {
        console.log(`  ${c.green("Already listening!")}`);
        break;
      }
    }

    console.log(`  ${c.green("Started!")} tmux session: ${c.cyan(name)}`);
    console.log(`  Attach: ${c.dim(`tmux attach -t ${name}`)}`);
    console.log(`  Detach: ${c.dim("Ctrl+B, D")}\n`);
  } else {
    console.log(`  Connecting ${c.cyan(name)} to Telegram bot...`);
    console.log(`  ${c.dim("Tip: use --tmux for full progress monitoring in Telegram")}\n`);
    const proc = Bun.spawn(
      ["claude", "--dangerously-load-development-channels", "server:helyx-channel"],
      { cwd: projectDir, stdout: "inherit", stderr: "inherit", stdin: "inherit" },
    );
    await proc.exited;
  }
}

/**
 * Install shared MCP HTTP services (playwright, context7) as systemd user units.
 * These replace per-session stdio forks with a single shared HTTP process.
 *
 * playwright: port 3011, --isolated (separate browser context per session)
 * context7:   port 3010, --transport http (stateless, fully shareable)
 *
 * Registered in ~/.claude.json via `claude mcp add --transport http`.
 * Old stdio entries are removed to avoid duplicate loading.
 */
async function installMcpSharedServices(): Promise<void> {
  const home = process.env.HOME ?? homedir();
  const npx = await run(["which", "npx"], { silent: true });
  const npxBin = npx.stdout?.trim() || "/usr/bin/npx";
  const nodeBin = basename(dirname(npxBin));
  const nodeDir = dirname(npxBin);

  const systemdDir = `${home}/.config/systemd/user`;
  await run(["mkdir", "-p", systemdDir], { silent: true });

  const playwrightSvc = `[Unit]
Description=Playwright MCP Server (shared HTTP, isolated contexts)
After=network.target

[Service]
Type=simple
ExecStart=${npxBin} @playwright/mcp@latest --port 3011 --isolated
Restart=on-failure
RestartSec=5
Environment=HOME=${home}
Environment=PATH=${nodeDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${home}/.local/bin
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;

  const context7Svc = `[Unit]
Description=Context7 MCP Server (shared HTTP transport)
After=network.target

[Service]
Type=simple
ExecStart=${npxBin} @upstash/context7-mcp --transport http --port 3010
Restart=on-failure
RestartSec=5
Environment=HOME=${home}
Environment=PATH=${nodeDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${home}/.local/bin
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;

  step("Installing shared MCP systemd services (playwright :3011, context7 :3010)");
  await Bun.write(`${systemdDir}/mcp-playwright.service`, playwrightSvc);
  await Bun.write(`${systemdDir}/mcp-context7.service`, context7Svc);
  await run(["systemctl", "--user", "daemon-reload"], { silent: true });
  await run(["systemctl", "--user", "enable", "mcp-playwright", "mcp-context7"], { silent: true });
  await run(["systemctl", "--user", "start", "mcp-playwright", "mcp-context7"], { silent: true });
  done();

  step("Registering shared MCP servers in Claude Code (HTTP)");
  // Remove old stdio entries (from external_plugins or previous installs)
  await run(["claude", "mcp", "remove", "playwright", "-s", "user"], { silent: true });
  await run(["claude", "mcp", "remove", "context7", "-s", "user"], { silent: true });
  // Remove external_plugins .mcp.json to prevent stdio duplication
  const pluginsBase = `${home}/.claude/plugins/marketplaces/claude-plugins-official/external_plugins`;
  for (const plugin of ["playwright", "context7"]) {
    const mcpJson = `${pluginsBase}/${plugin}/.mcp.json`;
    if (existsSync(mcpJson)) {
      await run(["mv", mcpJson, `${mcpJson}.bak`], { silent: true });
    }
  }
  // Register HTTP endpoints
  await run(["claude", "mcp", "add", "--transport", "http", "-s", "user", "playwright", "http://localhost:3011/mcp"]);
  await run(["claude", "mcp", "add", "--transport", "http", "-s", "user", "context7", "http://localhost:3010/mcp"]);
  done();
}

async function mcpRegister() {
  const envPath = `${BOT_DIR}/.env`;
  if (!existsSync(envPath)) {
    console.log(c.red("  .env not found. Run 'bun cli.ts setup' first."));
    return;
  }

  // Read values from .env
  const env = Object.fromEntries(
    (await Bun.file(envPath).text())
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("=").map((s) => s.trim()))
      .filter((p) => p.length === 2),
  );

  const port = env.PORT ?? "3847";
  const dbUrl = env.DATABASE_URL ?? "";
  const ollamaUrl = env.OLLAMA_URL ?? "http://localhost:11434";
  const botToken = env.TELEGRAM_BOT_TOKEN ?? "";

  step("Removing old MCP registrations");
  await run(["claude", "mcp", "remove", "helyx", "-s", "user"], { silent: true });
  await run(["claude", "mcp", "remove", "helyx-channel", "-s", "user"], { silent: true });
  done();

  step("Registering HTTP MCP server");
  await run(["claude", "mcp", "add", "--transport", "http", "-s", "user", "helyx", `http://localhost:${port}/mcp`]);
  done();

  step("Registering stdio channel adapter");
  const config = JSON.stringify({
    type: "stdio",
    command: "bun",
    args: [`${BOT_DIR}/channel.ts`],
    env: { DATABASE_URL: dbUrl, OLLAMA_URL: ollamaUrl, TELEGRAM_BOT_TOKEN: botToken },
  });
  await run(["claude", "mcp", "add-json", "-s", "user", "helyx-channel", config]);
  done();

  await installMcpSharedServices();

  step("Adding MCP permissions to Claude settings");
  const claudeSettingsPath = `${process.env.HOME}/.claude/settings.json`;
  try {
    const raw = existsSync(claudeSettingsPath) ? await Bun.file(claudeSettingsPath).text() : "{}";
    const settings = JSON.parse(raw);
    if (!settings.permissions) settings.permissions = {};
    if (!settings.permissions.allow) settings.permissions.allow = [];
    const toAdd = ["mcp__helyx__*", "mcp__helyx-channel__*"];
    for (const perm of toAdd) {
      if (!settings.permissions.allow.includes(perm)) {
        settings.permissions.allow.push(perm);
      }
    }
    await Bun.write(claudeSettingsPath, JSON.stringify(settings, null, 2));
  } catch (err: any) {
    console.warn(`  ${c.yellow("warn:")} could not update Claude settings: ${err?.message}`);
  }
  done();

  console.log(`\n  ${c.green("MCP servers registered.")}`);
}

// --- Remote setup ---

async function remote() {
  console.log(`\n  ${c.bold("Remote Client Setup")}`);
  console.log(`  ${c.dim("Connect your laptop to a bot running on a remote server")}`);
  console.log(`  ${"─".repeat(50)}\n`);

  const serverHost = ask("Server hostname or IP");
  if (!serverHost) {
    console.log(c.red("\n  Server address is required."));
    return;
  }

  const serverUser = ask("SSH user", process.env.USER ?? "");
  const botPort = ask("Bot port on server", "3847");
  const dbPort = ask("PostgreSQL port on server", "5433");
  const botToken = ask("Telegram Bot Token (same as on server)");
  const botPath = ask("Path to helyx on server", "/home/" + serverUser + "/bots/helyx");

  // Method choice
  const methodIdx = askChoice("Connection method:", [
    "SSH tunnel (full features — channel notifications, memory, reply)",
    "HTTP only (simple — no channel notifications, use MCP tools manually)",
  ]);

  if (methodIdx === 0) {
    // SSH tunnel method
    console.log(`\n  ${c.bold("Step 1:")} Start SSH tunnel (run in a separate terminal):\n`);
    console.log(`  ${c.cyan(`ssh -L ${botPort}:localhost:${botPort} -L ${dbPort}:localhost:${dbPort} ${serverUser}@${serverHost}`)}\n`);

    console.log(`  ${c.bold("Step 2:")} Register MCP servers (run now):\n`);

    const registerNow = ask("Register MCP servers now? (y/n)", "y");
    if (registerNow.toLowerCase() === "y") {
      step("Removing old MCP registrations");
      await run(["claude", "mcp", "remove", "helyx", "-s", "user"], { silent: true });
      await run(["claude", "mcp", "remove", "helyx-channel", "-s", "user"], { silent: true });
      done();

      step("Registering HTTP MCP server");
      await run(["claude", "mcp", "add", "--transport", "http", "-s", "user", "helyx", `http://localhost:${botPort}/mcp`]);
      done();

      step("Registering stdio channel adapter");
      const channelConfig = JSON.stringify({
        type: "stdio",
        command: "bun",
        args: [`${botPath}/channel.ts`],
        env: {
          DATABASE_URL: `postgres://helyx:helyx_secret@localhost:${dbPort}/helyx`,
          OLLAMA_URL: `http://localhost:11434`,
          TELEGRAM_BOT_TOKEN: botToken,
        },
      });
      await run(["claude", "mcp", "add-json", "-s", "user", "helyx-channel", channelConfig]);
      done();

      console.log(`\n  ${c.yellow("Important:")} channel.ts runs locally but connects to server DB via tunnel.`);
      console.log(`  Make sure ${c.cyan("bun")} and ${c.cyan(botPath + "/channel.ts")} exist on this machine.`);
      console.log(`  If not, clone the repo locally too.\n`);
    }

    console.log(`  ${c.bold("Step 3:")} Connect a project:\n`);
    console.log(`  ${c.cyan("cd your-project")}`);
    console.log(`  ${c.cyan("claude --dangerously-load-development-channels server:helyx-channel")}\n`);

  } else {
    // HTTP-only method
    console.log(`\n  ${c.bold("Step 1:")} Ensure bot port is accessible from your network.`);
    console.log(`  ${c.dim("Option A: SSH tunnel —")} ${c.cyan(`ssh -L ${botPort}:localhost:${botPort} ${serverUser}@${serverHost}`)}`);
    console.log(`  ${c.dim("Option B: Open port —")} expose port ${botPort} on server (less secure)\n`);

    const registerNow = ask("Register HTTP MCP server now? (y/n)", "y");
    if (registerNow.toLowerCase() === "y") {
      step("Removing old MCP registration");
      await run(["claude", "mcp", "remove", "helyx", "-s", "user"], { silent: true });
      done();

      step("Registering HTTP MCP server");
      await run(["claude", "mcp", "add", "--transport", "http", "-s", "user", "helyx", `http://localhost:${botPort}/mcp`]);
      done();
    }

    console.log(`\n  ${c.bold("Step 2:")} Use Claude Code with MCP tools (no channel needed):\n`);
    console.log(`  ${c.cyan("cd your-project")}`);
    console.log(`  ${c.cyan("claude")}\n`);
    console.log(`  Available tools: ${c.dim("reply, remember, recall, list_sessions, set_session_name, ...")}`);
    console.log(`  ${c.yellow("Note:")} No channel notifications — Telegram messages won't auto-push to CLI.`);
    console.log(`  Use ${c.cyan("reply")} tool to send messages back to Telegram.\n`);
  }

  console.log(`  ${c.green("Setup complete!")}`);
}

// --- Internal: disconnect session by project path ---

async function internalDisconnect() {
  const args = process.argv.slice(3);
  const get = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const projectPath = get("--path");
  if (!projectPath) return;

  const port = process.env.PORT ?? "3847";
  try {
    await fetch(`http://localhost:${port}/api/sessions/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath }),
    });
  } catch { /* bot may be unavailable, ignore */ }
}

// --- Internal: register session via HTTP (runs inside container where localhost=127.0.0.1) ---

async function internalRegister() {
  const args = process.argv.slice(3);
  const get = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const projectPath = get("--path");
  const name = get("--name");

  if (!projectPath) { console.error("_register: --path required"); process.exit(1); }

  const port = process.env.PORT ?? "3847";
  try {
    const res = await fetch(`http://localhost:${port}/api/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath, cliType: "claude", cliConfig: {}, name }),
    });
    const data = await res.json() as { ok?: boolean; sessionId?: number; name?: string; error?: string };
    if (res.ok) {
      console.log(`  ${c.green("✓")} ${data.name ?? name ?? projectPath} — session #${data.sessionId}`);
    } else {
      console.error(`  ${c.red("Registration failed:")} ${data.error ?? res.status}`);
      process.exit(1);
    }
  } catch (err: unknown) {
    console.error(`  ${c.red("Bot API unreachable:")} ${(err as Error).message}`);
    process.exit(1);
  }
}

// --- Utilities ---

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function help() {
  console.log(`
  ${c.bold("Helyx CLI")}

  ${c.bold("Usage:")} bun cli.ts <command>

  ${c.bold("Setup:")}
    setup           Interactive installation wizard (server)
    remote          Connect laptop to a remote bot server
    mcp-register    Re-register MCP servers in Claude Code

  ${c.bold("Bot (Docker service):")}
    bot-start       Start bot (docker compose up -d)
    bot-stop        Stop bot + all tmux sessions
    bot-restart     Rebuild and restart bot container
    bot-status      Show bot health and stats
    bot-logs        Show bot logs (follow mode)

  ${c.bold("Tmux (project workspaces):")}
    up [-a] [-s]    Start all projects in tmux (-a attach, -s split panes)
    down            Stop all tmux sessions + clean DB
    bounce [-a] [-s] Restart tmux (down + up)
    ps              List configured projects and status
    add [dir]       Add project (saves to config + registers in bot DB)
    run [dir]       Launch project in current terminal (full monitoring)
    attach [dir]    Add project window to running tmux session
    remove <name>   Remove project from tmux config

  ${c.bold("Session (Claude Code):")}
    open [dir]           Launch Claude Code locally (temp session)
    connect [dir]        Start session (default: current dir)
    connect [dir] --tmux Start in standalone tmux (not managed)

  ${c.bold("Data:")}
    sessions        List active sessions
    prune           Remove stale/duplicate sessions (interactive)
    backup          Run database backup
    cleanup [--dry-run]   Clean old queue, logs, stats
`);
}

// --- Main ---

const command = process.argv[2];

switch (command) {
  case "setup":       await setup(); break;
  case "remote":      await remote(); break;
  // Bot (Docker service)
  case "bot-start":   await dockerStart(); break;
  case "bot-stop":    await stop(); break;
  case "bot-restart": await restart(); break;
  case "bot-status":  await status(); break;
  case "bot-logs":    await logs(); break;
  // Session (Claude Code)
  case "open":        await start(process.argv[3]); break;
  case "connect":     await connect(process.argv[3]); break;
  // Data
  case "sessions":    await sessions(); break;
  case "backup":      await backup(); break;
  case "prune":       await prune(); break;
  case "cleanup":     await cleanup(); break;
  // Setup
  case "mcp-register": await mcpRegister(); break;
  // Tmux
  case "up":          await tmuxStart(); break;
  case "down":        await tmuxStop(); break;
  case "bounce": {
    await tmuxStop();
    // Wait for the tmux session to fully terminate before starting
    for (let i = 0; i < 10; i++) {
      const exists = await run(["tmux", "has-session", "-t", TMUX_SESSION], { silent: true });
      if (!exists.ok) break;
      await Bun.sleep(500);
    }
    await tmuxStart();
    break;
  }
  case "ps":          await tmuxList(); break;
  case "add":         await tmuxAdd(process.argv[3]); break;
  case "run":         await tmuxRun(process.argv[3]); break;
  case "attach":      await tmuxAttach(process.argv[3]); break;
  case "remove":      await tmuxRemove(process.argv[3]); break;
  case "_register":    await internalRegister(); break;
  case "_disconnect":  await internalDisconnect(); break;
  // Legacy aliases (kept for backwards compat, not shown in help)
  case "start":       await start(process.argv[3]); break;
  case "docker-start": await dockerStart(); break;
  case "stop":        await stop(); break;
  case "restart":     await restart(); break;
  case "status":      await status(); break;
  case "logs":        await logs(); break;
  default:             help(); break;
}
