/**
 * Dashboard session management
 */

import { getLogger } from "../logger.js";
import { SESSION_TTL_SECONDS } from "../config.js";
import { toBase64Url, fromBase64Url, signValue, constantTimeEqual } from "./crypto.js";
import { getCookieMap } from "./http.js";
import { getSessionSecret, SESSION_COOKIE_NAME } from "./config.js";
import type { RequestLike } from "./http.js";

const logger = getLogger({ scope: "auth:session" });

// Determine runtime environment
const IS_EDGE = typeof process !== "undefined" && process.env.NEXT_RUNTIME === "edge";
const IS_NODE = !IS_EDGE;

/**
 * Create a new dashboard session token
 */
export async function createDashboardSessionToken(): Promise<string | null> {
  const secret = getSessionSecret();
  if (!secret) return null;

  let randomValues = new Uint8Array(16);
  if (IS_NODE) {
    try {
      const { randomBytes } = await import("crypto");
      randomValues = new Uint8Array(randomBytes(16));
    } catch {
      if (typeof crypto !== "undefined") crypto.getRandomValues(randomValues);
    }
  } else {
    crypto.getRandomValues(randomValues);
  }

  const randomHex = Array.from(randomValues)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const payload = JSON.stringify({
    exp: Date.now() + SESSION_TTL_SECONDS * 1000,
    rnd: randomHex,
  });

  const encoded = toBase64Url(payload);
  const signature = await signValue(encoded, secret);
  return `${encoded}.${signature}`;
}

/**
 * Validate dashboard session from request
 */
export async function isDashboardSessionAuthorized(req: RequestLike): Promise<boolean> {
  const secret = getSessionSecret();
  if (!secret) {
    logger.warn("Session authorization failed: no secret configured");
    return false;
  }

  const token = getCookieMap(req).get(SESSION_COOKIE_NAME);
  if (!token || !token.includes(".")) {
    return false;
  }

  const [encoded, providedSig] = token.split(".", 2);
  const expectedSig = await signValue(encoded, secret);
  const sigMatch = constantTimeEqual(providedSig, expectedSig);

  if (!sigMatch) {
    logger.warn("Session authorization failed: signature mismatch");
    return false;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encoded));
    const exp = Number(payload?.exp);
    const isValid = Number.isFinite(exp) && Date.now() < exp;
    if (!isValid) {
      logger.debug("Session authorization failed: token expired");
    }
    return isValid;
  } catch {
    logger.warn("Session authorization failed: payload parse error");
    return false;
  }
}

/**
 * Get Set-Cookie header for session
 */
export async function getSessionCookieHeader(
  req: RequestLike,
  token: string,
): Promise<string> {
  const proto = String(
    (req as RequestLike & { headers: Record<string, string> }).headers?.["x-forwarded-proto"] || "",
  ).toLowerCase();
  const secure = proto === "https" ? " Secure;" : "";
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS};${secure}`;
}

/**
 * Get Set-Cookie header to clear session
 */
export async function getClearSessionCookieHeader(req: RequestLike): Promise<string> {
  const proto = String(
    (req as RequestLike & { headers: Record<string, string> }).headers?.["x-forwarded-proto"] || "",
  ).toLowerCase();
  const secure = proto === "https" ? " Secure;" : "";
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0;${secure}`;
}
