/**
 * Normalize cli_config from DB — handles broken states:
 *   - JSONB array of JSON strings (old bug)
 *   - JSONB string (double-encoded)
 *   - JSONB object (correct)
 */
export function normalizeCLIConfig(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const merged: Record<string, unknown> = {};
    for (const item of raw) {
      try {
        const parsed = typeof item === "string" ? JSON.parse(item) : item;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          Object.assign(merged, parsed);
        }
      } catch { /* skip */ }
    }
    return merged;
  }
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}
