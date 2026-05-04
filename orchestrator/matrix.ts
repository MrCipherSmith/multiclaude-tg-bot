import { resolve, relative, isAbsolute } from "node:path";

export type MatrixArtifact =
  | {
      type: "reply";
      text: string;
      sessionId: number | null;
      chatId: string;
      projectPath: string;
    }
  | {
      type: "tool_request";
      tool: string;
      input: Record<string, unknown>;
      sessionId: number | null;
      chatId: string;
      projectPath: string;
    };

export interface MatrixViolation {
  code: string;
  message: string;
  severity: "blocking" | "requires_confirmation";
  rule?: string;
}

export interface MatrixValidationResult {
  isValid: boolean;
  requiresConfirmation: boolean;
  violations: MatrixViolation[];
}

export interface StateMatrix {
  version: number;
  mode: "disabled" | "warn" | "block" | "auto_correct";
  maxCorrectionAttempts: number;
  paths: {
    allowed: string[];
    forbidden: string[];
  };
  commands: {
    allowed: string[];
    forbidden: string[];
    requiresExplicitConfirmation: string[];
  };
  replies: {
    requireVerificationForCodeTasks: boolean;
    forbidRawValidationErrors: boolean;
  };
  skills?: {
    source?: string;
    preferred: string[];
    rules: string[];
  };
  hash: string;
  path: string;
}

export class MatrixLoadError extends Error {
  constructor(message: string, readonly matrixPath: string) {
    super(message);
    this.name = "MatrixLoadError";
  }
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function parseMatrix(raw: unknown): Omit<StateMatrix, "hash" | "path"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("matrix must be an object");
  }
  const obj = raw as Record<string, any>;
  const version = obj.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new Error("version must be a positive integer");

  const mode = obj.mode ?? "auto_correct";
  if (!["disabled", "warn", "block", "auto_correct"].includes(mode)) {
    throw new Error("mode must be one of disabled, warn, block, auto_correct");
  }

  const maxCorrectionAttempts = obj.maxCorrectionAttempts ?? 5;
  if (!Number.isInteger(maxCorrectionAttempts) || maxCorrectionAttempts < 1 || maxCorrectionAttempts > 10) {
    throw new Error("maxCorrectionAttempts must be an integer from 1 to 10");
  }

  const paths = obj.paths ?? {};
  const commands = obj.commands ?? {};
  const replies = obj.replies ?? {};
  const skills = obj.skills;

  if (!paths || typeof paths !== "object" || Array.isArray(paths)) throw new Error("paths must be an object");
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) throw new Error("commands must be an object");
  if (!replies || typeof replies !== "object" || Array.isArray(replies)) throw new Error("replies must be an object");

  let parsedSkills: StateMatrix["skills"];
  if (skills !== undefined) {
    if (!skills || typeof skills !== "object" || Array.isArray(skills)) throw new Error("skills must be an object");
    parsedSkills = {
      source: typeof skills.source === "string" ? skills.source : undefined,
      preferred: stringArray(skills.preferred, "skills.preferred"),
      rules: stringArray(skills.rules, "skills.rules"),
    };
  }

  return {
    version,
    mode,
    maxCorrectionAttempts,
    paths: {
      allowed: stringArray(paths.allowed, "paths.allowed"),
      forbidden: stringArray(paths.forbidden, "paths.forbidden"),
    },
    commands: {
      allowed: stringArray(commands.allowed, "commands.allowed"),
      forbidden: stringArray(commands.forbidden, "commands.forbidden"),
      requiresExplicitConfirmation: stringArray(commands.requiresExplicitConfirmation, "commands.requiresExplicitConfirmation"),
    },
    replies: {
      requireVerificationForCodeTasks: replies.requireVerificationForCodeTasks === true,
      forbidRawValidationErrors: replies.forbidRawValidationErrors !== false,
    },
    ...(parsedSkills ? { skills: parsedSkills } : {}),
  };
}

