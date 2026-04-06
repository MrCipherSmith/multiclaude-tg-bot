#!/usr/bin/env bun
/**
 * Claude Bot CLI — setup wizard and management commands.
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

import { existsSync } from "fs";
import { resolve, basename } from "path";

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

async function run(cmd: string[], opts?: { cwd?: string; silent?: boolean }): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd ?? BOT_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
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
  console.log(`\n  ${c.bold("Claude Bot Setup")}`);
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
    "OpenRouter (free models available)",
    "Ollama (local, free)",
  ]);

  let anthropicKey = "";
  let openrouterKey = "";
  let openrouterModel = "qwen/qwen3-235b-a22b:free";
  let ollamaModel = "qwen3:8b";

  if (providerIdx === 0) {
    anthropicKey = ask("Anthropic API Key");
  } else if (providerIdx === 1) {
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

  // 5. Voice transcription
  console.log();
  const groqKey = ask("Groq API Key for voice (Enter to skip, free at console.groq.com)");

  // 5. Database password
  const dbPassword = ask("PostgreSQL password", "claude_bot_secret");

  // 6. Port
  const port = ask("Bot port", "3847");

  // Generate .env
  console.log();
  step("Creating .env");

  const dbUrl = useDocker
    ? `postgres://claude_bot:${dbPassword}@localhost:5433/claude_bot`
    : `postgres://claude_bot:${dbPassword}@localhost:5432/claude_bot`;

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
    "# Server",
    `PORT=${port}`,
    `SHORT_TERM_WINDOW=20`,
    `IDLE_TIMEOUT_MS=900000`,
  ];

  await Bun.write(`${BOT_DIR}/.env`, envLines.join("\n") + "\n");
  done();

  // Install dependencies
  step("Installing dependencies");
  const install = await run(["bun", "install", "--frozen-lockfile"]);
  install.ok ? done() : fail();

  // Start services
  if (useDocker) {
    step("Starting Docker services");
    const up = await run(["docker", "compose", "up", "-d"]);
    up.ok ? done() : fail();

    // Wait for DB
    step("Waiting for database");
    for (let i = 0; i < 30; i++) {
      const check = await run(["docker", "compose", "exec", "-T", "postgres", "pg_isready", "-U", "claude_bot"], { silent: true });
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
  await run(["claude", "mcp", "remove", "claude-bot", "-s", "user"], { silent: true });
  await run(["claude", "mcp", "remove", "claude-bot-channel", "-s", "user"], { silent: true });

  await run(["claude", "mcp", "add", "--transport", "http", "-s", "user", "claude-bot", `http://localhost:${port}/mcp`]);

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
  await run(["claude", "mcp", "add-json", "-s", "user", "claude-bot-channel", channelConfig]);
  done();

  // Copy CLAUDE.md template
  step("Setting up global CLAUDE.md");
  const claudeMdPath = `${process.env.HOME}/.claude/CLAUDE.md`;
  if (!existsSync(claudeMdPath)) {
    const template = `# Global CLAUDE.md

## MCP Integration

When starting a session, call \`set_session_name\` with:
- name: basename of the current working directory
- project_path: absolute path to the current working directory

## Telegram Status Updates

When responding to Telegram channel messages (messages from \`notifications/claude/channel\`), call \`update_status\` before each major step to keep the user informed. Use the \`chat_id\` from the channel message metadata.

Examples:
- Before reading files: \`update_status(chat_id, "Reading files...")\`
- Before running commands: \`update_status(chat_id, "Running git status...")\`
- Before editing: \`update_status(chat_id, "Editing code...")\`

Keep status messages short (under 50 chars). The status is automatically deleted when you call \`reply\`.
`;
    await Bun.write(claudeMdPath, template);
    done();
  } else {
    console.log(` ${c.yellow("exists, skipping")}`);
  }

  // Summary
  console.log(`\n  ${c.green(c.bold("Setup complete!"))}\n`);
  console.log(`  Start a CLI session:`);
  console.log(`    ${c.cyan("cd your-project")}`);
  console.log(`    ${c.cyan("claude --dangerously-load-development-channels server:claude-bot-channel")}\n`);
  console.log(`  Manage the bot:`);
  console.log(`    ${c.cyan("bun cli.ts status")}    — health & stats`);
  console.log(`    ${c.cyan("bun cli.ts sessions")}  — list sessions`);
  console.log(`    ${c.cyan("bun cli.ts logs")}      — view logs`);
  console.log(`    ${c.cyan("bun cli.ts connect .")} — connect current project\n`);
}

// --- Management commands ---

async function start() {
  step("Starting bot");
  const result = await run(["docker", "compose", "up", "-d"]);
  result.ok ? done() : fail();
}

async function stop() {
  // First kill tmux and clean DB (while postgres is still running)
  await tmuxStop();

  step("Stopping docker");
  const result = await run(["docker", "compose", "down"]);
  result.ok ? done() : fail();
}

async function restart() {
  step("Rebuilding and restarting bot");
  const result = await run(["docker", "compose", "up", "-d", "--build", "bot"]);
  result.ok ? done() : fail();
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
    "psql", "-U", "claude_bot", "-d", "claude_bot", "-t", "-A",
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
  const query = await run([
    "docker", "compose", "exec", "-T", "postgres",
    "psql", "-U", "claude_bot", "-d", "claude_bot", "-t", "-A",
    "-c", `
      DELETE FROM sessions WHERE name LIKE 'cli-%';
      DELETE FROM message_queue WHERE delivered = true AND created_at < now() - interval '24 hours';
      DELETE FROM request_logs WHERE created_at < now() - interval '7 days';
      DELETE FROM api_request_stats WHERE created_at < now() - interval '30 days';
      DELETE FROM permission_requests WHERE created_at < now() - interval '1 hour';
      SELECT setval('sessions_id_seq', GREATEST((SELECT MAX(id) FROM sessions), 1));
    `,
  ], { silent: true });

  console.log(`\n  ${c.green("Cleanup complete")}`);
}

async function prune() {
  console.log(`\n  ${c.bold("Session Cleanup")}`);
  console.log(`  ${"─".repeat(40)}\n`);

  // Show current sessions
  const query = await run([
    "docker", "compose", "exec", "-T", "postgres",
    "psql", "-U", "claude_bot", "-d", "claude_bot", "-t", "-A",
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
    "psql", "-U", "claude_bot", "-d", "claude_bot", "-t", "-A",
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
    "psql", "-U", "claude_bot", "-d", "claude_bot", "-t", "-A",
    "-c", `DELETE FROM sessions WHERE id IN (${staleIds.join(",")});
      SELECT setval('sessions_id_seq', GREATEST((SELECT MAX(id) FROM sessions), 1));`,
  ], { silent: true });

  console.log(`\n  ${c.green(`Removed ${staleIds.length} sessions. Sequence reset.`)}`);
}

// --- Tmux management ---

const TMUX_SESSION = "claude";
const TMUX_PROJECTS_FILE = `${BOT_DIR}/tmux-projects.json`;

async function loadProjects(): Promise<{ name: string; path: string }[]> {
  if (existsSync(TMUX_PROJECTS_FILE)) {
    return JSON.parse(await Bun.file(TMUX_PROJECTS_FILE).text());
  }
  return [];
}

async function saveProjects(projects: { name: string; path: string }[]) {
  await Bun.write(TMUX_PROJECTS_FILE, JSON.stringify(projects, null, 2) + "\n");
}

async function tmuxStart() {
  const exists = await run(["tmux", "has-session", "-t", TMUX_SESSION], { silent: true });
  if (exists.ok) {
    console.log(`\n  ${c.yellow(`Session '${TMUX_SESSION}' already running.`)}`);
    console.log(`  Attach: ${c.cyan(`tmux attach -t ${TMUX_SESSION}`)}`);
    return;
  }

  let projects = await loadProjects();

  if (projects.length === 0) {
    console.log(`\n  ${c.yellow("No projects configured.")}`);
    console.log(`  Add projects first:\n`);
    console.log(`    ${c.cyan("claude-bot add /path/to/project")}`);
    console.log(`    ${c.cyan("claude-bot add .")} ${c.dim("(current directory)")}`);
    console.log(`    ${c.cyan("claude-bot add . --name work-session")} ${c.dim("(custom session name)")}\n`);
    return;
  }

  const usePanes = process.argv.includes("--split") || process.argv.includes("-s");

  console.log(`\n  ${c.bold("Starting tmux session")} ${c.cyan(TMUX_SESSION)}${usePanes ? " (split panes)" : ""}\n`);

  let first = true;
  let paneCount = 0;
  for (const p of projects) {
    if (!existsSync(p.path)) {
      console.log(`  ${c.yellow("SKIP")} ${p.name} — ${p.path} not found`);
      continue;
    }

    if (first) {
      await run(["tmux", "new-session", "-d", "-s", TMUX_SESSION, "-c", p.path]);
      await run(["tmux", "send-keys", "-t", TMUX_SESSION,
        `${BOT_DIR}/scripts/run-cli.sh ${p.path}`, "Enter"]);
      first = false;
    } else if (usePanes) {
      // Split into panes within the same window
      const direction = paneCount % 2 === 0 ? "-v" : "-h";
      await run(["tmux", "split-window", direction, "-t", TMUX_SESSION, "-c", p.path]);
      await run(["tmux", "send-keys", "-t", TMUX_SESSION,
        `${BOT_DIR}/scripts/run-cli.sh ${p.path}`, "Enter"]);
      await run(["tmux", "select-layout", "-t", TMUX_SESSION, "tiled"]);
    } else {
      // Separate windows (tabs)
      await run(["tmux", "new-window", "-t", TMUX_SESSION, "-n", p.name, "-c", p.path]);
      await run(["tmux", "send-keys", "-t", `${TMUX_SESSION}:${p.name}`,
        `${BOT_DIR}/scripts/run-cli.sh ${p.path}`, "Enter"]);
    }
    paneCount++;
    console.log(`  ${c.green("✓")} ${p.name} (${p.path})`);
  }

  console.log(`\n  ${c.green("Done!")} Attach: ${c.cyan(`tmux attach -t ${TMUX_SESSION}`)}`);
  if (usePanes) {
    console.log(`  Navigate: ${c.dim("Ctrl+B,Arrow — switch pane / Ctrl+B,Z — zoom pane")}`);
  } else {
    console.log(`  Navigate: ${c.dim("Ctrl+B,N (next) / Ctrl+B,P (prev) / Ctrl+B,W (list)")}`);
  }

  if (process.argv.includes("--attach") || process.argv.includes("-a")) {
    const proc = Bun.spawn(["tmux", "attach", "-t", TMUX_SESSION], {
      stdout: "inherit", stderr: "inherit", stdin: "inherit",
    });
    await proc.exited;
  }
}

async function tmuxStop() {
  step("Killing tmux session");
  await run(["tmux", "kill-session", "-t", TMUX_SESSION], { silent: true });
  done();

  step("Cleaning DB sessions");
  await run([
    "docker", "compose", "exec", "-T", "postgres",
    "psql", "-U", "claude_bot", "-d", "claude_bot", "-c",
    "DELETE FROM sessions WHERE name LIKE 'cli-%'; UPDATE sessions SET status = 'disconnected' WHERE id != 0 AND status = 'active';",
  ], { silent: true });
  done();

  console.log(`\n  ${c.green("Tmux sessions stopped, standalone untouched.")}`);
  console.log(`  Restart: ${c.cyan("claude-bot up")}`);
}

async function tmuxAdd(dir?: string) {
  // Parse --name and --provider flags from argv
  const nameIdx = process.argv.indexOf("--name");
  const customName = nameIdx >= 0 ? process.argv[nameIdx + 1] : undefined;
  const providerIdx = process.argv.indexOf("--provider");
  const provider = (providerIdx >= 0 ? process.argv[providerIdx + 1] : "claude") as "claude" | "opencode";

  // Skip --name/--provider and their values when resolving dir
  let resolvedDir = dir;
  if (resolvedDir === "--name" || resolvedDir === "--provider") resolvedDir = undefined;
  const projectDir = resolve(resolvedDir ?? ".");
  if (!existsSync(projectDir)) {
    console.log(c.red(`  Directory not found: ${projectDir}`));
    return;
  }

  const name = customName ?? basename(projectDir);

  // 1. Add to tmux-projects.json (existing behavior)
  const projects = await loadProjects();
  if (!projects.some(p => p.path === projectDir)) {
    projects.push({ name, path: projectDir });
    await saveProjects(projects);
  }

  // 2. Register session in bot via HTTP API
  const BOT_API_URL = process.env.BOT_API_URL ?? "http://localhost:3847";
  try {
    const cliConfig = provider === "opencode" ? { port: 4096, autostart: false } : {};
    const res = await fetch(`${BOT_API_URL}/api/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: projectDir, cliType: provider, cliConfig, name }),
    });
    if (res.ok) {
      const data = await res.json() as { sessionId?: number };
      console.log(`  ${c.green("Added:")} ${name} (${projectDir}) [${provider}]`);
      if (data.sessionId) console.log(`  Session #${data.sessionId} registered`);
    } else {
      console.log(`  ${c.green("Added to tmux:")} ${name} (${projectDir})`);
      console.log(`  ${c.yellow("Warning:")} bot API unavailable (${res.status}) — session not registered in DB`);
    }
  } catch {
    console.log(`  ${c.green("Added to tmux:")} ${name} (${projectDir})`);
    console.log(`  ${c.yellow("Warning:")} bot not running — session will register on next start`);
  }

  console.log(`  ${c.dim("Restart tmux to apply: claude-bot down && claude-bot up")}`);
}

async function tmuxRemove(name?: string) {
  if (!name) {
    console.log(c.red("  Usage: claude-bot remove <project-name>"));
    return;
  }

  const projects = await loadProjects();
  const filtered = projects.filter(p => p.name !== name);

  if (filtered.length === projects.length) {
    console.log(`  ${c.yellow(name)} not found in project list.`);
    return;
  }

  await saveProjects(filtered);
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
    let tmuxStatus = "";
    if (tmuxRunning) {
      const capture = await run(["tmux", "capture-pane", "-t", `${TMUX_SESSION}:${p.name}`, "-p"], { silent: true });
      tmuxStatus = capture.ok ? c.green(" [running]") : c.dim(" [no window]");
    }
    const dirStatus = exists ? "" : c.red(" (dir missing)");
    console.log(`  ${exists ? c.green("●") : c.red("●")} ${c.cyan(p.name)} — ${p.path}${dirStatus}${tmuxStatus}`);
  }

  if (!tmuxRunning) {
    console.log(`\n  ${c.dim(`tmux not running. Start: claude-bot up`)}`);
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
      "claude --dangerously-load-development-channels server:claude-bot-channel", "Enter"]);

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
      ["claude", "--dangerously-load-development-channels", "server:claude-bot-channel"],
      { cwd: projectDir, stdout: "inherit", stderr: "inherit", stdin: "inherit" },
    );
    await proc.exited;
  }
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
  await run(["claude", "mcp", "remove", "claude-bot", "-s", "user"], { silent: true });
  await run(["claude", "mcp", "remove", "claude-bot-channel", "-s", "user"], { silent: true });
  done();

  step("Registering HTTP MCP server");
  await run(["claude", "mcp", "add", "--transport", "http", "-s", "user", "claude-bot", `http://localhost:${port}/mcp`]);
  done();

  step("Registering stdio channel adapter");
  const config = JSON.stringify({
    type: "stdio",
    command: "bun",
    args: [`${BOT_DIR}/channel.ts`],
    env: { DATABASE_URL: dbUrl, OLLAMA_URL: ollamaUrl, TELEGRAM_BOT_TOKEN: botToken },
  });
  await run(["claude", "mcp", "add-json", "-s", "user", "claude-bot-channel", config]);
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
  const botPath = ask("Path to claude-bot on server", "/home/" + serverUser + "/bots/claude-bot");

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
      await run(["claude", "mcp", "remove", "claude-bot", "-s", "user"], { silent: true });
      await run(["claude", "mcp", "remove", "claude-bot-channel", "-s", "user"], { silent: true });
      done();

      step("Registering HTTP MCP server");
      await run(["claude", "mcp", "add", "--transport", "http", "-s", "user", "claude-bot", `http://localhost:${botPort}/mcp`]);
      done();

      step("Registering stdio channel adapter");
      const channelConfig = JSON.stringify({
        type: "stdio",
        command: "bun",
        args: [`${botPath}/channel.ts`],
        env: {
          DATABASE_URL: `postgres://claude_bot:claude_bot_secret@localhost:${dbPort}/claude_bot`,
          OLLAMA_URL: `http://localhost:11434`,
          TELEGRAM_BOT_TOKEN: botToken,
        },
      });
      await run(["claude", "mcp", "add-json", "-s", "user", "claude-bot-channel", channelConfig]);
      done();

      console.log(`\n  ${c.yellow("Important:")} channel.ts runs locally but connects to server DB via tunnel.`);
      console.log(`  Make sure ${c.cyan("bun")} and ${c.cyan(botPath + "/channel.ts")} exist on this machine.`);
      console.log(`  If not, clone the repo locally too.\n`);
    }

    console.log(`  ${c.bold("Step 3:")} Connect a project:\n`);
    console.log(`  ${c.cyan("cd your-project")}`);
    console.log(`  ${c.cyan("claude --dangerously-load-development-channels server:claude-bot-channel")}\n`);

  } else {
    // HTTP-only method
    console.log(`\n  ${c.bold("Step 1:")} Ensure bot port is accessible from your network.`);
    console.log(`  ${c.dim("Option A: SSH tunnel —")} ${c.cyan(`ssh -L ${botPort}:localhost:${botPort} ${serverUser}@${serverHost}`)}`);
    console.log(`  ${c.dim("Option B: Open port —")} expose port ${botPort} on server (less secure)\n`);

    const registerNow = ask("Register HTTP MCP server now? (y/n)", "y");
    if (registerNow.toLowerCase() === "y") {
      step("Removing old MCP registration");
      await run(["claude", "mcp", "remove", "claude-bot", "-s", "user"], { silent: true });
      done();

      step("Registering HTTP MCP server");
      await run(["claude", "mcp", "add", "--transport", "http", "-s", "user", "claude-bot", `http://localhost:${botPort}/mcp`]);
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

// --- Utilities ---

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function help() {
  console.log(`
  ${c.bold("Claude Bot CLI")}

  ${c.bold("Usage:")} bun cli.ts <command>

  ${c.bold("Setup:")}
    setup           Interactive installation wizard (server)
    remote          Connect laptop to a remote bot server
    mcp-register    Re-register MCP servers in Claude Code

  ${c.bold("Manage:")}
    start           Start bot (docker compose up)
    stop            Stop bot (docker compose down)
    restart         Rebuild and restart bot
    status          Show bot health and stats
    logs            Show bot logs (follow mode)

  ${c.bold("Data:")}
    sessions        List active sessions
    prune           Remove stale/duplicate sessions (interactive)
    backup          Run database backup
    cleanup         Clean old queue, logs, stats

  ${c.bold("Tmux:")}
    up [-a] [-s]    Start all projects in tmux (-a attach, -s split panes)
    down            Stop all tmux sessions + clean DB
    ps              List configured projects and status
    add [dir] [--name NAME]  Add project to tmux config
    remove <name>   Remove project from tmux config

  ${c.bold("Connect:")}
    connect [dir]        Start single CLI session (default: current dir)
    connect [dir] --tmux Start in standalone tmux (not managed)
`);
}

// --- Main ---

const command = process.argv[2];

switch (command) {
  case "setup":       await setup(); break;
  case "remote":      await remote(); break;
  case "start":       await start(); break;
  case "stop":        await stop(); break;
  case "restart":     await restart(); break;
  case "status":      await status(); break;
  case "sessions":    await sessions(); break;
  case "logs":        await logs(); break;
  case "backup":      await backup(); break;
  case "prune":       await prune(); break;
  case "cleanup":     await cleanup(); break;
  case "connect":     await connect(process.argv[3]); break;
  case "mcp-register": await mcpRegister(); break;
  case "up":          await tmuxStart(); break;
  case "down":        await tmuxStop(); break;
  case "ps":          await tmuxList(); break;
  case "add":         await tmuxAdd(process.argv[3]); break;
  case "remove":      await tmuxRemove(process.argv[3]); break;
  default:            help(); break;
}
