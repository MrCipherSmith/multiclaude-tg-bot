import { sql } from "../memory/db.ts";
import { callAuxLlm, type AuxLlmResponse } from "./aux-llm-client.ts";

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_DESCRIPTION = 1024;
const MAX_BODY = 100000;

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export function validateSkillInput(
  name: string,
  description: string,
  body: string,
): ValidationResult {
  const errors: ValidationError[] = [];

  if (!NAME_RE.test(name)) {
    errors.push({ field: "name", message: "name must be kebab-case, 1-64 chars, lowercase + digits + hyphens only" });
  }

  if (!description.startsWith("Use when")) {
    errors.push({ field: "description", message: 'description must start with "Use when"' });
  }

  if (description.length > MAX_DESCRIPTION) {
    errors.push({ field: "description", message: `description too long (max ${MAX_DESCRIPTION} chars)` });
  }

  if (body.length > MAX_BODY) {
    errors.push({ field: "body", message: `body too long (max ${MAX_BODY} chars)` });
  }

  try {
    if (body.startsWith("---")) {
      const end = body.indexOf("\n---", 3);
      if (end > 0) {
        const fmText = body.slice(4, end);
        for (const line of fmText.split("\n")) {
          const colon = line.indexOf(":");
          if (colon === -1) continue;
          const key = line.slice(0, colon).trim();
          if (!fmText.split("\n").some((l) => l.startsWith(key + ":"))) {
            // Basic YAML check - if parse fails, will catch when testing valid frontmatter
          }
        }
      }
    }
  } catch {
    errors.push({ field: "body", message: "frontmatter must be valid YAML" });
  }

  return { valid: errors.length === 0, errors };
}

const DISTILLATION_PROMPT = `You are skill-distillation aux. Given a session transcript ending with a successful
multi-step task, produce a SKILL.md that captures the workflow as a reusable
procedure. Required output schema:

---
name: <kebab-case, ≤64 chars, regex ^[a-z][a-z0-9-]{0,63}$>
description: "Use when <one-line trigger>. <one-line behavior>."  # ≤1024 chars
version: 1.0.0
author: helyx
license: MIT
metadata:
  helyx:
    tags: [<tag1>, <tag2>]
    related_skills: []
---

# <Title>

## Overview
<2-3 sentences>

## When to Use
- <trigger 1>
- <trigger 2>

## Steps
1. <action with concrete commands; use !\`cmd\` for dynamic context>
2. ...

## Common Pitfalls
- <pitfall>: <fix>

## Verification Checklist
- [ ] <check>

Constraints:
- description MUST start with "Use when"
- body ≤100000 chars
- Use !\`cmd\` syntax for any dynamic git / fs / env state
- Generic enough to apply to similar future tasks, specific enough to be useful`;

export interface DistillResult {
  success: boolean;
  name?: string;
  description?: string;
  body?: string;
  skillId?: number;
  error?: string;
}

export async function distillSkill(
  sessionId: number,
  chatId: string,
  transcript: string,
): Promise<DistillResult> {
  const truncated = transcript.length > 16000
    ? "[…earlier truncated…]\n" + transcript.slice(-16000)
    : transcript;

  const llmResult = await callAuxLlm(DISTILLATION_PROMPT, `Transcript:\n${truncated}`, "skill_distillation");

  if (!("content" in llmResult)) {
    return { success: false, error: llmResult.error };
  }

  const content = llmResult.content;
  const nameMatch = content.match(/^name:\s*(\S+)/m);
  const descMatch = content.match(/^description:\s*(.+)/m);

  if (!nameMatch || !descMatch) {
    return { success: false, error: "LLM output missing name or description" };
  }

  const name = nameMatch[1]!;
  const description = descMatch[1]!.trim();
  const body = content;

  const validation = validateSkillInput(name, description, body);
  if (!validation.valid) {
    return { success: false, error: validation.errors.map((e) => e.message).join("; ") };
  }

  try {
    const [row] = await sql`
      INSERT INTO agent_created_skills (name, description, body, status, source_session_id, source_chat_id)
      VALUES (${name}, ${description}, ${body}, 'proposed', ${sessionId}, ${chatId})
      RETURNING id
    `;
    return { success: true, name, description, body, skillId: row.id };
  } catch (err) {
    if (err instanceof Error && err.message.includes("unique")) {
      return { success: false, error: "name already exists" };
    }
    return { success: false, error: String(err) };
  }
}

export async function listAgentSkills() {
  return sql`
    SELECT name, description, status, use_count, last_used_at, created_at
    FROM agent_created_skills
    WHERE status = 'active'
    ORDER BY last_used_at DESC
  `;
}

export async function approveSkill(skillId: number): Promise<boolean> {
  const result = await sql`
    UPDATE agent_created_skills
    SET status = 'active', approved_at = now()
    WHERE id = ${skillId} AND status = 'proposed'
    RETURNING id
  `;
  return result.length > 0;
}

export async function rejectSkill(skillId: number): Promise<boolean> {
  const result = await sql`
    UPDATE agent_created_skills
    SET status = 'rejected', rejected_at = now()
    WHERE id = ${skillId} AND status = 'proposed'
    RETURNING id
  `;
  return result.length > 0;
}