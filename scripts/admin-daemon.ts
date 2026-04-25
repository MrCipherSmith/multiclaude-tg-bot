#!/usr/bin/env bun
/**
 * admin-daemon — host-side daemon that processes admin_commands from the DB.
 * Executes tmux/helyx commands on the host machine.
 *
 * Usage:
 *   bun scripts/admin-daemon.ts
 *
 * Requires DATABASE_URL env var (pointing to localhost:5433).
 * Reads from .env in the same directory if not set.
 */

import { resolve } from "path";
import { startTmuxWatchdog } from "./tmux-watchdog.ts";
import { startSupervisor } from "./supervisor.ts";
import { TmuxDriver } from "../runtime/drivers/tmux-driver.ts";
import { runtimeManager } from "../runtime/runtime-manager.ts";

const BOT_DIR = resolve(import.meta.dir, "..");
const CLI = resolve(BOT_DIR, "cli.ts");
const RUN_CLI_PATH = resolve(BOT_DIR, "scripts/run-cli.sh");

// Load .env if DATABASE_URL not set
if (!process.env.DATABASE_URL) {
  const envFile = Bun.file(resolve(BOT_DIR, ".env"));
  if (await envFile.exists()) {
    const envText = await envFile.text();
    for (const line of envText.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  }
}

if (!process.env.DATABASE_URL) {
  console.error("[admin-daemon] DATABASE_URL not set");
  process.exit(1);
}

const postgres = (await import("postgres")).default;
const sql = postgres(process.env.DATABASE_URL, { max: 3 });

console.log("[admin-daemon] started, polling for commands...");

// Recover stuck commands from previous crash
await sql`UPDATE admin_commands SET status = 'pending', updated_at = now()
          WHERE status = 'processing' AND updated_at < now() - interval '5 minutes'`
  .catch(err => console.error("[admin-daemon] stuck command recovery error:", err));
console.log("[admin-daemon] stuck command recovery complete");

// Start session health supervisor
startSupervisor(sql, runShell as any);

// --- Process health heartbeat ---
// Writes admin-daemon PID + Docker container statuses to `process_health` every 30 s.
// The /monitor bot command reads from this table.
const DAEMON_START = Date.now();

async function writeProcessHealth(): Promise<void> {
  const uptimeMs = Date.now() - DAEMON_START;

  // Own heartbeat — pass object directly so postgres.js serializes it as JSONB object
  await sql`
    INSERT INTO process_health (name, status, detail, updated_at)
    VALUES ('admin-daemon', 'running', ${sql.json({ pid: process.pid, uptime_ms: uptimeMs })}, now())
    ON CONFLICT (name) DO UPDATE SET status = 'running', detail = EXCLUDED.detail, updated_at = now()
  `.catch(() => {});

  // Docker container statuses
  const dockerResult = await runShell(`timeout 10 docker ps --format "{{.Names}}\\t{{.Status}}" 2>/dev/null || true`);
  const dockerOut = dockerResult.output;
  for (const line of dockerOut.split("\n").filter(Boolean)) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const name = line.slice(0, tab).trim();
    const status = line.slice(tab + 1).trim();
    const running = !status.toLowerCase().startsWith("exited") && !status.toLowerCase().startsWith("dead");
    await sql`
      INSERT INTO process_health (name, status, detail, updated_at)
      VALUES (${`docker:${name}`}, ${running ? "running" : "stopped"}, ${sql.json({ status })}, now())
      ON CONFLICT (name) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, updated_at = now()
    `.catch(() => {});
  }

  // Remove entries for containers that no longer appear in `docker ps`
  const activeNames = dockerOut.split("\n").filter(Boolean).map((l) => {
    const tab = l.indexOf("\t");
    return tab !== -1 ? `docker:${l.slice(0, tab).trim()}` : null;
  }).filter(Boolean) as string[];

  if (activeNames.length > 0) {
    await sql`
      DELETE FROM process_health
      WHERE name LIKE 'docker:%' AND name != ALL(${activeNames})
    `.catch(() => {});
  }
}

