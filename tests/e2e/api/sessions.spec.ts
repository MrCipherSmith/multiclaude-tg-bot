/**
 * API tests — sessions endpoints.
 * SAFETY: never calls DELETE or switch on the current active session.
 */
import { test, expect } from "../fixtures";

const BASE = process.env.TEST_BASE_URL ?? "https://helyx.mrciphersmith.com";

test.describe("GET /api/sessions", () => {
  test("returns array of sessions", async ({ request, authHeaders }) => {
    const res = await request.get(`${BASE}/api/sessions`, { headers: authHeaders });
    expect(res.status()).toBe(200);
    const sessions = await res.json();
    expect(Array.isArray(sessions)).toBe(true);
  });

  test("sessions have required fields", async ({ request, authHeaders }) => {
    const res = await request.get(`${BASE}/api/sessions`, { headers: authHeaders });
    const sessions = await res.json();
    if (sessions.length === 0) return;
    const s = sessions[0];
    expect(s).toHaveProperty("id");
    expect(s).toHaveProperty("status");
    expect(s).toHaveProperty("source");
    expect(["active", "inactive", "terminated"]).toContain(s.status);
    expect(["remote", "local", "standalone"]).toContain(s.source);
  });

  test("excludes standalone session (id=0)", async ({ request, authHeaders }) => {
    const res = await request.get(`${BASE}/api/sessions`, { headers: authHeaders });
    const sessions = await res.json();
    expect(sessions.every((s: any) => s.id !== 0)).toBe(true);
  });
});

test.describe("GET /api/sessions/active", () => {
  test("returns null or a valid session", async ({ request, authHeaders }) => {
    const res = await request.get(`${BASE}/api/sessions/active`, { headers: authHeaders });
    expect(res.status()).toBe(200);
    const body = await res.json();
    if (body !== null) {
      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("status");
      expect(body).toHaveProperty("source");
      expect(body).toHaveProperty("project");
    }
  });
});

test.describe("GET /api/sessions/:id", () => {
  test("returns session detail with tokens and recent_tools", async ({ request, authHeaders }) => {
    const listRes = await request.get(`${BASE}/api/sessions`, { headers: authHeaders });
    const sessions = await listRes.json();
    if (sessions.length === 0) test.skip();
    const id = sessions[0].id;
    const res = await request.get(`${BASE}/api/sessions/${id}`, { headers: authHeaders });
    expect(res.status()).toBe(200);
    const detail = await res.json();
    expect(detail).toHaveProperty("message_count");
    expect(detail).toHaveProperty("tokens");
    expect(detail.tokens).toHaveProperty("input_tokens");
    expect(detail.tokens).toHaveProperty("output_tokens");
    expect(detail.tokens).toHaveProperty("api_calls");
    expect(detail).toHaveProperty("recent_tools");
    expect(Array.isArray(detail.recent_tools)).toBe(true);
    expect(detail).toHaveProperty("source");
    expect(detail).toHaveProperty("project");
  });

  test("returns 404 for non-existent session", async ({ request, authHeaders }) => {
    const res = await request.get(`${BASE}/api/sessions/999999`, { headers: authHeaders });
    expect(res.status()).toBe(404);
  });
});

test.describe("GET /api/sessions/:id/messages", () => {
  test("returns paginated messages", async ({ request, authHeaders }) => {
    const listRes = await request.get(`${BASE}/api/sessions`, { headers: authHeaders });
    const sessions = await listRes.json();
    if (sessions.length === 0) test.skip();
    const id = sessions[0].id;
    const res = await request.get(
      `${BASE}/api/sessions/${id}/messages?limit=10&offset=0`,
      { headers: authHeaders },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("messages");
    expect(body).toHaveProperty("total");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBeLessThanOrEqual(10);
  });
});

test.describe("GET /api/overview", () => {
  test("returns overview stats with db connected", async ({ request, authHeaders }) => {
    const res = await request.get(`${BASE}/api/overview`, { headers: authHeaders });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("sessions");
    // db field can be true or "connected" depending on API version
    expect(body.db).toBeTruthy();
  });
});

test.describe("Auth", () => {
  test("unauthenticated request returns 401", async ({ request }) => {
    const res = await request.get(`${BASE}/api/sessions`);
    expect(res.status()).toBe(401);
  });

  test("invalid token returns 401", async ({ request }) => {
    const res = await request.get(`${BASE}/api/sessions`, {
      headers: { Authorization: "Bearer invalid.token.here" },
    });
    expect(res.status()).toBe(401);
  });
});
