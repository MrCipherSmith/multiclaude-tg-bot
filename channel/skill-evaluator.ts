/**
 * Skill Evaluator — scores incoming Telegram messages against the goodai-base rules.json
 * registry and injects skill hints into the MCP notification content.
 *
 * Mirrors the scoring logic from goodai-base/hooks/skill-eval.js:
 *   keywords: +2 each (substring, case-insensitive)
 *   intents:  +2 each (regex, case-insensitive)
 * Min score to surface: 4. Max suggestions: 3.
 */

import { channelLogger } from "../logger.ts";

interface RulesEntry {
  id: string;
  type: "skill" | "rule";
  path: string;
  description: string;
  triggers: {
    keywords?: string[];
    intents?: string[];
  };
}

interface RulesJson {
  entries: RulesEntry[];
}

interface Match {
  id: string;
  type: "skill" | "rule";
  path: string;
  score: number;
  confidence: "high" | "medium" | "low";
  reasons: string[];
}

const MIN_SCORE = 4;
const MAX_SUGGESTIONS = 3;

export class SkillEvaluator {
  private registry: RulesEntry[] | null = null;

  /** Load rules.json from goodai-base. Call once at startup. */
  async load(homeDir: string, goodaiBasePath?: string): Promise<void> {
    const candidates = [
      ...(goodaiBasePath ? [`${goodaiBasePath}/rules.json`] : []),
      `${homeDir}/goodai-base/rules.json`,
    ];

    for (const path of candidates) {
      try {
        const text = await Bun.file(path).text();
        const data = JSON.parse(text) as RulesJson;
        if (Array.isArray(data.entries) && data.entries.length > 0) {
          this.registry = data.entries;
          channelLogger.info({ path, count: data.entries.length }, "skill registry loaded");
          return;
        }
      } catch {
        // try next candidate
      }
    }

    channelLogger.debug({ homeDir }, "skill registry not found — skill hints disabled");
  }

  /** Score a message and return the hint prefix, or empty string if no matches. */
  buildHint(text: string): string {
    if (!this.registry) return "";

    const lowerText = text.toLowerCase();
    const matches: Match[] = [];

    for (const entry of this.registry) {
      let score = 0;
      const reasons: string[] = [];

      for (const kw of entry.triggers.keywords ?? []) {
        if (lowerText.includes(kw.toLowerCase())) {
          score += 2;
          reasons.push(`kw:"${kw}"`);
        }
      }

      for (const intent of entry.triggers.intents ?? []) {
        try {
          if (new RegExp(intent, "i").test(text)) {
            score += 2;
            reasons.push(`intent:/${intent}/`);
          }
        } catch {
          // malformed regex — skip
        }
      }

      if (score >= MIN_SCORE) {
        matches.push({
          id: entry.id,
          type: entry.type,
          path: entry.path,
          score,
          confidence: score >= 8 ? "high" : score >= 5 ? "medium" : "low",
          reasons,
        });
      }
    }

    if (matches.length === 0) return "";

    matches.sort((a, b) => b.score - a.score);
    const top = matches.slice(0, MAX_SUGGESTIONS);

    const skills = top.filter((m) => m.type === "skill");
    const rules = top.filter((m) => m.type === "rule");

    const parts: string[] = [];
    if (skills.length > 0) {
      parts.push(`skills: ${skills.map((m) => `${m.id} (${m.confidence})`).join(", ")}`);
    }
    if (rules.length > 0) {
      parts.push(`rules: ${rules.map((m) => m.id).join(", ")}`);
    }

    return `[Skill Evaluator] ${parts.join(" · ")}\n`;
  }
}
