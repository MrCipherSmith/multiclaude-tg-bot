const INLINE_SHELL_RE = /!`([^`\n]+)`/g;

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_OUTPUT_CAP = 4096;

export function getShellTimeout(): number {
  const env = process.env.HELYX_SHELL_TIMEOUT_MS;
  return env ? parseInt(env, 10) || DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

export function getShellOutputCap(): number {
  const env = process.env.HELYX_SHELL_OUTPUT_CAP;
  return env ? parseInt(env, 10) || DEFAULT_OUTPUT_CAP : DEFAULT_OUTPUT_CAP;
}

export interface ExpandResult {
  body: string;
  shellCount: number;
  errorsCount: number;
  firstError?: string;
}

export async function expandInlineShell(body: string, cwd?: string): Promise<ExpandResult> {
  const matches = [...body.matchAll(INLINE_SHELL_RE)];
  if (matches.length === 0) return { body, shellCount: 0, errorsCount: 0 };

  let result = body;
  let errorsCount = 0;
  let firstError: string | undefined;
  const timeout = getShellTimeout();
  const cap = getShellOutputCap();
  const workDir = cwd ?? process.cwd();

  for (const match of matches) {
    const cmd = match[1]!;
    const fullMatch = match[0];
    try {
      const proc = Bun.spawn(["bash", "-c", cmd], {
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      });

      let replacement: string;
      try {
        const exit = await Promise.race([
          proc.exited,
          Bun.sleep(timeout).then(() => "timeout" as const),
        ]);

        if (exit === "timeout") {
          proc.kill();
          replacement = `[inline-shell timeout after ${timeout / 1000}s: ${cmd}]`;
          errorsCount++;
          if (!firstError) firstError = replacement;
        } else if (exit !== 0) {
          const errText = await new Response(proc.stderr).text();
          replacement = `[inline-shell error: ${errText.slice(0, 500)}]`;
          errorsCount++;
          if (!firstError) firstError = replacement;
        } else {
          let stdout = await new Response(proc.stdout).text();
          if (stdout.length > cap) {
            stdout = stdout.slice(0, cap) + "…[truncated]";
          }
          replacement = stdout;
        }
      } catch {
        proc.kill();
        replacement = `[inline-shell error: command execution failed]`;
        errorsCount++;
        if (!firstError) firstError = replacement;
      }
      result = result.replace(fullMatch, replacement);
    } catch {
      const err = `[inline-shell error: spawn failed: ${cmd.slice(0, 100)}]`;
      result = result.replace(fullMatch, err);
      errorsCount++;
      if (!firstError) firstError = err;
    }
  }

  return { body: result, shellCount: matches.length, errorsCount, firstError };
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

export function hasInlineShellTokens(body: string): boolean {
  return INLINE_SHELL_RE.test(body);
}
