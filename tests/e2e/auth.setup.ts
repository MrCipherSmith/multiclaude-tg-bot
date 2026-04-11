/**
 * Auth setup: generates a test JWT using the same secret as the bot server,
 * saves it to .auth/token.txt and sets storage state with extra headers for reuse.
 *
 * The server accepts both cookie "token" and "Authorization: Bearer <token>".
 * We use Bearer in tests since Playwright APIRequestContext doesn't share browser cookies.
 */
import { test as setup, expect } from "@playwright/test";
import { SignJWT } from "jose";
import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(__dirname, "../../.env"), override: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "https://helyx.mrciphersmith.com";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TEST_USER_ID = Number(process.env.ALLOWED_USERS?.split(",")[0] ?? "446593035");
const AUTH_DIR = resolve(__dirname, "../../.auth");
const STATE_PATH = resolve(AUTH_DIR, "state.json");
export const TOKEN_PATH = resolve(AUTH_DIR, "token.txt");

async function generateTestJwt(): Promise<string> {
  const secret = new TextEncoder().encode(
    createHash("sha256").update("jwt:" + BOT_TOKEN).digest("hex"),
  );
  return new SignJWT({ id: TEST_USER_ID, first_name: "Test", username: "test" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1d")
    .sign(secret);
}

setup("authenticate", async ({ request }) => {
  mkdirSync(AUTH_DIR, { recursive: true });

  console.log("BOT_TOKEN present:", !!BOT_TOKEN, "len:", BOT_TOKEN?.length);
  const token = await generateTestJwt();
  console.log("generated token prefix:", token.slice(0, 20));

  // Save token for use in tests via process.env or fixture
  writeFileSync(TOKEN_PATH, token, "utf8");
  process.env.TEST_JWT = token;

  // Verify auth works using native fetch (Playwright request may have header issues)
  const fetchRes = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body_text = await fetchRes.text();
  console.log("auth/me status:", fetchRes.status, "body:", body_text.slice(0, 100));
  expect(fetchRes.status).toBe(200);
  const body = JSON.parse(body_text);
  expect(body.id).toBe(TEST_USER_ID);

  // Save minimal storage state (no cookies needed — tests use Bearer header)
  writeFileSync(STATE_PATH, JSON.stringify({
    cookies: [],
    origins: [{ origin: BASE_URL, localStorage: [{ name: "__test_token", value: token }] }],
  }), "utf8");

  console.log(`[auth.setup] JWT generated for user #${TEST_USER_ID}`);
});
