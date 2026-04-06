import { SignJWT, jwtVerify } from "jose";
import { createHmac, createHash } from "crypto";
import { CONFIG } from "../config.ts";

const secret = new TextEncoder().encode(CONFIG.TELEGRAM_BOT_TOKEN);

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
    .sign(secret);
}

export async function verifyJwt(token: string): Promise<AuthPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload as unknown as AuthPayload;
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

  return hmac === hash;
}