export async function loadStateMatrix(projectPath: string): Promise<StateMatrix | null> {
  const matrixPath = resolve(projectPath, ".matrix.json");
  const file = Bun.file(matrixPath);
  if (!(await file.exists())) return null;

  const raw = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new MatrixLoadError(`Invalid JSON: ${err?.message ?? "parse failed"}`, matrixPath);
  }

  let matrix: Omit<StateMatrix, "hash" | "path">;
  try {
    matrix = parseMatrix(parsed);
  } catch (err: any) {
    throw new MatrixLoadError(`Invalid matrix schema: ${err?.message ?? "schema validation failed"}`, matrixPath);
  }

  return {
    ...matrix,
    hash: await sha256(raw),
    path: matrixPath,
  };
}

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const next = pattern[i + 1];
    if (ch === "*" && next === "*") {
      // `**` matches any depth including zero — if preceded by `/`, make the slash optional
      // so `src/**` matches both `src` (the directory itself) and `src/foo/bar`
      if (out.endsWith("/")) {
        out = out.slice(0, -1) + "(/.*)?";
      } else {
        out += ".*";
      }
      i++;
      // consume a trailing slash after `**` (e.g. `**/foo`)
      if (pattern[i + 1] === "/") i++;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if ("\\^$+?.()|{}[]".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`);
}

function matchesPattern(value: string, patterns: string[]): string | null {
  const normalized = value.replace(/\\/g, "/");
  for (const pattern of patterns) {
    const p = pattern.replace(/\\/g, "/");
    // exact equality or glob — no substring matching (prevents .env matching .envoy/config)
    if (normalized === p || globToRegExp(p).test(normalized)) {
      return pattern;
    }
  }
  return null;
}

function commandMatches(command: string, patterns: string[]): string | null {
  const normalized = command.trim().replace(/\s+/g, " ").toLowerCase();
  for (const pattern of patterns) {
    const p = pattern.trim().replace(/\s+/g, " ").toLowerCase();
    if (!p) continue;
    // exact equality or prefix match with word boundary (space after pattern)
    // prevents "rm" matching "prometheus" or "npm run"
    if (normalized === p || normalized.startsWith(p + " ")) return pattern;
  }
  return null;
}

function getPathInput(input: Record<string, unknown>): string | null {
  const candidates = ["file_path", "path", "notebook_path"];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function relativeProjectPath(projectPath: string, rawPath: string): { rel: string; outside: boolean } {
  const root = resolve(projectPath);
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const rel = relative(root, abs).replace(/\\/g, "/");
  return {
    rel: rel || ".",
    outside: rel === ".." || rel.startsWith("../") || isAbsolute(rel),
  };
}

function validateToolRequest(artifact: Extract<MatrixArtifact, { type: "tool_request" }>, matrix: StateMatrix): MatrixViolation[] {
  const violations: MatrixViolation[] = [];
  const tool = artifact.tool;

  if (tool === "Bash") {
    const command = typeof artifact.input.command === "string" ? artifact.input.command : "";
    const forbidden = commandMatches(command, matrix.commands.forbidden);
    if (forbidden) {
      violations.push({
        code: "COMMAND_FORBIDDEN",
        message: `Command matches forbidden pattern: ${forbidden}`,
        severity: "blocking",
        rule: forbidden,
      });
    }

    const requiresConfirmation = commandMatches(command, matrix.commands.requiresExplicitConfirmation);
    if (requiresConfirmation) {
      violations.push({
        code: "COMMAND_REQUIRES_CONFIRMATION",
        message: `Command requires explicit user confirmation: ${requiresConfirmation}`,
        severity: "requires_confirmation",
        rule: requiresConfirmation,
      });
    }

    if (matrix.commands.allowed.length > 0 && command && !commandMatches(command, matrix.commands.allowed)) {
      violations.push({
        code: "COMMAND_NOT_ALLOWED",
        message: "Command does not match any allowed command pattern",
        severity: "blocking",
      });
    }
  }

  const pathInput = getPathInput(artifact.input);
  if (pathInput) {
    const { rel, outside } = relativeProjectPath(artifact.projectPath, pathInput);
    if (outside) {
      violations.push({
        code: "PATH_OUTSIDE_PROJECT",
        message: `Path is outside project root: ${pathInput}`,
        severity: "blocking",
      });
    }

    const forbidden = matchesPattern(rel, matrix.paths.forbidden);
    if (forbidden) {
      violations.push({
        code: "PATH_FORBIDDEN",
        message: `Path matches forbidden pattern: ${forbidden}`,
        severity: "blocking",
        rule: forbidden,
      });
    }

    if (matrix.paths.allowed.length > 0 && !matchesPattern(rel, matrix.paths.allowed)) {
      violations.push({
        code: "PATH_NOT_ALLOWED",
        message: `Path does not match any allowed path pattern: ${rel}`,
        severity: "blocking",
      });
    }
  }

  return violations;
}

function validateReply(artifact: Extract<MatrixArtifact, { type: "reply" }>, matrix: StateMatrix): MatrixViolation[] {
  const violations: MatrixViolation[] = [];
  const text = artifact.text.trim();

  if (!text) {
    violations.push({
      code: "REPLY_EMPTY",
      message: "Reply is empty",
      severity: "blocking",
    });
  }

  if (matrix.replies.forbidRawValidationErrors && /COMMAND_[A-Z_]+|PATH_[A-Z_]+|State Matrix validation failed/i.test(text)) {
    violations.push({
      code: "REPLY_LEAKS_VALIDATION_DETAILS",
      message: "Reply appears to expose raw validation details",
      severity: "blocking",
    });
  }

  if (matrix.replies.requireVerificationForCodeTasks) {
    // Narrow set of unambiguous code-work verbs — avoids false positives for conversational
    // phrases like "I added a note" or "the config was updated"
    const claimsCodeWork = /\b(implemented|refactored|deployed)\b/i.test(text);
    const mentionsVerification = /\b(test|tests|verified|verification|lint|type-check|провер|тест)\b/i.test(text);
    if (claimsCodeWork && !mentionsVerification) {
      violations.push({
        code: "REPLY_MISSING_VERIFICATION",
        message: "Reply claims code work but does not mention verification",
        severity: "blocking",
      });
    }
  }

  return violations;
}

export function validateMatrixArtifact(artifact: MatrixArtifact, matrix: StateMatrix): MatrixValidationResult {
  if (matrix.mode === "disabled") {
    return { isValid: true, requiresConfirmation: false, violations: [] };
  }

  const violations = artifact.type === "reply"
    ? validateReply(artifact, matrix)
    : validateToolRequest(artifact, matrix);

  const blocking = violations.filter((v) => v.severity === "blocking");
  const requiresConfirmation = violations.some((v) => v.severity === "requires_confirmation");

  return {
    isValid: blocking.length === 0,
    requiresConfirmation,
    violations,
  };
}

export function buildCorrectionPrompt(params: {
  validation: MatrixValidationResult;
  attempt: number;
  maxAttempts: number;
  artifactType: MatrixArtifact["type"];
}): string {
  const blocking = params.validation.violations.filter((v) => v.severity === "blocking");
  const lines = blocking.length > 0 ? blocking : params.validation.violations;
  const formatted = lines.map((v) => `- ${v.code}: ${v.message}`).join("\n");

  return [
    "[Helyx State Matrix]",
    "Your previous output was not accepted by the deterministic project validator.",
    `Artifact type: ${params.artifactType}.`,
    `Correction attempt: ${params.attempt}/${params.maxAttempts}.`,
    "",
    "Violations:",
    formatted || "- Unknown matrix violation.",
    "",
    "Revise your next action so it complies with the State Matrix. Do not expose raw validator codes to the user.",
  ].join("\n");
}
