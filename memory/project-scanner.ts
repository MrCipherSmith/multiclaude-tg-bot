/**
 * Project knowledge scanner.
 * On first project registration, scans metadata files and saves structured facts to long-term memory.
 */

import { readdir, stat, readFile } from "fs/promises";
import { join, basename } from "path";
import { rememberSmart } from "./long-term.ts";
import { generateResponse } from "../llm/client.ts";
import { sql } from "./db.ts";

const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "__pycache__",
  "target", "vendor", ".cache", "coverage", ".turbo", ".vite", "out",
]);

/**
 * Check if a project already has knowledge records scanned.
 */
async function hasProjectKnowledge(projectPath: string): Promise<boolean> {
  const rows = await sql`
    SELECT COUNT(*) as cnt FROM memories
    WHERE project_path = ${projectPath}
      AND tags @> ARRAY['project']
      AND archived_at IS NULL
  `;
  return Number(rows[0].cnt) > 0;
}

/**
 * Read a file safely, returning null if not found or unreadable.
 */
async function readSafe(path: string, maxChars = 3000): Promise<string | null> {
  try {
    const content = await readFile(path, "utf-8");
    return content.slice(0, maxChars);
  } catch {
    return null;
  }
}

/**
 * Get top-level directory listing (filtered).
 */
async function getTopLevelDirs(projectPath: string): Promise<string[]> {
  try {
    const entries = await readdir(projectPath, { withFileTypes: true });
    return entries
      .filter((e) => !EXCLUDED_DIRS.has(e.name) && !e.name.startsWith("."))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .slice(0, 30);
  } catch {
    return [];
  }
}

/**
 * Detect entry points by checking common paths.
 */
async function detectEntryPoints(projectPath: string): Promise<string[]> {
  const candidates = [
    "main.ts", "main.js", "index.ts", "index.js",
    "src/main.ts", "src/main.js", "src/index.ts", "src/index.js",
    "app.ts", "app.js", "server.ts", "server.js",
    "cmd/", "bin/",
  ];
  const found: string[] = [];
  for (const c of candidates) {
    try {
      await stat(join(projectPath, c));
      found.push(c);
    } catch {}
  }
  return found;
}

/**
 * Collect raw project metadata for LLM synthesis.
 */
async function collectMetadata(projectPath: string): Promise<string> {
  const parts: string[] = [];

  // README
  for (const name of ["README.md", "README.rst", "README.txt", "README"]) {
    const content = await readSafe(join(projectPath, name), 2000);
    if (content) {
      // Extract up to first ## heading or 1000 chars
      const firstSection = content.split(/\n##\s/)[0];
      parts.push(`## README\n${firstSection.trim().slice(0, 1000)}`);
      break;
    }
  }

  // Package manifest
  for (const name of ["package.json", "pyproject.toml", "go.mod", "Cargo.toml"]) {
    const content = await readSafe(join(projectPath, name), 2000);
    if (content) {
      parts.push(`## ${name}\n${content}`);
      break;
    }
  }

  // Directory structure
  const dirs = await getTopLevelDirs(projectPath);
  if (dirs.length > 0) {
    parts.push(`## Top-level structure\n${dirs.join("\n")}`);
  }

  // Entry points
  const entries = await detectEntryPoints(projectPath);
  if (entries.length > 0) {
    parts.push(`## Entry points found\n${entries.join(", ")}`);
  }

  return parts.join("\n\n");
}

/**
 * Use LLM to synthesize structured facts from raw metadata.
 */
async function synthesizeFacts(metadata: string, projectName: string): Promise<Array<{ content: string; category: string }>> {
  const prompt = `Given this project's metadata, generate 3-7 concise fact memories.

Rules:
- Each fact must be a single self-contained sentence under 150 characters
- Facts should describe permanent structure, not session events
- Use category: stack | architecture | setup | conventions | entry-points

Format each fact as: [category] fact text

Examples:
[stack] TypeScript + Bun runtime, grammY for Telegram, PostgreSQL with pgvector
[entry-points] Bot starts from main.ts; CLI is cli.ts; channel adapter is channel.ts
[setup] Requires Docker Compose for postgres; Ollama must run on host (not in container)
[architecture] Port 3847 serves both MCP server and dashboard via the same HTTP server

Project: ${projectName}

${metadata}`;

  try {
    const response = await generateResponse(
      [{ role: "user", content: prompt }],
      "You extract structured project facts. Output only the requested [category] fact lines, one per line.",
    );

    const facts: Array<{ content: string; category: string }> = [];
    for (const line of response.split("\n")) {
      const match = line.match(/^\[(\w[\w-]*)\]\s+(.+)$/);
      if (match) {
        const category = match[1].toLowerCase();
        const content = match[2].trim();
        if (content.length > 10 && content.length <= 200) {
          facts.push({ category, content });
        }
      }
    }
    return facts.slice(0, 8);
  } catch (err) {
    console.error("[project-scanner] LLM synthesis failed:", err);
    return [];
  }
}

/**
 * Scan a project directory and save knowledge to long-term memory.
 * Skips if knowledge already exists. Safe to call multiple times (idempotent via rememberSmart).
 */
export async function scanProjectKnowledge(projectPath: string, forceRescan = false): Promise<number> {
  const projectName = basename(projectPath);

  try {
    // Guard: skip if already scanned (unless force rescan)
    if (!forceRescan && await hasProjectKnowledge(projectPath)) {
      console.log(`[project-scanner] ${projectName}: already has knowledge, skipping`);
      return 0;
    }

    // Archive existing project knowledge if force-rescanning
    if (forceRescan) {
      await sql`
        UPDATE memories SET archived_at = now()
        WHERE project_path = ${projectPath}
          AND tags @> ARRAY['project']
          AND archived_at IS NULL
      `;
      console.log(`[project-scanner] ${projectName}: archived existing knowledge for rescan`);
    }

    console.log(`[project-scanner] scanning ${projectPath}...`);
    const metadata = await collectMetadata(projectPath);

    if (!metadata.trim()) {
      console.log(`[project-scanner] ${projectName}: no metadata found, skipping`);
      return 0;
    }

    const facts = await synthesizeFacts(metadata, projectName);

    if (facts.length === 0) {
      console.log(`[project-scanner] ${projectName}: no facts extracted`);
      return 0;
    }

    // Save each fact via smart reconciliation
    let saved = 0;
    for (const { content, category } of facts) {
      try {
        await rememberSmart({
          source: "api",
          sessionId: null,
          chatId: "",
          type: "fact",
          content,
          tags: ["project", category],
          projectPath,
        });
        saved++;
      } catch (err) {
        console.error(`[project-scanner] failed to save fact:`, err);
      }
    }

    console.log(`[project-scanner] ${projectName}: saved ${saved}/${facts.length} facts`);
    return saved;
  } catch (err) {
    console.error(`[project-scanner] error scanning ${projectPath}:`, err);
    return 0;
  }
}
