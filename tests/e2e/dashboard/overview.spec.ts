/**
 * Dashboard / Webapp static serving tests.
 */
import { test, expect } from "../fixtures";

const BASE = process.env.TEST_BASE_URL ?? "https://helyx.mrciphersmith.com";

test.describe("API health", () => {
  test("/api/overview returns db=true", async ({ request, authHeaders }) => {
    const res = await request.get(`${BASE}/api/overview`, { headers: authHeaders });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.db).toBeTruthy();
  });
});

test.describe("Webapp static serving", () => {
  test("webapp index.html loads with no-store cache", async ({ request }) => {
    const res = await request.get(`${BASE}/webapp/`);
    expect(res.status()).toBe(200);
    const cc = res.headers()["cache-control"] ?? "";
    expect(cc).toContain("no-store");
    const html = await res.text();
    expect(html).toContain("<div id=\"root\">");
    expect(html).toContain("telegram-web-app.js");
  });

  test("webapp JS asset served with immutable cache", async ({ request }) => {
    const html = await (await request.get(`${BASE}/webapp/`)).text();
    const match = html.match(/src="(\/webapp\/assets\/index-[^"]+\.js)"/);
    if (!match) {
      test.skip(true, "Could not find JS asset URL in HTML");
      return;
    }
    const assetRes = await request.get(`${BASE}${match[1]}`);
    expect(assetRes.status()).toBe(200);
    const cc = assetRes.headers()["cache-control"] ?? "";
    expect(cc).toContain("immutable");
  });

  test("unknown webapp route falls back to index.html", async ({ request }) => {
    const res = await request.get(`${BASE}/webapp/some/unknown/route`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain("<div id=\"root\">");
  });
});
