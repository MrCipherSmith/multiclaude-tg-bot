/**
 * Unit tests for skill distiller — validation and input checking.
 */
import { describe, test, expect } from "bun:test";
import { validateSkillInput } from "../../utils/skill-distiller.ts";

describe("validateSkillInput", () => {
  test("valid input passes", () => {
    const result = validateSkillInput(
      "git-state",
      "Use when you need git status",
      "---\nname: git-state\n---\n# Git State",
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("invalid name regex fails", () => {
    const result = validateSkillInput("GitState", "Use when testing", "body");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "name")).toBe(true);
  });

  test("name must start with lowercase letter", () => {
    const result = validateSkillInput("1skill", "Use when testing", "body");
    expect(result.valid).toBe(false);
  });

  test("description must start with Use when", () => {
    const result = validateSkillInput("test-skill", "This does not start correctly", "body");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "description")).toBe(true);
  });

  test("description too long fails", () => {
    const longDesc = "Use when " + "x".repeat(1020);
    const result = validateSkillInput("test-skill", longDesc, "body");
    expect(result.valid).toBe(false);
  });

  test("body too long fails", () => {
    const longBody = "x".repeat(100001);
    const result = validateSkillInput("test-skill", "Use when testing", longBody);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "body")).toBe(true);
  });
});