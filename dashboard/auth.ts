import { SignJWT, jwtVerify } from "jose";
import { createHmac, createHash, timingSafeEqual } from "crypto";
import { CONFIG } from "../config.ts";

// Derive JWT secret from bot token (separate domain from Telegram auth)
// Use JWT_SECRET env var if provided, otherwise HMAC-derive from bot token
const jwtSecret = process.env.JWT_SECRET
  ? new TextEncoder().encode(process.env.JWT_SECRET)
  : new TextEncoder().encode(
      createHash("sha256").update("jwt:" + CONFIG.TELEGRAM_BOT_TOKEN).digest("hex"),
    );

export interface AuthPayload {
  id: number;
  first_name: string;
  username?: string;
  photo_url?: string;
}

export async function signJwt(payload: AuthPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(jwtSecret);
}

export async function verifyJwt(token: string): Promise<AuthPayload | null> {
  try {
    const { payload } = await jwtVerify(token, jwtSecret);
    return payload as unknown as AuthPayload;
  } catch {
    return null;
  }
}

/**
 * Verify Telegram Mini App initData string.
 * Algorithm: HMAC-SHA256(data_check_string, HMAC-SHA256("WebAppData", bot_token))
 */
export function verifyWebAppInitData(initData: string): AuthPayload | null {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  // Check auth_date freshness (1 hour for Mini App)
  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 3600) return null;

  // Build data-check-string: sorted key=value pairs (excluding hash)
  params.delete("hash");
  const checkString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  // Secret key = HMAC-SHA256("WebAppData", bot_token)
  const secretKey = createHmac("sha256", "WebAppData").update(CONFIG.TELEGRAM_BOT_TOKEN).digest();
  const computed = createHmac("sha256", secretKey).update(checkString).digest("hex");

  try {
    if (!timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(hash, "hex"))) return null;
  } catch {
    return null;
  }

  const userStr = params.get("user");
  if (!userStr) return null;
  try {
    const user = JSON.parse(userStr);
    return { id: user.id, first_name: user.first_name, username: user.username, photo_url: user.photo_url };
  } catch {
    return null;
  }
}

export function verifyTelegramLogin(data: Record<string, string>): boolean {
  const { hash, ...rest } = data;
  if (!hash) return false;

  // Check auth_date is within 24 hours
  const authDate = Number(rest.auth_date);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return false;

  // Build data-check-string: sorted key=value pairs joined by \n
  const checkString = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("\n");

  // Secret key = SHA-256(bot_token)
  const secretKey = createHash("sha256").update(CONFIG.TELEGRAM_BOT_TOKEN).digest();
  const hmac = createHmac("sha256", secretKey).update(checkString).digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    return timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(hash, "hex"));
  } catch {
    return false; // different lengths
  }
}
