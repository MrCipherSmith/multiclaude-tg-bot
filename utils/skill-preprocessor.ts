// Hermes Skills Toolkit — Phase A: inline shell preprocessor.
//
// Security:
// - shell exec runs in helyx host process; PRD treats SKILL.md authors as trusted,
//   but agent-created bodies (Phase C) are LLM-generated and reviewed via Telegram
//   approval before they can be saved.
// - env passed to Bun.spawn is an explicit allowlist, NOT process.env, so commands
//   cannot read DEEPSEEK_API_KEY / DATABASE_URL / etc. via `!`echo $X`` injection.

const INLINE_SHELL_DETECT_RE = /!`[^`\n]+`/;

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_OUTPUT_CAP = 4096;
const SIGKILL_GRACE_MS = 500;

const SAFE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "USER"] as const;

export function getShellTimeout(): number {
  const env = process.env.HELYX_SHELL_TIMEOUT_MS;
  return env ? parseInt(env, 10) || DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

export function getShellOutputCap(): number {
  const env = process.env.HELYX_SHELL_OUTPUT_CAP;
  return env ? parseInt(env, 10) || DEFAULT_OUTPUT_CAP : DEFAULT_OUTPUT_CAP;
}

function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  if (!env.PATH) env.PATH = "/usr/local/bin:/usr/bin:/bin";
  if (!env.HOME) env.HOME = "/tmp";
  return env;
}

export interface ExpandResult {
  body: string;
  shellCount: number;
  errorsCount: number;
  firstError?: string;
}

interface ShellRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

async function runOneInlineShell(
  cmd: string,
  timeoutMs: number,
  cap: number,
  cwd: string,
): Promise<ShellRunResult> {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd,
    env: buildSafeEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  const sigtermTimer = setTimeout(() => {
    timedOut = true;
    try { proc.kill("SIGTERM"); } catch { /* already exited */ }
    sigkillTimer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already exited */ }
    }, SIGKILL_GRACE_MS);
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  try {
    // Drain stdout AND stderr concurrently with awaiting exit. If we wait for
    // proc.exited first, a child producing >64 KB will block on the full pipe
    // and exit never resolves — drain unblocks the writer.
    const [stdoutText, stderrText] = await Promise.all([
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
    ]);
    stdout = stdoutText;
    stderr = stderrText;
    await proc.exited;
  } finally {
    clearTimeout(sigtermTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
  }

  const cappedStdout =
    stdout.length > cap ? stdout.slice(0, cap) + "…[truncated]" : stdout;

  return {
    stdout: cappedStdout,
    stderr,
    exitCode: proc.exitCode ?? -1,
    timedOut,
  };
}

export async function expandInlineShell(body: string, cwd?: string): Promise<ExpandResult> {
  // Fresh, non-shared regex per call so module-level state can never bleed.
  const re = /!`([^`\n]+)`/g;
  const matches = [...body.matchAll(re)];
  if (matches.length === 0) return { body, shellCount: 0, errorsCount: 0 };

  let errorsCount = 0;
  let firstError: string | undefined;
  const timeout = getShellTimeout();
  const cap = getShellOutputCap();
  const workDir = cwd ?? process.cwd();

  // Splice replacements by match index — handles duplicate identical tokens
  // correctly (String.prototype.replace would only replace the first one).
  const parts: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    const start = match.index!;
    const end = start + match[0].length;
    parts.push(body.slice(cursor, start));

    const cmd = match[1]!;
    let replacement: string;
    try {
      const r = await runOneInlineShell(cmd, timeout, cap, workDir);
      if (r.timedOut) {
        replacement = `[inline-shell timeout after ${timeout / 1000}s: ${cmd}]`;
        errorsCount++;
        if (!firstError) firstError = replacement;
      } else if (r.exitCode !== 0) {
        replacement = `[inline-shell error: ${r.stderr.slice(0, 500)}]`;
        errorsCount++;
        if (!firstError) firstError = replacement;
      } else {
        replacement = r.stdout;
      }
    } catch {
      replacement = `[inline-shell error: spawn failed: ${cmd.slice(0, 100)}]`;
      errorsCount++;
      if (!firstError) firstError = replacement;
    }

    parts.push(replacement);
    cursor = end;
  }
  parts.push(body.slice(cursor));

  return {
    body: parts.join(""),
    shellCount: matches.length,
    errorsCount,
    firstError,
  };
}

export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  if (!raw.startsWith("---")) return { frontmatter: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: raw };
  const fmText = raw.slice(4, end);
  const body = raw.slice(end + 4).trimStart();
  const frontmatter: Record<string, string> = {};
  for (const line of fmText.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

// Detection uses a non-/g regex so .test() stays stateless across calls.
export function hasInlineShellTokens(body: string): boolean {
  return INLINE_SHELL_DETECT_RE.test(body);
}
