#!/usr/bin/env bun
/**
 * admin-daemon — host-side daemon that processes admin_commands from the DB.
 * Executes tmux/claude-bot commands on the host machine.
 *
 * Usage:
 *   bun scripts/admin-daemon.ts
 *
 * Requires DATABASE_URL env var (pointing to localhost:5433).
 * Reads from .env in the same directory if not set.
 */

import { resolve } from "path";

const BOT_DIR = resolve(import.meta.dir, "..");
const CLI = resolve(BOT_DIR, "cli.ts");

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
const sql = postgres(process.env.DATABASE_URL, { max: 2 });

console.log("[admin-daemon] started, polling for commands...");

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

async function processCommand(row: { id: bigint; command: string; payload: Record<string, string> }): Promise<void> {
  console.log(`[admin-daemon] executing: ${row.command} ${JSON.stringify(row.payload)}`);
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
        const { path } = row.payload;
        if (!path) { result = { ok: false, output: "missing path" }; break; }
        const name = path.split("/").pop() ?? path;
        // Add window to existing tmux session or start a new session
        const hasSession = await runShell("tmux has-session -t bots 2>/dev/null");
        if (hasSession.ok) {
          const wname = `${name}`;
          result = await runShell(
            `tmux new-window -t bots -n "${wname}" -c "${path}" && ` +
            `tmux send-keys -t "bots:${wname}" "${BOT_DIR}/scripts/run-cli.sh ${path}" Enter`
          );
        } else {
          result = await runCommand("up", ["-s"]);
        }
        break;
      }

      case "proj_stop": {
        let { name, project_id } = row.payload;
        if (!name && project_id) {
          const prows = await sql`SELECT name FROM projects WHERE id = ${project_id}`;
          if (prows.length > 0) name = prows[0].name;
        }
        if (!name) { result = { ok: false, output: "missing name" }; break; }
        result = await runShell(`tmux kill-window -t "bots:${name}" 2>&1 || tmux kill-window -t "bots:${name} " 2>&1 || echo "window not found"`);
        await sql`UPDATE sessions SET status = 'inactive' WHERE project = ${name} AND source = 'remote'`;
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
    const rows = await sql`
      SELECT id, command, payload FROM admin_commands
      WHERE status = 'pending'
      ORDER BY created_at
      LIMIT 5
    `;

    for (const row of rows) {
      // Mark as processing to avoid double-execution
      const claimed = await sql`
        UPDATE admin_commands SET status = 'processing' WHERE id = ${row.id} AND status = 'pending'
        RETURNING id
      `;
      if (claimed.length > 0) {
        await processCommand(row as any);
      }
    }
  } catch (err: any) {
    console.error("[admin-daemon] poll error:", err?.message);
    await Bun.sleep(5000);
  }

  await Bun.sleep(2000);
}
