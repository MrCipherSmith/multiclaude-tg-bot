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

import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
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

  // 0. Existing-install guard.
  //
  // PRD §16.1 p.8: "Never overwrite secrets without explicit confirmation."
  // The wizard ends with `Bun.write(.env)` which destroys the existing file
  // unconditionally. If a user re-runs `helyx setup` (e.g. to pick up new
  // questions added by a later release), they must NOT silently lose their
  // bot token, API keys, and DB password.
  //
  // Three options:
  //   1. Re-run wizard, overwrite .env (destructive — we will ask the user
  //      to type "yes" before doing this; otherwise we abort).
  //   2. Run only the post-setup steps against the existing .env (no
  //      questions; just deps install + Docker up + migrations + MCP
  //      registration).
  //   3. Cancel.
  //
  // For (2), the wizard skips ahead to the install phase. This means new
  // env vars (e.g. DEFAULT_RUNTIME_DRIVER added in PRD §16.3) are NOT
  // automatically appended — the user is expected to read .env.example
  // and merge by hand. A future `helyx setup-agents` (P1) provides a
  // safer additive path.
  const envPath = `${BOT_DIR}/.env`;
  let skipQuestions = false;
  if (existsSync(envPath)) {
    console.log(`  ${c.yellow("⚠")} An existing .env was found at ${c.dim(envPath)}\n`);
    const choice = askChoice("How should we proceed?", [
      "Run install steps only (preserve existing .env — recommended for upgrades)",
      "Re-run full wizard (will OVERWRITE .env, all secrets must be re-entered)",
      "Cancel",
    ]);
    if (choice === 2) {
      console.log(`\n  ${c.dim("Aborted by user.")}`);
      return;
    }
    if (choice === 1) {
      const confirm = ask(
        `Type ${c.bold("yes")} to confirm overwriting .env (anything else cancels)`,
      );
      if (confirm.trim().toLowerCase() !== "yes") {
        console.log(`\n  ${c.dim("Aborted — .env preserved.")}`);
        return;
      }
    } else {
      skipQuestions = true;
    }
  }

  // Pre-declare shared vars; both branches (questions vs skip) set them.
  let useDocker: boolean;
  let port: string;
  let dbUrl: string;
  let botToken: string;

  // Pre-declare wave-3 (PRD §17.2) vars at outer scope so the post-migration
  // seed step (wave-4 — model_profiles) can read them after the questions
  // block closes. The skip-questions branch leaves them at safe defaults
  // and skips the seed step entirely.
  let createDefaultAgents = false;
  let createPlannerReviewer = false;
  let plannerReviewerProvider = "";
  let plannerReviewerProviderName = "";
  let plannerReviewerBaseUrl = "";
  let plannerReviewerApiKey = "";
  let plannerReviewerKeyEnv = "";
  let plannerModel = "";
  let reviewerModel = "";
  let orchestratorModel = "";

  // Skip-questions path: parse the existing .env, derive the few vars
  // needed by the post-questions install steps, and jump there.
  if (skipQuestions) {
    console.log(`\n  ${c.dim("Using existing .env. Running install steps only…")}\n`);
    const envContents = readFileSync(envPath, "utf8");
    const envMap: Record<string, string> = {};
    for (const line of envContents.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) envMap[m[1]!] = m[2]!;
    }
    // Heuristic: Docker mapping uses port 5433; manual install uses 5432.
    useDocker = (envMap.DATABASE_URL ?? "").includes(":5433/");
    port = envMap.PORT ?? "3847";
    dbUrl = envMap.DATABASE_URL ?? "";
    botToken = envMap.TELEGRAM_BOT_TOKEN ?? "";
  } else {

  // 1. Deployment type
  const deployIdx = askChoice("Deployment type:", [
    "Docker (recommended — PostgreSQL included)",
    "Manual (PostgreSQL + Ollama already installed)",
  ]);
  useDocker = deployIdx === 0;

  // 2. Telegram
  console.log();
  botToken = ask("Telegram Bot Token (from @BotFather)");
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

  // 3b. Local Ollama for embeddings + summarization
  console.log();
  let ollamaEmbeddingModel = "nomic-embed-text";
  let summarizeModel = "";

  // Detect if Ollama is running locally
  const ollamaDetected = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);

  if (ollamaDetected) {
    console.log(`  ${c.green("✓")} Ollama detected at localhost:11434`);
    console.log(c.dim("  Ollama can power semantic memory search (embeddings) and fast local summarization."));
    console.log(c.dim("  Recommended: nomic-embed-text for embeddings, gemma4:e4b for summarization.\n"));

    const ollamaUseIdx = askChoice("Use Ollama for memory search + summarization?", [
      "Yes, use Ollama (recommended — free, offline)",
      "No, use main LLM provider (Claude/Google AI/etc.)",
    ]);

    if (ollamaUseIdx === 0) {
      ollamaEmbeddingModel = ask("Embedding model", "nomic-embed-text");
      summarizeModel = ask("Summarization model", "gemma4:e4b");
    }
  } else {
    console.log(c.dim("  Ollama not detected. Semantic memory search and local summarization will be disabled."));
    console.log(c.dim("  Install later: https://ollama.com/download → ollama pull nomic-embed-text\n"));
  }

  // 3c. Agent Runtime Configuration (PRD §17.2)
  //
  // Helyx is provider-agnostic: agents can run via different runtime drivers
  // (tmux/pty/docker/process) and different coding CLIs (claude-code, codex,
  // opencode, gemini). These four prompts configure the defaults; per-agent
  // overrides come later via /agents in Telegram or `helyx agent create`.
  //
  // The defaults written here also drive `helyx runtime doctor` checks —
  // e.g. tmux is only required if DEFAULT_RUNTIME_DRIVER=tmux.
  console.log();
  console.log(`  ${c.bold("Agent Runtime Configuration")}`);
  const driverIdx = askChoice("Default runtime driver for interactive coding agents:", [
    "tmux (recommended — works on existing installs)",
    "pty (experimental — no tmux dependency)",
    "docker (sandboxed — advanced)",
  ]);
  const defaultRuntimeDriver = ["tmux", "pty", "docker"][driverIdx] ?? "tmux";

  const codingIdx = askChoice("Default coding runtime:", [
    "claude-code (recommended if already installed)",
    "opencode",
    "codex-cli",
    "gemini-cli",
    "None — configure later",
  ]);
  const defaultCodingRuntime = ["claude-code", "opencode", "codex-cli", "gemini-cli", "none"][codingIdx] ?? "claude-code";

  const createDefaultAgentsIdx = askChoice("Create default project agents?", [
    "Yes — create a coder agent for every registered project",
    "No — I will configure agents manually via /agents",
  ]);
  createDefaultAgents = createDefaultAgentsIdx === 0;

  const createPlannerReviewerIdx = askChoice("Create planner + reviewer agents (use API models, not interactive CLIs)?", [
    "Yes — create planner + reviewer using API models",
    "No — coder agents only",
  ]);
  createPlannerReviewer = createPlannerReviewerIdx === 0;

  // model_providers.name lookup — populated below per-provider.
  let plannerReviewerProviderId = "";

  if (createPlannerReviewer) {
    const apiIdx = askChoice("API model provider for planner/reviewer:", [
      "OpenAI-compatible custom endpoint (DeepSeek, etc.)",
      "OpenRouter",
      "Anthropic",
      "Google AI",
      "Ollama (local)",
    ]);
    if (apiIdx === 0) {
      plannerReviewerProvider = "custom-openai";
      plannerReviewerProviderName = ask("Provider display name", "DeepSeek");
      plannerReviewerProviderId = ask("Provider ID (used in DB)", "deepseek-direct");
      plannerReviewerBaseUrl = ask("Base URL", "https://api.deepseek.com");
      plannerReviewerKeyEnv = ask("API key env name", "DEEPSEEK_API_KEY");
      plannerReviewerApiKey = ask("API key");
      plannerModel = ask("Planner model", "deepseek-chat");
      reviewerModel = ask("Reviewer model", "deepseek-chat");
      orchestratorModel = ask("Orchestrator model", "deepseek-chat");
    } else if (apiIdx === 1) {
      plannerReviewerProvider = "openrouter";
      plannerReviewerProviderId = "openrouter-default";
      plannerReviewerProviderName = "OpenRouter";
      plannerReviewerBaseUrl = "https://openrouter.ai/api/v1";
      plannerReviewerKeyEnv = "OPENROUTER_API_KEY";
      // Re-use the key already collected in step 3 if user picked OpenRouter
      // there; otherwise prompt for one.
      plannerReviewerApiKey = openrouterKey || ask("OpenRouter API Key");
      plannerModel = ask("Planner model", "deepseek/deepseek-chat");
      reviewerModel = ask("Reviewer model", "anthropic/claude-sonnet-4.5");
      orchestratorModel = ask("Orchestrator model", "deepseek/deepseek-chat");
    } else if (apiIdx === 2) {
      plannerReviewerProvider = "anthropic";
      plannerReviewerProviderId = "anthropic-default";
      plannerReviewerProviderName = "Anthropic";
      plannerReviewerBaseUrl = "https://api.anthropic.com";
      plannerReviewerKeyEnv = "ANTHROPIC_API_KEY";
      plannerReviewerApiKey = anthropicKey || ask("Anthropic API Key");
      plannerModel = ask("Planner model", "claude-haiku-4-5");
      reviewerModel = ask("Reviewer model", "claude-sonnet-4-6");
      orchestratorModel = ask("Orchestrator model", "claude-sonnet-4-6");
    } else if (apiIdx === 3) {
      plannerReviewerProvider = "google-ai";
      plannerReviewerProviderId = "google-ai-default";
      plannerReviewerProviderName = "Google AI";
      plannerReviewerBaseUrl = "https://generativelanguage.googleapis.com/v1";
      plannerReviewerKeyEnv = "GOOGLE_AI_API_KEY";
      plannerReviewerApiKey = googleAiKey || ask("Google AI API Key");
      plannerModel = ask("Planner model", "gemma-4-31b-it");
      reviewerModel = ask("Reviewer model", "gemma-4-31b-it");
      orchestratorModel = ask("Orchestrator model", "gemma-4-31b-it");
    } else {
      plannerReviewerProvider = "ollama";
      plannerReviewerProviderId = "ollama-default";
      plannerReviewerProviderName = "Ollama";
      plannerReviewerBaseUrl = "http://localhost:11434";
      plannerReviewerKeyEnv = ""; // no key needed
      plannerModel = ask("Planner model", "qwen3:8b");
      reviewerModel = ask("Reviewer model", "qwen3:8b");
      orchestratorModel = ask("Orchestrator model", "qwen3:8b");
    }

    // PRD §16.5 important limitation — surface to user before they wait
    // for an "agent" that can't actually edit files.
    console.log(`\n  ${c.yellow("Note:")} planner/reviewer/orchestrator agents reason and route tasks but`);
    console.log(`  ${c.dim("do not edit files or run commands until tool execution is configured.")}`);
    console.log(`  ${c.dim("Use Claude Code/OpenCode/Codex/Aider for code-writing agents.\n")}`);
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
  port = ask("Bot port", "3847");

  // Generate .env
  console.log();
  step("Creating .env");

  dbUrl = useDocker
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
    "# Ollama (embeddings + local summarization)",
    `OLLAMA_URL=http://localhost:11434`,
    `EMBEDDING_MODEL=${ollamaEmbeddingModel}`,
    ...(summarizeModel ? [`SUMMARIZE_MODEL=${summarizeModel}`] : [`# SUMMARIZE_MODEL=gemma4:e4b`]),
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
    "",
    "# Agent runtime (PRD §17.3)",
    `DEFAULT_RUNTIME_DRIVER=${defaultRuntimeDriver}`,
    `DEFAULT_CODING_RUNTIME=${defaultCodingRuntime}`,
    `AGENT_RECONCILE_INTERVAL_MS=5000`,
    `AGENT_HEARTBEAT_TIMEOUT_MS=120000`,
    `AGENT_RESTART_LIMIT=3`,
    ...(createPlannerReviewer ? [
      "",
      "# Planner / reviewer / orchestrator (API-based agents — PRD §17.3)",
      `DEFAULT_PLANNER_PROVIDER=${plannerReviewerProvider}`,
      `DEFAULT_PLANNER_MODEL=${plannerModel}`,
      `DEFAULT_REVIEWER_PROVIDER=${plannerReviewerProvider}`,
      `DEFAULT_REVIEWER_MODEL=${reviewerModel}`,
      `DEFAULT_ORCHESTRATOR_PROVIDER=${plannerReviewerProvider}`,
      `DEFAULT_ORCHESTRATOR_MODEL=${orchestratorModel}`,
      // For OpenAI-compatible custom endpoint, write the alias env vars too.
      // CUSTOM_OPENAI_* is the canonical name; DEEPSEEK_* is the alias.
      ...(plannerReviewerProvider === "custom-openai" ? [
        `CUSTOM_OPENAI_API_KEY=${plannerReviewerApiKey}`,
        `CUSTOM_OPENAI_BASE_URL=${plannerReviewerBaseUrl}`,
        `CUSTOM_OPENAI_DEFAULT_MODEL=${plannerModel}`,
        ...(plannerReviewerKeyEnv === "DEEPSEEK_API_KEY" ? [
          `DEEPSEEK_API_KEY=${plannerReviewerApiKey}`,
          `DEEPSEEK_BASE_URL=${plannerReviewerBaseUrl}`,
        ] : []),
      ] : []),
    ] : []),
  ];

  await Bun.write(`${BOT_DIR}/.env`, envLines.join("\n") + "\n");
  // Restrict to owner-read+write only (0600) — file contains TELEGRAM_BOT_TOKEN,
  // ANTHROPIC_API_KEY, GROQ_API_KEY, DB password, webhook secret. Bun.write
  // honors umask which on most Linux installs leaves 0644 (world-readable).
  try { chmodSync(`${BOT_DIR}/.env`, 0o600); } catch { /* best-effort — ignore on FS without modes */ }
  done();

  } // end of `if (!skipQuestions)` — install steps below run in BOTH branches

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

  // Seed planner/reviewer/orchestrator model_profiles (PRD §17.5).
  // The v22 migration already inserts default model_providers rows
  // (Anthropic, OpenRouter, Google AI, Ollama, DeepSeek). We only add
  // the role-specific profiles (planner-default / reviewer-default /
  // orchestrator-default) referencing the user's chosen provider. The
  // skip-questions branch leaves createPlannerReviewer=false → no-op.
  if (createPlannerReviewer && plannerReviewerProvider) {
    step("Seeding model_profiles for planner/reviewer/orchestrator");
    const seedOk = await seedModelProfiles({
      providerType: plannerReviewerProvider,
      providerName: plannerReviewerProviderName,
      providerBaseUrl: plannerReviewerBaseUrl,
      providerKeyEnv: plannerReviewerKeyEnv,
      plannerModel,
      reviewerModel,
      orchestratorModel,
      dbUrl,
    });
    seedOk ? done() : fail("seed failed (non-fatal — agents will still start, profile lookup falls back to env)");
  }

  // Seed per-project coder agent_instances (PRD §17.4 — Agent Bootstrap).
  // Conservative bootstrap: every existing project gets a `<project>:coder`
  // instance pointing to the claude-code-default definition with
  // desired_state='stopped'. The user starts them manually via /agents
  // when they want — never auto-start, never restart existing sessions.
  if (createDefaultAgents) {
    step("Bootstrapping per-project coder agents");
    const bootOk = await seedAgentBootstrap({ dbUrl });
    bootOk ? done() : fail("bootstrap failed (non-fatal — register agents manually via /agents)");
  }

  // Per-project planner/reviewer/orchestrator agent_instances. Now that
  // the standalone-llm runtime adapter exists (scripts/standalone-llm-
  // worker.ts) and migration v29 seeds the role definitions, the wizard
  // can safely create per-project instances. They land in
  // desired_state='stopped' (PRD §17.4 conservative bootstrap) — operator
  // starts them manually via `helyx agent start <project>:planner`.
  if (createPlannerReviewer) {
    step("Bootstrapping per-project planner/reviewer agents");
    const ok = await seedRoleAgentBootstrap({ dbUrl });
    ok ? done() : fail("planner/reviewer bootstrap failed (non-fatal — create manually via /agents)");
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

// --- Model profile seed (wave-4, PRD §17.5) ---

/**
 * Insert model_profiles rows for planner-default / reviewer-default /
 * orchestrator-default, all linked to the model_providers row that matches
 * the user-selected provider type. Idempotent — re-runs UPDATE existing
 * rows so wizard re-runs converge to the latest collected values.
 *
 * Returns false on any DB error so the caller can warn but continue (the
 * runtime LLM client falls back to env-var-driven profiles when no DB
 * profile exists, so this seed is a convenience, not a hard requirement).
 *
 * Connects directly via postgres.js using the .env DATABASE_URL — does NOT
 * import the project's `sql` singleton, since cli.ts may be invoked outside
 * a normal bot context (e.g. from `helyx setup` with the bot not yet up).
 */
async function seedModelProfiles(opts: {
  providerType: string;
  providerName: string;
  providerBaseUrl: string;
  providerKeyEnv: string;
  plannerModel: string;
  reviewerModel: string;
  orchestratorModel: string;
  dbUrl: string;
}): Promise<boolean> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(opts.dbUrl, { max: 2, onnotice: () => {} });
  try {
    // Look up model_providers.id by provider_type. The v22 bootstrap inserts
    // canonical names (Anthropic / OpenRouter / Google AI / Ollama / DeepSeek)
    // matched on (provider_type) when there's exactly one. If multiple
    // providers share a type (e.g. two openai-compatible custom endpoints),
    // we prefer the one matching `name` collected from the wizard, falling
    // back to provider_type otherwise.
    let providerId: number | null = null;
    const byName = (await sql`
      SELECT id FROM model_providers WHERE name = ${opts.providerName} LIMIT 1
    `) as { id: number }[];
    if (byName[0]) {
      providerId = Number(byName[0].id);
      // Refresh base_url / api_key_env / default_model in case the user
      // tweaked them in the wizard.
      await sql`
        UPDATE model_providers
        SET base_url      = ${opts.providerBaseUrl || null},
            api_key_env   = ${opts.providerKeyEnv || null},
            default_model = ${opts.plannerModel},
            updated_at    = now()
        WHERE id = ${providerId}
      `;
    } else {
      // Provider row not present — create it. Idempotent on (name).
      const inserted = (await sql`
        INSERT INTO model_providers (name, provider_type, base_url, api_key_env, default_model)
        VALUES (
          ${opts.providerName},
          ${opts.providerType},
          ${opts.providerBaseUrl || null},
          ${opts.providerKeyEnv || null},
          ${opts.plannerModel}
        )
        ON CONFLICT (name) DO UPDATE
          SET provider_type = EXCLUDED.provider_type,
              base_url      = EXCLUDED.base_url,
              api_key_env   = EXCLUDED.api_key_env,
              default_model = EXCLUDED.default_model,
              updated_at    = now()
        RETURNING id
      `) as { id: number }[];
      providerId = Number(inserted[0]!.id);
    }

    // Insert / update three role profiles AND link the corresponding
    // standalone-llm agent_definitions to them. The role profiles and
    // the role definitions share names — planner-default profile binds
    // to planner-default definition, etc. — so a single subquery in the
    // UPDATE handles the link.
    for (const [profileName, model, definitionName] of [
      ["planner-default", opts.plannerModel, "planner-default"],
      ["reviewer-default", opts.reviewerModel, "reviewer-default"],
      ["orchestrator-default", opts.orchestratorModel, "orchestrator-default"],
    ] as const) {
      const profileRow = (await sql`
        INSERT INTO model_profiles (name, provider_id, model)
        VALUES (${profileName}, ${providerId}, ${model})
        ON CONFLICT (name) DO UPDATE
          SET provider_id = EXCLUDED.provider_id,
              model       = EXCLUDED.model,
              updated_at  = now()
        RETURNING id
      `) as { id: number }[];
      const profileIdNumeric = Number(profileRow[0]!.id);
      // Bind the matching standalone-llm agent_definition to this profile
      // (idempotent — if already pointed at the same id, the UPDATE is a
      // no-op). The definitions are seeded by migration v29.
      await sql`
        UPDATE agent_definitions
        SET model_profile_id = ${profileIdNumeric}, updated_at = now()
        WHERE name = ${definitionName}
      `;
    }
    return true;
  } catch (err) {
    console.error(c.red(`  seed error: ${err instanceof Error ? err.message : String(err)}`));
    return false;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

// --- helyx agents/agent/runtime/providers/models (wave-10, PRD §17.7) ---
//
// Host-side CLI commands that talk to the bot's HTTP API. Each is a thin
// fetch() wrapper — the heavy lifting (DB queries, state transitions) lives
// behind /api/agents and friends in mcp/dashboard-api.ts.
//
// Auth: the bot's /api/* surface is JWT-gated, so the CLI must mint a token
// for itself. We re-use the same signJwt path as the dashboard, with the
// first ALLOWED_USERS telegram_id as the principal. This keeps everything
// admin-scoped — only operators with .env access can call these commands.

/**
 * Wrap an api-backed cli command so any thrown error (HTTP 4xx/5xx,
 * resolveAgentId not-found, network refusal) produces a clean one-line
 * red message instead of a Bun stack trace. Exits with 1 on failure so
 * shell scripts can detect it via $?.
 */
async function runApiCmd<T>(fn: () => Promise<T>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(c.red(`  ${msg}`));
    process.exit(1);
  }
}

async function readEnvFile(): Promise<Record<string, string>> {
  const envPath = `${BOT_DIR}/.env`;
  if (!existsSync(envPath)) {
    console.log(c.red("  .env not found. Run 'helyx setup' first."));
    process.exit(1);
  }
  const map: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) map[m[1]!] = m[2]!;
  }
  return map;
}

