/**
 * API tests — git endpoints.
 * Uses the active session's project_path for git operations.
 */
import { test, expect } from "../fixtures";

const BASE = process.env.TEST_BASE_URL ?? "https://helyx.mrciphersmith.com";

async function getActiveSessionId(request: any, authHeaders: Record<string, string>): Promise<number | null> {
  const res = await request.get(`${BASE}/api/sessions/active`, { headers: authHeaders });
  const body = await res.json();
  return body?.id ?? null;
}

test.describe("Git API", () => {
  test("GET /api/git/:id/tree returns file list", async ({ request, authHeaders }) => {
    const id = await getActiveSessionId(request, authHeaders);
    if (!id) test.skip();
    const res = await request.get(`${BASE}/api/git/${id}/tree`, { headers: authHeaders });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("files");
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.files.length).toBeGreaterThan(0);
  });

  test("GET /api/git/:id/log returns commits", async ({ request, authHeaders }) => {
    const id = await getActiveSessionId(request, authHeaders);
    if (!id) test.skip();
    const res = await request.get(`${BASE}/api/git/${id}/log?limit=5`, { headers: authHeaders });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("commits");
    expect(Array.isArray(body.commits)).toBe(true);
    if (body.commits.length > 0) {
      const c = body.commits[0];
      expect(c).toHaveProperty("hash");
      expect(c).toHaveProperty("subject");
      expect(c).toHaveProperty("author");
    }
  });

  test("GET /api/git/:id/status returns file statuses", async ({ request, authHeaders }) => {
    const id = await getActiveSessionId(request, authHeaders);
    if (!id) test.skip();
    const res = await request.get(`${BASE}/api/git/${id}/status`, { headers: authHeaders });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("files");
    expect(Array.isArray(body.files)).toBe(true);
  });

  test("GET /api/git/:id/branches returns current branch", async ({ request, authHeaders }) => {
    const id = await getActiveSessionId(request, authHeaders);
    if (!id) test.skip();
    const res = await request.get(`${BASE}/api/git/${id}/branches`, { headers: authHeaders });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("branches");
    expect(Array.isArray(body.branches)).toBe(true);
    expect(body.branches.some((b: any) => b.current)).toBe(true);
  });

  test("GET /api/git/:id/file returns content or 404 (no 500)", async ({ request, authHeaders }) => {
    const id = await getActiveSessionId(request, authHeaders);
    if (!id) test.skip();
    const res = await request.get(
      `${BASE}/api/git/${id}/file?path=package.json&ref=HEAD`,
      { headers: authHeaders },
    );
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("content");
      expect(typeof body.content).toBe("string");
    }
  });

  test("path traversal attempt returns 400 or 404", async ({ request, authHeaders }) => {
    const id = await getActiveSessionId(request, authHeaders);
    if (!id) test.skip();
    const res = await request.get(
      `${BASE}/api/git/${id}/file?path=../../etc/passwd&ref=HEAD`,
      { headers: authHeaders },
    );
    expect([400, 404]).toContain(res.status());
  });
});