// Write immediately on startup, then every 30 s
writeProcessHealth().catch(() => {});
let healthWriteRunning = false;
const healthInterval = setInterval(() => {
  if (healthWriteRunning) return;
  healthWriteRunning = true;
  writeProcessHealth().catch(() => {}).finally(() => { healthWriteRunning = false; });
}, 30_000);
// Prevent the interval from keeping the process alive if everything else exits
healthInterval.unref?.();

async function runCommand(cmd: string, args: string[] = []): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(["bun", CLI, cmd, ...args], {
    cwd: BOT_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { ok: proc.exitCode === 0, output: (stdout + stderr).trim() };
}

async function runShell(cmd: string): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd: BOT_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { ok: proc.exitCode === 0, output: (stdout + stderr).trim() };
}

// Shell adapter for TmuxDriver — driver expects `{stdout, stderr, exitCode}`,
// admin-daemon's `runShell` returns `{ok, output}` (combined stdout+stderr).
// This thin wrapper preserves the data the driver actually consumes (it only
// branches on `exitCode` and reads `stderr`/`stdout` for error messages).
async function runShellForDriver(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd: BOT_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  // exitCode === null means the process was killed by a signal — treat as failure
  // (POSIX convention) so the driver doesn't mistake a signal-killed subprocess for success.
  return { stdout, stderr, exitCode: proc.exitCode ?? 1 };
}

// Instantiate and register the tmux runtime driver. Other modules
// (channel/, supervisor) can resolve it via runtimeManager.getDriver("tmux").
const tmuxDriver = new TmuxDriver({
  defaultSession: "bots",
  runCliPath: RUN_CLI_PATH,
  runShell: runShellForDriver,
  log: (msg, meta) => console.log(`[tmux-driver] ${msg}`, meta ?? ""),
});

if (!runtimeManager.hasDriver("tmux")) {
  runtimeManager.registerDriver(tmuxDriver);
}

// Start tmux watchdog if bot token is available. The watchdog uses the same
// TmuxDriver instance for pane snapshot operations (capturePane / capturePaneVisible)
// so the driver's shell-runner injection and naming conventions stay consistent.
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (botToken) {
  startTmuxWatchdog(sql, botToken, tmuxDriver);
} else {
  console.warn("[admin-daemon] TELEGRAM_BOT_TOKEN not set — tmux watchdog disabled");
}

