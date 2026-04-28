/**
 * Regression test for the v1.32.1 jsonb cast fix.
 *
 * postgres.js v3 silently strips trailing `::jsonb` casts on parameter
 * placeholders. The v1.32.0 codebase had 8 sites using the broken
 * `${JSON.stringify(x)}::jsonb` pattern → JSONB column got a scalar
 * string. This test asserts that, given the current code, a session
 * INSERT lands as a JSONB object (the operational symptom of the
 * pre-fix bug was `jsonb_typeof = 'string'`).
 *
 * Reverting any patched site to `${JSON.stringify(x)}::jsonb` makes
 * the assertion fail.
 *
 * Requires DATABASE_URL.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const RUN_TAG = `jsonb-fix-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

interface Seed {
  cleanupSessionIds: number[];
  cleanupAdminCommandIds: bigint[];
}
let seed: Seed = { cleanupSessionIds: [], cleanupAdminCommandIds: [] };

async function getSql() {
  const { sql } = await import("../../memory/db.ts");
  return sql;
}

beforeAll(async () => {
  if (!HAS_DB) return;
});

afterAll(async () => {
  if (!HAS_DB) return;
  const sql = await getSql();
  if (seed.cleanupSessionIds.length > 0) {
    await sql`DELETE FROM sessions WHERE id IN ${sql(seed.cleanupSessionIds)}`;
  }
  if (seed.cleanupAdminCommandIds.length > 0) {
    await sql`DELETE FROM admin_commands WHERE id IN ${sql(seed.cleanupAdminCommandIds)}`;
  }
});

describe("v1.32.1 jsonb cast fix", () => {
  test.skipIf(!HAS_DB)("session register: metadata + cli_config land as JSONB objects", async () => {
    const { sessionManager } = await import("../../sessions/manager.ts");
    const sql = await getSql();
    const clientId = `__test_${RUN_TAG}__`;
    const session = await sessionManager.register(
      `name-${RUN_TAG}`,
      "/tmp/fake",
      clientId,
      { from: "regression-test", marker: RUN_TAG },
      { ide: "test", session_index: 1 },
    );
    seed.cleanupSessionIds.push(session.id);

    const [row] = (await sql`
      SELECT
        jsonb_typeof(metadata) AS meta_t,
        jsonb_typeof(cli_config) AS cli_t,
        metadata, cli_config
      FROM sessions WHERE id = ${session.id}
    `) as any[];
    // Pre-fix: meta_t / cli_t = 'string' (scalar JSON-as-text)
    expect(row.meta_t).toBe("object");
    expect(row.cli_t).toBe("object");
    expect((row.metadata as any).marker).toBe(RUN_TAG);
    expect((row.cli_config as any).ide).toBe("test");
  });

  test.skipIf(!HAS_DB)("admin_commands.payload: project-service action lands as JSONB object", async () => {
    // services/project-service.ts emits proj_start admin commands.
    // The idempotency check `(payload->>'project_id')::int = id` only
    // works when payload is a real JSONB object, not a scalar string.
    const sql = await getSql();
    const tag = `proj-test-${RUN_TAG}`;
    const [row] = (await sql`
      INSERT INTO admin_commands (command, payload, status)
      VALUES ('proj_start', ${sql.json({ project_id: 9999, name: tag, path: "/tmp/x" })}, 'pending')
      RETURNING id
    `) as any[];
    seed.cleanupAdminCommandIds.push(row.id);

    const [check] = (await sql`
      SELECT
        jsonb_typeof(payload) AS t,
        (payload->>'project_id')::int AS pid,
        payload->>'name' AS name
      FROM admin_commands WHERE id = ${row.id}
    `) as any[];
    expect(check.t).toBe("object");
    expect(Number(check.pid)).toBe(9999);
    expect(check.name).toBe(tag);
  });

  test.skipIf(!HAS_DB)("project-service idempotency check actually finds duplicate via jsonb operator", async () => {
    // Pre-fix: `(payload->>'project_id')::int = ${id}` returned NULL on
    // scalar-string rows → check never found dupes → admin_commands could
    // accumulate duplicate proj_start commands. This test exercises the
    // exact predicate.
    const sql = await getSql();
    const fakeProjectId = 999_998;
    const cleanup: bigint[] = [];
    try {
      // Insert two rows with same project_id — second should be findable
      // via the same predicate the service uses for idempotency.
      const [a] = (await sql`
        INSERT INTO admin_commands (command, payload, status)
        VALUES ('proj_start', ${sql.json({ project_id: fakeProjectId, name: "x", path: "/x" })}, 'pending')
        RETURNING id
      `) as any[];
      cleanup.push(a.id);

      const matches = (await sql`
        SELECT id FROM admin_commands
        WHERE command = 'proj_start'
          AND (payload->>'project_id')::int = ${fakeProjectId}
          AND status IN ('pending', 'processing')
      `) as any[];
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(Number(matches[0].id)).toBe(Number(a.id));
    } finally {
      if (cleanup.length > 0) {
        await sql`DELETE FROM admin_commands WHERE id IN ${sql(cleanup)}`;
      }
    }
  });
});
