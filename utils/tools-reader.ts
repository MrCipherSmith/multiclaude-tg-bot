/**
 * Reads skills, commands and hooks from the host Claude config directory.
 * Inside Docker: HOST_CLAUDE_CONFIG=/host-claude-config (mounts ~/.claude)
 */

import { readdir } from "fs/promises";

const ICONS: Record<string, string> = {
  hookify: "🪝",
  "hookify-list": "📋",
  "hookify-configure": "⚙️",
  "hookify-help": "❓",
  commit: "💾",
  push: "🚀",
  pr: "🔀",
  "clean-gone": "🧹",
  changelog: "📜",
  "code-review": "🔍",
  "code-ai-review": "🤖",
  "code-b091-review": "🤖",
  "code-style-review": "🎨",
  "code-mobx-store-review": "🏪",
  "security-audit": "🔒",
  deploy: "📡",
  "feature-dev": "🛠",
  "feature-analyzer": "🔭",
  "issue-analyzer": "🎯",
  "task-implementer": "⚙️",
  "job-orchestrator": "🎼",
  "job-documenter": "📖",
  brainstorm: "💡",
  "db-migrate": "🗄️",
  "test-gen": "🧪",
  "dependency-update": "📦",
  "perf-check": "⚡",
  "prd-creator": "📝",
  "context-collector": "🔗",
  "skill-creator": "✨",
  "claude-md-improver": "🔧",
  "claude-md-management": "📁",
  "pr-issue-documenter": "📄",
  "pr-review-comments": "💬",
  "writing-rules": "✍️",
  "revise-claude-md": "♻️",
  interview: "🎤",
  interviewer: "🎤",
};

export function toolIcon(name: string): string {
  return ICONS[name] ?? "▸";
}

const HOST_CLAUDE_CONFIG = process.env.HOST_CLAUDE_CONFIG ?? "/host-claude-config";

// Commands/skills that never need arguments
const NO_ARGS_LIST = new Set([
  "commit", "push", "clean-gone", "changelog", "security-audit",
  "perf-check", "code-ai-review", "code-b091-review", "revise-claude-md",
  "hookify-list", "hookify-configure", "hookify-help", "code-review",
  "pr", "dependency-update", "db-migrate", "deploy", "test-gen",
  "claude-md-improver", "claude-md-management",
]);

export interface ToolItem {
  name: string;
  description: string;
  requiresArgs: boolean;
}

export interface HookItem {
  event: string;
  matcher?: string;
  command: string;
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    meta[key] = raw.replace(/^["']|["']$/g, "");
  }

  return { meta, body: match[2] };
}

function resolveRequiresArgs(name: string, meta: Record<string, string>, body: string): boolean {
  if (meta.args === "none") return false;
  if (NO_ARGS_LIST.has(name)) return false;
  if (body.includes("## Arguments")) return true;
  const hint = meta["argument-hint"] ?? "";
  if (hint && !hint.toLowerCase().startsWith("optional")) return true;
  if (meta.args && meta.args !== "none") return true;
  return false;
}

export async function readSkills(): Promise<ToolItem[]> {
  const skillsDir = `${HOST_CLAUDE_CONFIG}/skills`;
  const items: ToolItem[] = [];

  try {
    const dirs = await readdir(skillsDir, { withFileTypes: true });
    await Promise.all(
      dirs
        .filter((d) => d.isDirectory())
        .map(async (dir) => {
          try {
            const content = await Bun.file(`${skillsDir}/${dir.name}/SKILL.md`).text();
            const { meta, body } = parseFrontmatter(content);
            items.push({
              name: meta.name || dir.name,
              description: (meta.description || "").replace(/^["']|["']$/g, "").slice(0, 100),
              requiresArgs: resolveRequiresArgs(meta.name || dir.name, meta, body),
            });
          } catch {
            // No SKILL.md — skip
          }
        }),
    );
  } catch {
    // Dir not accessible
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readCommands(): Promise<ToolItem[]> {
  const commandsDir = `${HOST_CLAUDE_CONFIG}/commands`;
  const items: ToolItem[] = [];

  try {
    const files = await readdir(commandsDir);
    await Promise.all(
      files
        .filter((f) => f.endsWith(".md"))
        .map(async (file) => {
          const name = file.replace(/\.md$/, "");
          try {
            const content = await Bun.file(`${commandsDir}/${file}`).text();
            const { meta, body } = parseFrontmatter(content);
            items.push({
              name,
              description: (meta.description || "").slice(0, 100),
              requiresArgs: resolveRequiresArgs(name, meta, body),
            });
          } catch {
            // Skip
          }
        }),
    );
  } catch {
    // Dir not accessible
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readHooks(): Promise<HookItem[]> {
  const settingsPath = `${HOST_CLAUDE_CONFIG}/settings.json`;
  const items: HookItem[] = [];

  try {
    const content = await Bun.file(settingsPath).text();
    const settings = JSON.parse(content);
    const hooks = settings.hooks ?? {};

    for (const [event, rules] of Object.entries(hooks)) {
      if (!Array.isArray(rules)) continue;
      for (const rule of rules as any[]) {
        const matcher = rule.matcher ?? "";
        for (const h of (rule.hooks ?? []) as any[]) {
          items.push({ event, matcher: matcher || undefined, command: h.command ?? "" });
        }
      }
    }
  } catch {
    // Not accessible
  }

  return items;
}