async function processCommand(row: { id: bigint; command: string; payload: any }): Promise<void> {
  // postgres.js may return JSONB as string — normalize
  const payload: Record<string, any> = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  console.log(`[admin-daemon] executing: ${row.command} ${JSON.stringify(payload)}`);
  let result: { ok: boolean; output: string };

  try {
    switch (row.command) {
      case "tmux_start":
        result = await runCommand("up", ["-s"]);
        break;

      case "tmux_stop":
        result = await runShell("tmux kill-session -t bots 2>&1 || true");
        // Mark all remote sessions as inactive in DB
        await sql`UPDATE sessions SET status = 'inactive' WHERE source = 'remote'`;
        break;

      case "proj_start": {
        const { path } = payload;
        if (!path) { result = { ok: false, output: "missing path" }; break; }
        const name = (path as string).split("/").pop() ?? path;
        try {
          const handle = { driver: "tmux", tmuxSession: "bots", tmuxWindow: name };
          await tmuxDriver.start(handle, { projectPath: path, projectName: name });
          result = { ok: true, output: `started ${name}` };
        } catch (e: any) {
          result = { ok: false, output: e?.message ?? String(e) };
        }
        break;
      }

      case "docker_restart": {
        const { container } = payload as { container: string };
        if (!container) { result = { ok: false, output: "missing container" }; break; }
        // Validate container name to prevent shell injection
        if (!/^[a-zA-Z0-9_.-]+$/.test(container)) {
          result = { ok: false, output: `invalid container name: ${container}` }; break;
        }
        const shellResult = await runShell(`docker restart ${container} 2>&1`);
        result = { ok: shellResult.ok, output: shellResult.output.trim() || (shellResult.ok ? `restarted ${container}` : "docker restart failed") };
        break;
      }

      case "restart_admin_daemon": {
        // Mark done first, then spawn a fresh instance and exit.
        await sql`
          UPDATE admin_commands SET status = 'done', result = 'spawning replacement', executed_at = now()
          WHERE id = ${row.id}
        `;
        await runShell(
          `nohup bun ${resolve(import.meta.dir, "admin-daemon.ts")} >> /tmp/admin-daemon.log 2>&1 &`
        );
        console.log("[admin-daemon] replacement spawned, exiting for restart");
        await Bun.sleep(300);
        clearInterval(healthInterval);
        process.exit(0);
        break; // unreachable, but satisfies TS
      }

      case "tmux_send_keys": {
        const { project, action } = payload as { project: string; action: string };
        if (!project) { result = { ok: false, output: "missing project" }; break; }
        const target = `bots:${project}`;
        try {
          const handle = { driver: "tmux", tmuxSession: "bots", tmuxWindow: project };
          if (action === "esc" || action === "interrupt") {
            await tmuxDriver.sendInput(handle, { kind: "esc" });
            result = { ok: true, output: `Sent Escape to ${target}` };
          } else if (action === "close_editor") {
            await tmuxDriver.sendInput(handle, { kind: "close_editor" });
            result = { ok: true, output: `Sent :q! to ${target}` };
          } else {
            result = { ok: false, output: `unknown action: ${action}` };
          }
        } catch (e: any) {
          result = { ok: false, output: e?.message ?? String(e) };
        }
        break;
      }

      case "proj_stop": {
        let { name, project_id } = payload;
        if (!name && project_id) {
          const prows = await sql`SELECT name FROM projects WHERE id = ${project_id}`;
          if (prows.length > 0) name = prows[0].name;
        }
        if (!name) { result = { ok: false, output: "missing name" }; break; }
        try {
          const handle = { driver: "tmux", tmuxSession: "bots", tmuxWindow: name };
          await tmuxDriver.stop(handle);
          result = { ok: true, output: `stopped ${name}` };
        } catch (e: any) {
          result = { ok: false, output: e?.message ?? String(e) };
        }
        if (project_id) {
          await sql`UPDATE sessions SET status = 'inactive' WHERE project_id = ${project_id} AND source = 'remote'`;
        } else {
          await sql`UPDATE sessions SET status = 'inactive' WHERE project = ${name} AND source = 'remote'`;
        }
        break;
      }

      default:
        result = { ok: false, output: `unknown command: ${row.command}` };
    }
  } catch (err: any) {
    result = { ok: false, output: err?.message ?? String(err) };
  }

  await sql`
    UPDATE admin_commands
    SET status = ${result.ok ? "done" : "error"}, result = ${result.output}, executed_at = now()
    WHERE id = ${row.id}
  `;

  console.log(`[admin-daemon] ${result.ok ? "✓" : "✗"} ${row.command}: ${result.output.slice(0, 100)}`);
}

// Main polling loop
while (true) {
  try {
    await sql.begin(async (tx) => {
      const rows = await tx`
        SELECT id, command, payload FROM admin_commands
        WHERE status = 'pending'
        ORDER BY created_at
        LIMIT 5
        FOR UPDATE SKIP LOCKED
      `;
      for (const row of rows) {
        await tx`UPDATE admin_commands SET status = 'processing' WHERE id = ${row.id}`;
        // Process outside the transaction to avoid long lock holds
        setImmediate(() => processCommand(row as any));
      }
    });
  } catch (err: any) {
    console.error("[admin-daemon] poll error:", err?.message);
    await Bun.sleep(5000);
  }

  await Bun.sleep(2000);
}
