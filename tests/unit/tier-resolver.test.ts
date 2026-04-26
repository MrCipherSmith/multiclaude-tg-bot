/**
 * Unit tests for llm/tier-resolver.ts — per-task model_tier override.
 *
 * Pure-logic tests (isValidTier, payload shape variants) run without a DB.
 * Profile-resolution tests are gated on DATABASE_URL since
 * resolveProfileByName hits model_profiles JOIN model_providers.
 */

import { describe, expect, test } from "bun:test";

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe("tier-resolver: isValidTier", () => {
  test("accepts 'flash'", async () => {
    const { isValidTier } = await import("../../llm/tier-resolver.ts");
    expect(isValidTier("flash")).toBe(true);
  });

  test("accepts 'pro'", async () => {
    const { isValidTier } = await import("../../llm/tier-resolver.ts");
    expect(isValidTier("pro")).toBe(true);
  });

  test("rejects unknown strings", async () => {
    const { isValidTier } = await import("../../llm/tier-resolver.ts");
    expect(isValidTier("turbo")).toBe(false);
    expect(isValidTier("default")).toBe(false);
    expect(isValidTier("")).toBe(false);
  });

  test("rejects non-string values", async () => {
    const { isValidTier } = await import("../../llm/tier-resolver.ts");
    expect(isValidTier(undefined)).toBe(false);
    expect(isValidTier(null)).toBe(false);
    expect(isValidTier(0)).toBe(false);
    expect(isValidTier(1)).toBe(false);
    expect(isValidTier({})).toBe(false);
    expect(isValidTier([])).toBe(false);
    expect(isValidTier(true)).toBe(false);
  });
});

describe("tier-resolver: resolveTierOverride payload shape (no DB hit)", () => {
  // These tests short-circuit before any DB call. They run unconditionally
  // — the resolver is a single import away from the worker hot path and
  // a refactor that accidentally widens the accepted payload shape would
  // bypass these guards silently.

  test("returns null for null payload", async () => {
    const { resolveTierOverride } = await import("../../llm/tier-resolver.ts");
    expect(await resolveTierOverride(null)).toBeNull();
  });

  test("returns null for undefined payload", async () => {
    const { resolveTierOverride } = await import("../../llm/tier-resolver.ts");
    expect(await resolveTierOverride(undefined)).toBeNull();
  });

  test("returns null for non-object payload (string)", async () => {
    const { resolveTierOverride } = await import("../../llm/tier-resolver.ts");
    expect(await resolveTierOverride("flash")).toBeNull();
  });

  test("returns null for object without model_tier key", async () => {
    const { resolveTierOverride } = await import("../../llm/tier-resolver.ts");
    expect(await resolveTierOverride({ foo: "bar" })).toBeNull();
  });

  test("returns null for invalid model_tier value", async () => {
    const { resolveTierOverride } = await import("../../llm/tier-resolver.ts");
    expect(await resolveTierOverride({ model_tier: "ultra" })).toBeNull();
  });

  test("returns null for non-string model_tier", async () => {
    const { resolveTierOverride } = await import("../../llm/tier-resolver.ts");
    expect(await resolveTierOverride({ model_tier: 99 })).toBeNull();
  });
});

describe("tier-resolver: resolveTierOverride profile resolution (requires DB)", () => {
  test.skipIf(!HAS_DB)("resolves 'flash' to deepseek-flash profile", async () => {
    const { resolveTierOverride } = await import("../../llm/tier-resolver.ts");
    const result = await resolveTierOverride({ model_tier: "flash" });
    expect(result).not.toBeNull();
    expect(result!.providerType).toBeDefined();
    // Provider config from deepseek-flash profile must be a non-empty model id.
    expect(typeof result!.model).toBe("string");
    expect(result!.model.length).toBeGreaterThan(0);
  });

  test.skipIf(!HAS_DB)("resolves 'pro' to deepseek-pro profile", async () => {
    const { resolveTierOverride } = await import("../../llm/tier-resolver.ts");
    const result = await resolveTierOverride({ model_tier: "pro" });
    expect(result).not.toBeNull();
    expect(typeof result!.model).toBe("string");
    expect(result!.model.length).toBeGreaterThan(0);
  });

  test.skipIf(!HAS_DB)("'flash' and 'pro' resolve to different models", async () => {
    const { resolveTierOverride } = await import("../../llm/tier-resolver.ts");
    const flash = await resolveTierOverride({ model_tier: "flash" });
    const pro = await resolveTierOverride({ model_tier: "pro" });
    expect(flash).not.toBeNull();
    expect(pro).not.toBeNull();
    // Whole point of tiering — the two tiers MUST point at different models.
    expect(flash!.model).not.toBe(pro!.model);
  });
});
