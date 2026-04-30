// Shared handler logic for the skill_view MCP tool — used by both
// `mcp/tools.ts` (Claude Code subprocess MCP) and `channel/tools.ts`
// (host-side dispatch).
//
// Phase A: filesystem-backed skill loading + inline shell expansion.
// Phase C extends this module with the agent_created_skills branch.

import {
  expandInlineShell,
  hasInlineShellTokens,
  parseFrontmatter,
} from "./skill-preprocessor.ts";

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export interface SkillSqlContext {
  // Tagged-template SQL function (postgres.js) — used for skill_preprocess_log writes.
  sql: any;
}

export function getSkillsDir(): string {
  return process.env.CLAUDE_SKILLS_DIR ?? `${process.env.HOME}/.claude/skills`;
}

export async function handleSkillView(
  rawSkillName: unknown,
  ctx: SkillSqlContext,
): Promise<string> {
  const skillName = String(rawSkillName ?? "");
  // B-06: path-traversal guard — reject anything outside the kebab-case grammar
  // before either filesystem or SQL access.
  if (!NAME_RE.test(skillName)) {
    return JSON.stringify({ error: "invalid skill name", name: skillName });
  }

  const skillsDir = getSkillsDir();
  const startTime = Date.now();

  const skillPath = `${skillsDir}/${skillName}/SKILL.md`;
  const file = Bun.file(skillPath);
  if (!(await file.exists())) {
    return JSON.stringify({ error: "skill not found", name: skillName });
  }

  const raw = await file.text();

  // FR-A-8 fast path: no tokens → byte-identical to native loader, no log row.
  if (!hasInlineShellTokens(raw)) {
    const { frontmatter, body } = parseFrontmatter(raw);
    return JSON.stringify({
      name: skillName,
      description: frontmatter.description ?? "",
      body,
      frontmatter,
    });
  }

  const expanded = await expandInlineShell(raw);
  const { frontmatter } = parseFrontmatter(raw);
  const durationMs = Date.now() - startTime;

  ctx.sql`
    INSERT INTO skill_preprocess_log
      (skill_name, duration_ms, shell_count, errors_count, first_error)
    VALUES
      (${skillName}, ${durationMs}, ${expanded.shellCount}, ${expanded.errorsCount}, ${expanded.firstError ?? null})
  `.catch((err: unknown) =>
    console.warn("[skill_view] preprocess log failed:", err),
  );

  return JSON.stringify({
    name: skillName,
    description: frontmatter.description ?? "",
    body: expanded.body,
    frontmatter,
  });
}