/**
 * Build an authenticated fetch helper bound to the local bot. The token
 * is minted once per CLI invocation; downstream callers just provide
 * pathname + optional method/body.
 */
async function makeApiCall(): Promise<<T = any>(path: string, init?: { method?: string; body?: any }) => Promise<T>> {
  const env = await readEnvFile();
  const port = env.PORT ?? "3847";
  const allowed = (env.ALLOWED_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) {
    console.log(c.red("  ALLOWED_USERS not set in .env"));
    process.exit(1);
  }
  const principalId = Number(allowed[0]);
  const { signJwt } = await import("./dashboard/auth.ts");
  const token = await signJwt({ id: principalId, first_name: "helyx-cli", username: "helyx-cli" });

  return async <T = any>(path: string, init: { method?: string; body?: any } = {}): Promise<T> => {
    const r = await fetch(`http://localhost:${port}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) {
      let msg = text;
      try { msg = (JSON.parse(text) as any).error ?? text; } catch { /* keep raw */ }
      throw new Error(`HTTP ${r.status}: ${msg}`);
    }
    return text ? JSON.parse(text) as T : ({} as T);
  };
}

/**
 * Resolve an agent reference (numeric id or name) to a numeric id by
 * listing all instances. Names take the form `<project>:<role>` per PRD
 * §17.4 but legacy single-word names also work (existing bootstrap).
 */
async function resolveAgentId(api: <T>(p: string) => Promise<T>, ref: string): Promise<number> {
  if (/^\d+$/.test(ref)) return Number(ref);
  const all = await api<any[]>("/api/agents");
  const match = all.find((a) => a.name === ref);
  if (!match) {
    throw new Error(`agent "${ref}" not found. Available: ${all.map((a) => a.name).join(", ")}`);
  }
  return Number(match.id);
}

async function cmdAgents() {
  const api = await makeApiCall();
  const [defs, instances] = await Promise.all([
    api<any[]>("/api/agents/definitions"),
    api<any[]>("/api/agents"),
  ]);
  console.log(`\n  ${c.bold("Agent definitions")}`);
  for (const d of defs) {
    const caps = Array.isArray(d.capabilities) && d.capabilities.length > 0 ? d.capabilities.join(",") : "—";
    // agentManager.listDefinitions returns camelCase (runtimeType); the
    // raw SQL behind /api/agents (handleListAgents) returns snake_case
    // (runtime_type). Coalesce so cli works against both.
    const runtime = d.runtimeType ?? d.runtime_type ?? "?";
    console.log(`    ${c.cyan(`#${d.id}`)} ${d.name}  ${c.dim(`runtime=${runtime} caps=[${caps}]`)}`);
  }
  console.log(`\n  ${c.bold("Agent instances")}`);
  if (instances.length === 0) {
    console.log(c.dim("    (none — run `helyx setup-agents` to bootstrap)"));
  } else {
    for (const i of instances) {
      const tag = i.actual_state === "running"
        ? c.green(i.actual_state)
        : i.actual_state === "stopped"
          ? c.dim(i.actual_state)
          : c.yellow(i.actual_state);
      const drift = i.desired_state !== i.actual_state && i.desired_state !== "stopped" ? c.red(`→${i.desired_state}`) : "";
      console.log(`    ${c.cyan(`#${i.id}`)} ${i.name}  ${tag} ${drift}  ${c.dim(`def=${i.definition_name} project=${i.project_name ?? "—"}`)}`);
    }
  }
  console.log();
}

async function cmdAgentCreate() {
  const api = await makeApiCall();
  console.log(`\n  ${c.bold("Create agent instance")}`);
  // List definitions so the user knows what's available
  const defs = await api<any[]>("/api/agents/definitions");
  console.log(`  ${c.dim("Available definitions:")}`);
  for (const d of defs) {
    const caps = Array.isArray(d.capabilities) && d.capabilities.length > 0 ? d.capabilities.join(",") : "—";
    console.log(`    ${c.cyan(`#${d.id}`)} ${d.name}  ${c.dim(`caps=[${caps}]`)}`);
  }
  console.log();
  const definition = ask("Definition (id or name)");
  if (!definition) {
    console.log(c.red("  definition required"));
    process.exit(1);
  }
  const name = ask("Instance name (e.g. my-project:coder)");
  if (!name) {
    console.log(c.red("  name required"));
    process.exit(1);
  }
  const project = ask("Project (id, name, or Enter for none)");
  const desiredState = ask("Desired state [stopped|running|paused]", "stopped");

  const result = await api<any>("/api/agents", {
    method: "POST",
    body: {
      definition,
      name,
      project: project || null,
      desired_state: desiredState,
    },
  });
  console.log(`  ${c.green("✓")} created agent #${result.id} (${result.name}, desired=${result.desired_state})`);
}

async function cmdAgentAction(action: "start" | "stop" | "restart", ref: string | undefined) {
  if (!ref) {
    console.log(c.red(`  Usage: helyx agent ${action} <id|name>`));
    process.exit(1);
  }
  const api = await makeApiCall();
  const id = await resolveAgentId(api, ref);
  const result = await api<any>(`/api/agents/${id}/${action}`, { method: "POST", body: { reason: `cli ${action}` } });
  // agentManager.setDesiredState returns camelCase (desiredState); the
  // raw-SQL list path returns snake_case. Coalesce.
  const desired = result.desiredState ?? result.desired_state ?? "?";
  console.log(`  ${c.green("✓")} agent #${id} ${result.name} → desired_state=${desired}`);
}

async function cmdAgentSnapshot(ref: string | undefined) {
  if (!ref) {
    console.log(c.red("  Usage: helyx agent snapshot <id|name>"));
    process.exit(1);
  }
  const api = await makeApiCall();
  const id = await resolveAgentId(api, ref);
  const inst = await api<any>(`/api/agents/${id}`);
  if (!inst.last_snapshot) {
    console.log(c.dim(`  No snapshot yet for #${id} (last_snapshot_at=${inst.last_snapshot_at ?? "never"})`));
    return;
  }
  console.log(`\n  ${c.bold(`Snapshot ${inst.name}`)}  ${c.dim(`captured ${inst.last_snapshot_at ?? "?"}`)}`);
  console.log(`  ${"─".repeat(60)}`);
  console.log(inst.last_snapshot);
}

async function cmdAgentLogs(ref: string | undefined, limit = 50) {
  if (!ref) {
    console.log(c.red("  Usage: helyx agent logs <id|name> [limit]"));
    process.exit(1);
  }
  const api = await makeApiCall();
  const id = await resolveAgentId(api, ref);
  const events = await api<any[]>(`/api/agents/${id}/events?limit=${limit}`);
  console.log(`\n  ${c.bold(`Last ${events.length} events for agent #${id}`)}`);
  for (const e of events.reverse()) {
    const ts = new Date(e.created_at).toISOString().slice(11, 19);
    const stateChange = e.from_state && e.to_state ? c.dim(` ${e.from_state}→${e.to_state}`) : "";
    console.log(`    ${c.dim(ts)} ${c.cyan(e.event_type)}${stateChange}  ${e.message ?? ""}`);
  }
}

async function cmdRuntimeStatus() {
  const api = await makeApiCall();
  const s = await api<any>("/api/runtime/status");
  console.log(`\n  ${c.bold("Runtime Status")}`);
  console.log(`    Instances: ${c.green(s.totals.running_instances)} running, ${c.dim(s.totals.stopped_instances)} stopped, ${s.totals.waiting_approval > 0 ? c.yellow(s.totals.waiting_approval + " waiting") : "0 waiting"}`);
  if (s.totals.desired_actual_drift > 0) {
    console.log(`    ${c.red(`drift: ${s.totals.desired_actual_drift}`)} (desired ≠ actual)`);
  }
  console.log(`    Tasks: ${c.dim(s.totals.pending_tasks + " pending")}, ${c.dim(s.totals.in_progress_tasks + " in progress")}, ${s.totals.failed_tasks > 0 ? c.red(s.totals.failed_tasks + " failed") : c.dim("0 failed")}`);
  console.log(`    Drivers:`);
  for (const [name, status] of Object.entries(s.drivers)) {
    const tag = status === "ok" ? c.green(String(status)) : c.dim(String(status));
    console.log(`      ${name}: ${tag}`);
  }
  console.log();
}

async function cmdProviders() {
  const api = await makeApiCall();
  const providers = await api<any[]>("/api/providers");
  console.log(`\n  ${c.bold("Model Providers")}`);
  for (const p of providers) {
    const enabled = p.enabled ? c.green("on") : c.dim("off");
    console.log(`    ${c.cyan(`#${p.id}`)} ${p.name}  ${enabled}  ${c.dim(`${p.provider_type} default=${p.default_model ?? "—"} key_env=${p.api_key_env ?? "—"}`)}`);
  }
  console.log();
}

async function cmdProviderTest(ref: string | undefined) {
  if (!ref) {
    console.log(c.red("  Usage: helyx provider test <id|name>"));
    process.exit(1);
  }
  const api = await makeApiCall();
  // Resolve name → id by listing all (small table; tens of rows max).
  let id: number;
  if (/^\d+$/.test(ref)) {
    id = Number(ref);
  } else {
    const all = await api<any[]>("/api/providers");
    const match = all.find((p) => p.name === ref);
    if (!match) {
      throw new Error(`provider "${ref}" not found. Available: ${all.map((p) => p.name).join(", ")}`);
    }
    id = Number(match.id);
  }

  console.log(`  ${c.dim(`probing provider #${id}…`)}`);
  const result = await api<{ ok: boolean; provider: string; model?: string; durationMs: number; response?: string; error?: string }>(
    `/api/providers/${id}/test`,
    { method: "POST" },
  );
  if (result.ok) {
    console.log(`  ${c.green("✓")} ${result.provider} (${result.model}) — ${result.durationMs}ms`);
    if (result.response) console.log(c.dim(`    response: ${result.response}`));
  } else {
    console.log(`  ${c.red("✗")} ${result.provider} (${result.model ?? "?"}) — ${result.durationMs}ms`);
    console.log(c.red(`    ${result.error ?? "unknown error"}`));
    process.exit(1);
  }
}

async function cmdModels() {
  const api = await makeApiCall();
  const profiles = await api<any[]>("/api/profiles");
  console.log(`\n  ${c.bold("Model Profiles")}`);
  for (const p of profiles) {
    const enabled = p.enabled ? c.green("on") : c.dim("off");
    console.log(`    ${c.cyan(`#${p.id}`)} ${p.name}  ${enabled}  ${c.dim(`${p.provider_name} → ${p.model}`)}`);
  }
  console.log();
}

async function cmdModelSet(agentRef: string | undefined, profileRef: string | undefined) {
  if (!agentRef || !profileRef) {
    console.log(c.red("  Usage: helyx model set <agent-id|name> <profile-id|name>"));
    process.exit(1);
  }
  const api = await makeApiCall();
  const agentId = await resolveAgentId(api, agentRef);
  // profile param is sent as-is — server resolves by id-or-name.
  const result = await api<any>(`/api/agents/${agentId}/model-profile`, {
    method: "PATCH",
    body: { profile: /^\d+$/.test(profileRef) ? Number(profileRef) : profileRef },
  });
  console.log(`  ${c.green("✓")} agent #${agentId} → model_profile_id=${result.model_profile_id} (definition #${result.definition_id})`);
}

// --- helyx setup-agents (wave-5, PRD §17.7) ---

/**
 * Re-run only the agent-runtime portion of `helyx setup`. Useful when:
 *   - User upgrades to a release that adds new agent-runtime questions
 *   - User wants to swap planner/reviewer provider without re-touching
 *     Telegram/voice/TTS settings
 *   - Operator added new projects and wants to bootstrap their agents
 *
 * Requires .env to exist (i.e. `helyx setup` was already run). Reads the
 * existing values, prompts ONLY the wave-3 questions, updates the
 * corresponding env keys in-place (preserving everything else), then runs
 * seedModelProfiles + seedAgentBootstrap.
 *
 * Never overwrites secrets the user did not re-enter — when the wizard
 * receives an empty answer for an existing key, the previous value is
 * kept. This is the same default-honoring pattern as the ask() helper.
 */
async function setupAgents() {
  console.log(`\n  ${c.bold("Helyx — Agent Setup (re-run)")}`);
  console.log(`  ${"─".repeat(40)}\n`);

  const envPath = `${BOT_DIR}/.env`;
  if (!existsSync(envPath)) {
    console.log(c.red("  .env not found. Run 'helyx setup' first."));
    process.exit(1);
  }

  // Parse existing .env into a map; preserve original line order so the
  // updated file does not reshuffle unrelated keys.
  const envContents = readFileSync(envPath, "utf8");
  const lines = envContents.split("\n");
  const envMap: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) envMap[m[1]!] = m[2]!;
  }

  const dbUrl = envMap.DATABASE_URL;
  if (!dbUrl) {
    console.log(c.red("  DATABASE_URL not set in .env"));
    process.exit(1);
  }

  // Wave-3 questions, with current .env values as defaults so re-runs
  // can simply press Enter to keep settings unchanged.
  const driverIdx = askChoice(
    `Default runtime driver (current: ${envMap.DEFAULT_RUNTIME_DRIVER ?? "tmux"}):`,
    [
      "tmux (recommended)",
      "pty (experimental)",
      "docker (sandboxed)",
    ],
  );
  const driver = ["tmux", "pty", "docker"][driverIdx] ?? "tmux";

  const codingIdx = askChoice(
    `Default coding runtime (current: ${envMap.DEFAULT_CODING_RUNTIME ?? "claude-code"}):`,
    [
      "claude-code",
      "opencode",
      "codex-cli",
      "gemini-cli",
      "None — configure later",
    ],
  );
  const coding = ["claude-code", "opencode", "codex-cli", "gemini-cli", "none"][codingIdx] ?? "claude-code";

  const bootIdx = askChoice("Bootstrap per-project coder agents now?", [
    "Yes — create coder agent for every project without one",
    "No",
  ]);
  const wantBootstrap = bootIdx === 0;

  const apiIdx = askChoice("Configure planner / reviewer / orchestrator (API-based)?", [
    "Yes — pick a provider",
    "No — keep current settings",
  ]);

  // Persist the two basic agent-runtime settings.
  const updates: Record<string, string> = {
    DEFAULT_RUNTIME_DRIVER: driver,
    DEFAULT_CODING_RUNTIME: coding,
  };

  let didSeedProfiles = false;
  if (apiIdx === 0) {
    const provIdx = askChoice("API provider:", [
      "OpenAI-compatible (DeepSeek, etc.)",
      "OpenRouter",
      "Anthropic",
      "Google AI",
      "Ollama",
    ]);
    const providerType = ["custom-openai", "openrouter", "anthropic", "google-ai", "ollama"][provIdx]!;
    const providerName = ["DeepSeek", "OpenRouter", "Anthropic", "Google AI", "Ollama"][provIdx]!;
    const providerBaseUrl = [
      "https://api.deepseek.com",
      "https://openrouter.ai/api/v1",
      "https://api.anthropic.com",
      "https://generativelanguage.googleapis.com/v1",
      "http://localhost:11434",
    ][provIdx]!;
    const providerKeyEnv = ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_AI_API_KEY", ""][provIdx]!;
    const apiKeyDefault = providerKeyEnv ? envMap[providerKeyEnv] ?? "" : "";
    const apiKey = providerKeyEnv ? ask(`${providerKeyEnv} (Enter to keep existing)`, apiKeyDefault) : "";
    const planner = ask("Planner model", envMap.DEFAULT_PLANNER_MODEL ?? "deepseek-chat");
    const reviewer = ask("Reviewer model", envMap.DEFAULT_REVIEWER_MODEL ?? "deepseek-chat");
    const orch = ask("Orchestrator model", envMap.DEFAULT_ORCHESTRATOR_MODEL ?? "deepseek-chat");

    updates.DEFAULT_PLANNER_PROVIDER = providerType;
    updates.DEFAULT_PLANNER_MODEL = planner;
    updates.DEFAULT_REVIEWER_PROVIDER = providerType;
    updates.DEFAULT_REVIEWER_MODEL = reviewer;
    updates.DEFAULT_ORCHESTRATOR_PROVIDER = providerType;
    updates.DEFAULT_ORCHESTRATOR_MODEL = orch;
    if (providerKeyEnv && apiKey) updates[providerKeyEnv] = apiKey;
    if (providerType === "custom-openai" && apiKey) {
      updates.CUSTOM_OPENAI_API_KEY = apiKey;
      updates.CUSTOM_OPENAI_BASE_URL = providerBaseUrl;
      updates.CUSTOM_OPENAI_DEFAULT_MODEL = planner;
    }

    step("Seeding model_profiles");
    didSeedProfiles = await seedModelProfiles({
      providerType,
      providerName,
      providerBaseUrl,
      providerKeyEnv,
      plannerModel: planner,
      reviewerModel: reviewer,
      orchestratorModel: orch,
      dbUrl,
    });
    didSeedProfiles ? done() : fail("seed failed (check DB)");
  }

  // Apply updates to .env in-place: replace existing key=value lines,
  // append new keys at end. Preserves comment lines and blank lines.
  const updatedKeys = new Set<string>();
  const newLines = lines.map((line) => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1]!)) {
      updatedKeys.add(m[1]!);
      return `${m[1]}=${updates[m[1]!]!}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(updates)) {
    if (!updatedKeys.has(k)) newLines.push(`${k}=${v}`);
  }
  step("Updating .env");
  await Bun.write(envPath, newLines.join("\n"));
  // Re-apply 0600 (Bun.write resets file mode on overwrite). See full
  // setup() for context on why .env must not be world-readable.
  try { chmodSync(envPath, 0o600); } catch { /* best-effort */ }
  done();

  if (wantBootstrap) {
    step("Bootstrapping per-project coder agents");
    const ok = await seedAgentBootstrap({ dbUrl });
    ok ? done() : fail("bootstrap failed");
  }

  console.log(`\n  ${c.green(c.bold("Agent setup complete."))}\n`);
}

// --- Agent bootstrap (wave-5, PRD §17.4) ---

/**
 * Seed per-project coder agent_instances. For every project in the
 * `projects` table that has no default_agent_instance_id yet, insert one
 * agent_instance row pointing at claude-code-default with desired_state
 * 'stopped' and link it as the project's default.
 *
 * The "conservative" bootstrap from PRD §17.4: never auto-start, never
 * touch existing sessions, never reassign. Idempotent on the
 * (project_id, name) unique constraint — re-running is a no-op for
 * already-bootstrapped projects.
 *
 * Also bumps claude-code-default.capabilities to ["code"] so the
 * orchestrator's capability-based selection (handleFailure / selectAgent)
 * can find it when reassigning.
 *
 * Returns false on DB error so the caller can warn but continue.
 */
async function seedAgentBootstrap(opts: { dbUrl: string }): Promise<boolean> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(opts.dbUrl, { max: 2, onnotice: () => {} });
  try {
    // Update claude-code-default capabilities so handleFailure can match it.
    // The migration v24 left capabilities=[] for claude-code-default; here
    // we promote it to a "code"-capable agent so it participates in
    // capability-based reassignment.
    await sql`
      UPDATE agent_definitions
      SET capabilities = '["code"]'::jsonb, updated_at = now()
      WHERE name = 'claude-code-default' AND capabilities = '[]'::jsonb
    `;

    // Find the claude-code-default definition id.
    const defRows = (await sql`
      SELECT id FROM agent_definitions WHERE name = 'claude-code-default' LIMIT 1
    `) as { id: number }[];
    if (!defRows[0]) {
      console.error(c.red("  claude-code-default definition not found — skipping bootstrap"));
      return false;
    }
    const definitionId = Number(defRows[0].id);

    // Iterate projects without a default agent.
    const projects = (await sql`
      SELECT id, name FROM projects WHERE default_agent_instance_id IS NULL
    `) as { id: number; name: string }[];

    let created = 0;
    for (const proj of projects) {
      const instanceName = `${proj.name}:coder`;
      // Insert with ON CONFLICT (project_id, name) — guards against re-run
      // races where an instance was created between our SELECT and INSERT.
      const ins = (await sql`
        INSERT INTO agent_instances (definition_id, project_id, name, desired_state, actual_state)
        VALUES (${definitionId}, ${proj.id}, ${instanceName}, 'stopped', 'new')
        ON CONFLICT (project_id, name) DO NOTHING
        RETURNING id
      `) as { id: number }[];
      const instanceId = ins[0]?.id;
      if (instanceId) {
        await sql`
          UPDATE projects SET default_agent_instance_id = ${instanceId} WHERE id = ${proj.id}
        `;
        created++;
      }
    }

    console.log(c.dim(`    ${created} new instance(s) created across ${projects.length} project(s)`));
    return true;
  } catch (err) {
    console.error(c.red(`  bootstrap error: ${err instanceof Error ? err.message : String(err)}`));
    return false;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

/**
 * Per-project bootstrap for planner/reviewer/orchestrator standalone-llm
 * agents. Mirror of seedAgentBootstrap but targets the role definitions
 * (planner-default, reviewer-default, orchestrator-default) instead of
 * the coder definition.
 *
 * Each project gets three new instances with names <project>:planner /
 * :reviewer / :orchestrator, all desired_state='stopped'. Idempotent on
 * the (project_id, name) unique constraint.
 */
async function seedRoleAgentBootstrap(opts: { dbUrl: string }): Promise<boolean> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(opts.dbUrl, { max: 2, onnotice: () => {} });
  try {
    const defRows = (await sql`
      SELECT id, name FROM agent_definitions
      WHERE name IN ('planner-default', 'reviewer-default', 'orchestrator-default')
        AND enabled = true
    `) as { id: number; name: string }[];
    if (defRows.length < 3) {
      console.error(c.red("  one or more role definitions missing (run migrate first)"));
      return false;
    }
    const defByName = new Map(defRows.map((r) => [r.name, Number(r.id)] as const));

    const projects = (await sql`SELECT id, name FROM projects`) as { id: number; name: string }[];
    let created = 0;
    for (const proj of projects) {
      for (const [defName, role] of [
        ["planner-default", "planner"],
        ["reviewer-default", "reviewer"],
        ["orchestrator-default", "orchestrator"],
      ] as const) {
        const definitionId = defByName.get(defName)!;
        const instanceName = `${proj.name}:${role}`;
        const ins = (await sql`
          INSERT INTO agent_instances (definition_id, project_id, name, desired_state, actual_state)
          VALUES (${definitionId}, ${proj.id}, ${instanceName}, 'stopped', 'new')
          ON CONFLICT (project_id, name) DO NOTHING
          RETURNING id
        `) as { id: number }[];
        if (ins[0]) created++;
      }
    }
    console.log(c.dim(`    ${created} new instance(s) across ${projects.length} project(s) (planner+reviewer+orchestrator)`));
    return true;
  } catch (err) {
    console.error(c.red(`  bootstrap error: ${err instanceof Error ? err.message : String(err)}`));
    return false;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

// --- Runtime doctor ---

/**
 * Non-destructive prerequisite check. Implements PRD §16.7 `helyx runtime
 * doctor`: verifies that the runtime drivers and adapters this install
 * configures (or could configure) actually have their host-side dependencies
 * available. Never starts/stops services, never mutates files, never calls
 * paid APIs. Result codes:
 *   0 — all required checks PASS
 *   1 — at least one required check FAIL
 * Optional checks (e.g. ollama) are SKIPPED when not configured; they never
 * fail the run.
 */
async function runtimeDoctor() {
  console.log(`\n  ${c.bold("Helyx Runtime Doctor")}`);
  console.log(`  ${"─".repeat(40)}\n`);

  // Read .env to know what's actually configured. Missing .env is itself a
  // failure mode — the install isn't ready to use.
  const envPath = `${BOT_DIR}/.env`;
  const envMap: Record<string, string> = {};
  let hasEnv = existsSync(envPath);
  if (hasEnv) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) envMap[m[1]!] = m[2]!;
    }
  }

  type Check = { name: string; result: "PASS" | "FAIL" | "SKIP"; detail: string; required: boolean };
  const checks: Check[] = [];

  // 1. .env presence — required.
  checks.push({
    name: ".env exists",
    result: hasEnv ? "PASS" : "FAIL",
    detail: hasEnv ? envPath : `missing — run "helyx setup"`,
    required: true,
  });

  // 2. bun — required (we're literally running on it; this is mostly to
  //    surface the version and confirm `which bun` resolves).
  const bunWhich = await run(["which", "bun"], { silent: true });
  const bunVer = await run(["bun", "--version"], { silent: true });
  checks.push({
    name: "bun installed",
    result: bunWhich.ok && bunVer.ok ? "PASS" : "FAIL",
    detail: bunWhich.ok ? `${bunWhich.output} (v${bunVer.output})` : "not in PATH",
    required: true,
  });

  // 3. Docker (only required if DATABASE_URL points to docker-mapped port).
  const useDocker = (envMap.DATABASE_URL ?? "").includes(":5433/");
  if (useDocker) {
    const dockerVer = await run(["docker", "--version"], { silent: true });
    checks.push({
      name: "docker available",
      result: dockerVer.ok ? "PASS" : "FAIL",
      detail: dockerVer.ok ? dockerVer.output : "not in PATH (Docker deploy requires it)",
      required: true,
    });
    const composeVer = await run(["docker", "compose", "version"], { silent: true });
    checks.push({
      name: "docker compose v2",
      result: composeVer.ok ? "PASS" : "FAIL",
      detail: composeVer.ok ? composeVer.output : "v2 plugin missing",
      required: true,
    });
  }

  // 4. PostgreSQL reachable on the configured DATABASE_URL.
  if (envMap.DATABASE_URL) {
    // postgres.js URL parsing is too heavyweight to import here; do a quick
    // tcp probe via `bash -c 'cat </dev/tcp/host/port'` portably.
    const m = (envMap.DATABASE_URL).match(/postgres:\/\/[^@]+@([^:/]+):(\d+)\//);
    if (m) {
      const probe = await run(
        ["bash", "-c", `exec 3<>/dev/tcp/${m[1]}/${m[2]} && echo ok`],
        { silent: true },
      );
      checks.push({
        name: `postgres reachable (${m[1]}:${m[2]})`,
        result: probe.ok ? "PASS" : "FAIL",
        detail: probe.ok ? "tcp open" : "no route — start postgres or check DATABASE_URL",
        required: true,
      });
    }
  }

  // 5. tmux — required if DEFAULT_RUNTIME_DRIVER is tmux (the default).
  const driver = envMap.DEFAULT_RUNTIME_DRIVER ?? "tmux";
  if (driver === "tmux") {
    const tmuxVer = await run(["tmux", "-V"], { silent: true });
    checks.push({
      name: "tmux installed",
      result: tmuxVer.ok ? "PASS" : "FAIL",
      detail: tmuxVer.ok ? tmuxVer.output : `not in PATH (DEFAULT_RUNTIME_DRIVER=tmux)`,
      required: true,
    });
  } else {
    checks.push({
      name: `runtime driver "${driver}"`,
      result: "SKIP",
      detail: "non-tmux driver — no host check yet",
      required: false,
    });
  }

  // 6. claude-code CLI — required if DEFAULT_CODING_RUNTIME is claude-code.
  const codingRuntime = envMap.DEFAULT_CODING_RUNTIME ?? "claude-code";
  if (codingRuntime === "claude-code") {
    const claudeWhich = await run(["which", "claude"], { silent: true });
    checks.push({
      name: "claude-code CLI installed",
      result: claudeWhich.ok ? "PASS" : "FAIL",
      detail: claudeWhich.ok
        ? claudeWhich.output
        : `not in PATH (DEFAULT_CODING_RUNTIME=claude-code) — install: npm install -g @anthropic-ai/claude-code`,
      required: true,
    });
  } else if (codingRuntime === "codex-cli") {
    const codexWhich = await run(["which", "codex"], { silent: true });
    checks.push({
      name: "codex CLI installed",
      result: codexWhich.ok ? "PASS" : "FAIL",
      detail: codexWhich.ok ? codexWhich.output : "not in PATH",
      required: true,
    });
  }

  // 7. Ollama — optional. Only check if URL is configured AND points
  //    somewhere we can reach. Manual installs often skip Ollama entirely.
  const ollamaUrl = envMap.OLLAMA_URL;
  if (ollamaUrl) {
    const probe = await run(
      ["curl", "-sf", "--max-time", "3", `${ollamaUrl}/api/tags`],
      { silent: true },
    );
    checks.push({
      name: `ollama reachable (${ollamaUrl})`,
      result: probe.ok ? "PASS" : "SKIP",
      detail: probe.ok ? "responding" : "not running — embeddings/summarization disabled",
      required: false,
    });
  }

  // 8. API key presence (no network call — just env presence).
  const keys = [
    { env: "TELEGRAM_BOT_TOKEN", label: "Telegram token", required: true },
    { env: "ANTHROPIC_API_KEY", label: "Anthropic key", required: false },
    { env: "GROQ_API_KEY", label: "Groq key (voice STT)", required: false },
  ];
  for (const k of keys) {
    const v = envMap[k.env] ?? "";
    checks.push({
      name: `${k.label} configured`,
      result: v ? "PASS" : (k.required ? "FAIL" : "SKIP"),
      detail: v ? `${k.env}=*** (${v.length} chars)` : `${k.env} not set`,
      required: k.required,
    });
  }

  // 9. Telegram token validity — actually call getMe (PRD §16.6 #4).
  //    Skipped silently when token is missing; that's already FAIL'd above.
  const tgToken = envMap.TELEGRAM_BOT_TOKEN;
  if (tgToken) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${tgToken}/getMe`, { signal: AbortSignal.timeout(5000) });
      const j = (await r.json()) as { ok?: boolean; result?: { username?: string }; description?: string };
      checks.push({
        name: "Telegram token valid",
        result: j?.ok ? "PASS" : "FAIL",
        detail: j?.ok ? `bot @${j.result?.username ?? "?"}` : `getMe rejected: ${j?.description ?? "?"}`,
        required: true,
      });
    } catch (err) {
      checks.push({
        name: "Telegram token valid",
        result: "FAIL",
        detail: `getMe call failed: ${err instanceof Error ? err.message : String(err)}`,
        required: true,
      });
    }
  }

  // 10. Forum setup status (PRD §16.6 #5) — projects with topic_id NULL hint
  //     that /forum_setup hasn't been run for them. Optional; always emits SKIP
  //     for non-Telegram-forum installs.
  if (tgToken) {
    try {
      const postgres = (await import("postgres")).default;
      const dbUrl = envMap.DATABASE_URL;
      if (dbUrl) {
        const sql = postgres(dbUrl, { max: 1, onnotice: () => {}, idle_timeout: 2 });
        try {
          const rows = (await sql`SELECT
            COUNT(*) FILTER (WHERE forum_topic_id IS NOT NULL)::int AS with_topic,
            COUNT(*)::int AS total
          FROM projects`) as { with_topic: number; total: number }[];
          const r = rows[0]!;
          if (r.total === 0) {
            checks.push({ name: "Forum topics", result: "SKIP", detail: "no projects yet", required: false });
          } else if (r.with_topic === r.total) {
            checks.push({ name: "Forum topics", result: "PASS", detail: `${r.total}/${r.total} projects linked`, required: false });
          } else {
            checks.push({
              name: "Forum topics",
              result: "SKIP",
              detail: `${r.with_topic}/${r.total} projects linked — run /forum_setup in Telegram for the rest`,
              required: false,
            });
          }
        } finally {
          await sql.end({ timeout: 2 });
        }
      }
    } catch {
      // DB probe failed — already covered by the postgres-reachable check above.
    }
  }

  // Print results.
  for (const ck of checks) {
    const tag = ck.result === "PASS"
      ? c.green("PASS")
      : ck.result === "FAIL"
        ? c.red("FAIL")
        : c.dim("SKIP");
    const reqMark = ck.required ? " " : c.dim(" (optional)");
    console.log(`  [${tag}] ${ck.name}${reqMark}`);
    console.log(`         ${c.dim(ck.detail)}`);
  }

  const failedRequired = checks.filter((c) => c.result === "FAIL" && c.required);
  console.log();
  if (failedRequired.length === 0) {
    console.log(`  ${c.green(c.bold("All required checks passed."))}\n`);
    process.exit(0);
  } else {
    console.log(`  ${c.red(c.bold(`${failedRequired.length} required check(s) failed.`))} Fix the issues above and re-run.\n`);
    process.exit(1);
  }
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

  // Validate name before building SQL (guard against injection via --name flag)
  if (!/^[a-zA-Z0-9_\-. ]+$/.test(name)) {
    console.log(c.red(`  Invalid project name: ${name}`));
    console.log(c.dim("  Project names may only contain letters, digits, spaces, and: _ - ."));
    process.exit(1);
  }

  // Upsert into DB
  // Single-quote escape is sufficient here because the name is already validated above
  // and projectDir comes from resolve() which produces an absolute POSIX path (no quotes).
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

  // Validate name to block SQL injection / LIKE wildcard abuse
  if (!/^[a-zA-Z0-9_\-. ]+$/.test(name)) {
    console.log(c.red(`  Invalid project name: ${name}`));
    console.log(c.dim("  Project names may only contain letters, digits, spaces, and: _ - ."));
    process.exit(1);
  }

  // Escape single-quotes for the SQL literal, and LIKE metacharacters for the path suffix match.
  const escapedName    = name.replace(/'/g, "''");
  const escapedForLike = name.replace(/[%_\\]/g, "\\$&").replace(/'/g, "''");
  const { ok, rows } = await dbQuery(
    `DELETE FROM projects WHERE name = '${escapedName}' OR path LIKE '%/${escapedForLike}' ESCAPE '\\' RETURNING name`
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
      body: JSON.stringify({ projectPath, runtimeType: "claude-code", cliConfig: {}, name }),
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
    setup-agents    Re-run only the agent-runtime portion of setup
    runtime doctor  Validate prerequisites (bun, docker, pg, tmux, claude-code)
    runtime status  Show RuntimeManager + driver health (live)
    remote          Connect laptop to a remote bot server
    mcp-register    Re-register MCP servers in Claude Code

  ${c.bold("Agents (PRD §17.7):")}
    agents              List agent definitions and instances
    agent create        Interactive — create a new agent instance from a definition
    agent start <ref>   Set desired_state=running for agent (id or name)
    agent stop <ref>    Set desired_state=stopped
    agent restart <ref> Reconcile-driven restart
    agent snapshot <ref> Show last captured runtime snapshot
    agent logs <ref> [n] Show last N agent_events (default 50)
    providers           List model providers
    provider test <ref> Validate provider credentials + endpoint reachability
    models              List model profiles
    model set <a> <p>   Bind agent <a> (id|name) to profile <p> (id|name)

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
  case "setup-agents": await setupAgents(); break;
  case "runtime": {
    // Subcommands under `helyx runtime`. doctor (P0b) + status (wave-10).
    const sub = process.argv[3];
    if (sub === "doctor") {
      await runtimeDoctor();
    } else if (sub === "status") {
      await runApiCmd(() => cmdRuntimeStatus());
    } else {
      console.log(c.red(`  Unknown runtime subcommand: ${sub ?? "(missing)"}`));
      console.log(`  Available: ${c.cyan("doctor")}, ${c.cyan("status")}`);
      process.exit(2);
    }
    break;
  }
  case "agents":    await runApiCmd(() => cmdAgents()); break;
  case "agent": {
    const sub = process.argv[3];
    const ref = process.argv[4];
    if (sub === "start")        await runApiCmd(() => cmdAgentAction("start", ref));
    else if (sub === "stop")    await runApiCmd(() => cmdAgentAction("stop", ref));
    else if (sub === "restart") await runApiCmd(() => cmdAgentAction("restart", ref));
    else if (sub === "snapshot") await runApiCmd(() => cmdAgentSnapshot(ref));
    else if (sub === "logs")     await runApiCmd(() => cmdAgentLogs(ref, Number(process.argv[5] ?? "50")));
    else if (sub === "create")   await runApiCmd(() => cmdAgentCreate());
    else {
      console.log(c.red(`  Unknown agent subcommand: ${sub ?? "(missing)"}`));
      console.log(`  Available: ${c.cyan("create")}, ${c.cyan("start")}, ${c.cyan("stop")}, ${c.cyan("restart")}, ${c.cyan("snapshot")}, ${c.cyan("logs")}`);
      console.log(`  Usage: helyx agent <subcommand> [args]`);
      process.exit(2);
    }
    break;
  }
  case "providers": await runApiCmd(() => cmdProviders()); break;
  case "provider": {
    const sub = process.argv[3];
    const ref = process.argv[4];
    if (sub === "test") await runApiCmd(() => cmdProviderTest(ref));
    else {
      console.log(c.red(`  Unknown provider subcommand: ${sub ?? "(missing)"}`));
      console.log(`  Available: ${c.cyan("test")}`);
      console.log(`  Usage: helyx provider test <id|name>`);
      process.exit(2);
    }
    break;
  }
  case "models":    await runApiCmd(() => cmdModels()); break;
  case "model": {
    const sub = process.argv[3];
    if (sub === "set") await runApiCmd(() => cmdModelSet(process.argv[4], process.argv[5]));
    else {
      console.log(c.red(`  Unknown model subcommand: ${sub ?? "(missing)"}`));
      console.log(`  Available: ${c.cyan("set")}`);
      console.log(`  Usage: helyx model set <agent> <profile>`);
      process.exit(2);
    }
    break;
  }
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
