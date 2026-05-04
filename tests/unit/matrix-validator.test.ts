import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadStateMatrix, type StateMatrix, validateMatrixArtifact } from "../../orchestrator/matrix.ts";

function matrix(overrides: Partial<StateMatrix> = {}): StateMatrix {
  return {
    version: 1,
    mode: "auto_correct",
    maxCorrectionAttempts: 5,
    hash: "test",
    path: "/project/.matrix.json",
    paths: {
      allowed: [],
      forbidden: [],
    },
    commands: {
      allowed: [],
      forbidden: [],
      requiresExplicitConfirmation: [],
    },
    replies: {
      requireVerificationForCodeTasks: false,
      forbidRawValidationErrors: true,
    },
    ...overrides,
  };
}

describe("State Matrix command validation", () => {
  test("blocks forbidden commands", () => {
    const result = validateMatrixArtifact({
      type: "tool_request",
      tool: "Bash",
      input: { command: "docker compose down" },
      sessionId: 1,
      chatId: "1",
      projectPath: "/repo",
    }, matrix({
      commands: {
        allowed: [],
        forbidden: ["docker compose down"],
        requiresExplicitConfirmation: [],
      },
    }));

    expect(result.isValid).toBe(false);
    expect(result.violations[0]?.code).toBe("COMMAND_FORBIDDEN");
  });

  test("marks confirmation-required commands without blocking permission prompt", () => {
    const result = validateMatrixArtifact({
      type: "tool_request",
      tool: "Bash",
      input: { command: "docker compose restart api" },
      sessionId: 1,
      chatId: "1",
      projectPath: "/repo",
    }, matrix({
      commands: {
        allowed: [],
        forbidden: [],
        requiresExplicitConfirmation: ["docker compose restart"],
      },
    }));

    expect(result.isValid).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.violations[0]?.code).toBe("COMMAND_REQUIRES_CONFIRMATION");
  });
});

describe("State Matrix path validation", () => {
  test("allows paths matching allowed globs", () => {
    const result = validateMatrixArtifact({
      type: "tool_request",
      tool: "Edit",
      input: { file_path: "/repo/src/index.ts" },
      sessionId: 1,
      chatId: "1",
      projectPath: "/repo",
    }, matrix({
      paths: {
        allowed: ["src/**"],
        forbidden: [],
      },
    }));

    expect(result.isValid).toBe(true);
  });

  test("blocks forbidden paths", () => {
    const result = validateMatrixArtifact({
      type: "tool_request",
      tool: "Write",
      input: { file_path: "/repo/.env" },
      sessionId: 1,
      chatId: "1",
      projectPath: "/repo",
    }, matrix({
      paths: {
        allowed: [],
        forbidden: [".env"],
      },
    }));

    expect(result.isValid).toBe(false);
    expect(result.violations[0]?.code).toBe("PATH_FORBIDDEN");
  });

  test("blocks absolute paths outside the project root", () => {
    const result = validateMatrixArtifact({
      type: "tool_request",
      tool: "Read",
      input: { file_path: "/tmp/secret.txt" },
      sessionId: 1,
      chatId: "1",
      projectPath: "/repo",
    }, matrix());

    expect(result.isValid).toBe(false);
    expect(result.violations[0]?.code).toBe("PATH_OUTSIDE_PROJECT");
  });
});

describe("State Matrix reply validation", () => {
  test("blocks empty replies", () => {
    const result = validateMatrixArtifact({
      type: "reply",
      text: "   ",
      sessionId: 1,
      chatId: "1",
      projectPath: "/repo",
    }, matrix());

    expect(result.isValid).toBe(false);
    expect(result.violations[0]?.code).toBe("REPLY_EMPTY");
  });

  test("blocks raw validation leakage", () => {
    const result = validateMatrixArtifact({
      type: "reply",
      text: "COMMAND_FORBIDDEN happened",
      sessionId: 1,
      chatId: "1",
      projectPath: "/repo",
    }, matrix());

    expect(result.isValid).toBe(false);
    expect(result.violations[0]?.code).toBe("REPLY_LEAKS_VALIDATION_DETAILS");
  });

  test("requires verification when configured and reply claims code work", () => {
    const result = validateMatrixArtifact({
      type: "reply",
      text: "Implemented the new validator.",
      sessionId: 1,
      chatId: "1",
      projectPath: "/repo",
    }, matrix({
      replies: {
        forbidRawValidationErrors: true,
        requireVerificationForCodeTasks: true,
      },
    }));

    expect(result.isValid).toBe(false);
    expect(result.violations[0]?.code).toBe("REPLY_MISSING_VERIFICATION");
  });
});

describe("State Matrix loading", () => {
  test("loads .matrix.json from project root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helyx-matrix-"));
    try {
      await writeFile(join(dir, ".matrix.json"), JSON.stringify({
        version: 1,
        mode: "block",
        paths: { allowed: ["src/**"], forbidden: [".env"] },
      }));

      const loaded = await loadStateMatrix(dir);
      expect(loaded?.mode).toBe("block");
      expect(loaded?.paths.allowed).toEqual(["src/**"]);
      expect(loaded?.hash).toHaveLength(64);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

