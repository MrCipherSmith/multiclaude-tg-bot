/**
 * Global setup: runs ONCE before all tests (Node.js process, not a browser).
 * Generates a test JWT and writes it to .auth/token.txt.
 */
import { SignJWT } from "jose";
import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: join(resolve(__dirname), "../.env"), override: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "https://helyx.mrciphersmith.com";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TEST_USER_ID = Number(process.env.ALLOWED_USERS?.split(",")[0] ?? "446593035");
const AUTH_DIR = resolve(__dirname, ".auth");
const TOKEN_PATH = resolve(AUTH_DIR, "token.txt");

export default async function globalSetup() {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set — check .env");

  mkdirSync(AUTH_DIR, { recursive: true });

  const secret = new TextEncoder().encode(
    createHash("sha256").update("jwt:" + BOT_TOKEN).digest("hex"),
  );

  const token = await new SignJWT({ id: TEST_USER_ID, first_name: "Test", username: "test" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1d")
    .sign(secret);

  // Verify using native fetch
  const res = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Auth verification failed: ${res.status} ${body}`);
  }

  const user = await res.json() as { id: number };
  if (user.id !== TEST_USER_ID) {
    throw new Error(`Auth returned wrong user: ${user.id}`);
  }

  writeFileSync(TOKEN_PATH, token, "utf8");
  console.log(`[global-setup] test JWT generated for user #${TEST_USER_ID} → .auth/token.txt`);
}
