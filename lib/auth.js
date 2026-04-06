import { createHmac, timingSafeEqual } from "crypto";
import { getLogger } from "./logger.js";

const SESSION_COOKIE_NAME = "ikiru_dashboard_session";
import { SESSION_TTL_SECONDS } from "./config.js";

const logger = getLogger({ scope: "auth" });

function toBase64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input) {
  const normalized = String(input).replace(/-/g, "+").replace(/_/g, "/");
  const padding =
    normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function signValue(value, secret) {
  return toBase64Url(createHmac("sha256", secret).update(value).digest());
}

function getCookieMap(req) {
  const raw = req.headers.cookie ?? "";
  const map = new Map();

  for (const pair of raw.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (!key) continue;
    map.set(key, decodeURIComponent(rest.join("=") || ""));
  }

  return map;
}

function getSessionSecret() {
  const secret =
    process.env.DASHBOARD_SESSION_SECRET || process.env.CRON_SECRET || "";
  if (!secret) {
    logger.warn("No session secret configured");
  }
  return secret;
}

function getCronSecret() {
  return String(process.env.CRON_SECRET || "");
}

function getDashboardLoginWindowSeconds() {
  return Math.max(
    60,
    Number(process.env.DASHBOARD_LOGIN_WINDOW_SECONDS || 10 * 60),
  );
}

function getDashboardLoginMaxAttempts() {
  return Math.max(1, Number(process.env.DASHBOARD_LOGIN_MAX_ATTEMPTS || 5));
}

function getDashboardPassword() {
  // Backward compatibility: support common typo in env name.
  return String(
    process.env.DASHBOARD_PASSWORD ?? process.env.DASHBORD_PASSWORD ?? "",
  ).trim();
}

function getSecureCookieFlag(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  return proto === "https";
}

function constantTimeEqual(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function getClientAddress(req) {
  const forwarded = req?.headers?.["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return String(
    req?.headers?.["x-real-ip"] || req?.socket?.remoteAddress || "unknown",
  );
}

function getDashboardLoginThrottleKey(req) {
  return `auth:dashboard:login:${getClientAddress(req) || "unknown"}:count`;
}

function buildThrottleSnapshot(count = 0, retryAfterSec = 0) {
  if (
    !Number.isFinite(count) ||
    count <= 0 ||
    !Number.isFinite(retryAfterSec) ||
    retryAfterSec <= 0
  ) {
    return {
      count: 0,
      limited: false,
      retryAfterSec: 0,
    };
  }

  return {
    count,
    limited: count >= getDashboardLoginMaxAttempts(),
    retryAfterSec: Math.max(1, Math.ceil(retryAfterSec)),
  };
}

export function validateDashboardPassword(password) {
  const expected = getDashboardPassword();
  const provided = String(password ?? "").trim();
  if (!expected) return false;
  return constantTimeEqual(provided, expected);
}

export function isDashboardPasswordConfigured() {
  return Boolean(getDashboardPassword());
}

export async function readDashboardLoginThrottle(
  redis,
  req,
  nowMs = Date.now(),
) {
  if (!redis) return buildThrottleSnapshot(null, nowMs);
  const key = getDashboardLoginThrottleKey(req);

  if (typeof redis.ttl === "function") {
    const [countRaw, ttlRaw] = await Promise.all([
      redis.get(key).catch(() => null),
      redis.ttl(key).catch(() => -2),
    ]);
    return buildThrottleSnapshot(Number(countRaw), Number(ttlRaw));
  }

  const state = await redis.get(key).catch((err) => {
    console.error("[auth] Failed to read throttle state:", err.message);
    return null;
  });
  if (!state || typeof state !== "object")
    return buildThrottleSnapshot(null, nowMs);
  const count = Number(state.count);
  const expiresAt = Number(state.expiresAt);
  const retryAfterSec = Number.isFinite(expiresAt)
    ? Math.ceil((expiresAt - nowMs) / 1000)
    : 0;
  return buildThrottleSnapshot(count, retryAfterSec);
}

export async function registerDashboardLoginFailure(
  redis,
  req,
  nowMs = Date.now(),
) {
  if (!redis) {
    return {
      count: 1,
      limited: false,
      retryAfterSec: getDashboardLoginWindowSeconds(),
    };
  }

  const key = getDashboardLoginThrottleKey(req);
  const windowSec = getDashboardLoginWindowSeconds();

  if (typeof redis.incr === "function" && typeof redis.ttl === "function") {
    const count = Number(
      await redis.incr(key).catch((err) => {
        console.error("[auth] Failed to increment throttle:", err.message);
        return 1;
      }),
    );
    let ttlSec = Number(
      await redis.ttl(key).catch((err) => {
        console.error("[auth] Failed to get throttle TTL:", err.message);
        return -2;
      }),
    );

    if (count === 1 || ttlSec <= 0) {
      await redis.expire(key, windowSec).catch((err) => {
        console.error("[auth] Failed to set throttle expiry:", err.message);
      });
      ttlSec = windowSec;
    }

    return buildThrottleSnapshot(count, ttlSec);
  }

  const current = await redis.get(key).catch((err) => {
    console.error("[auth] Failed to read throttle count:", err.message);
    return null;
  });
  const currentCount = Number(current?.count);
  const expiresAt = Number.isFinite(Number(current?.expiresAt))
    ? Number(current.expiresAt)
    : nowMs + windowSec * 1000;
  const next = {
    count:
      Number.isFinite(currentCount) && expiresAt > nowMs ? currentCount + 1 : 1,
    expiresAt: expiresAt > nowMs ? expiresAt : nowMs + windowSec * 1000,
  };
  const ttlSec = Math.max(1, Math.ceil((next.expiresAt - nowMs) / 1000));
  await redis.set(key, next, { ex: ttlSec }).catch((err) => {
    console.error("[auth] Failed to write throttle state:", err.message);
  });
  return buildThrottleSnapshot(next.count, ttlSec);
}

export async function clearDashboardLoginThrottle(redis, req) {
  if (!redis) return;
  await redis.del(getDashboardLoginThrottleKey(req)).catch((err) => {
    console.error("[auth] Failed to clear throttle:", err.message);
  });
}

export function createDashboardSessionToken() {
  const secret = getSessionSecret();
  if (!secret) return null;

  const payload = JSON.stringify({
    exp: Date.now() + SESSION_TTL_SECONDS * 1000,
  });
  const encoded = toBase64Url(payload);
  const signature = signValue(encoded, secret);
  return `${encoded}.${signature}`;
}

export function isDashboardSessionAuthorized(req) {
  const secret = getSessionSecret();
  if (!secret) {
    logger.warn("Session authorization failed: no secret configured");
    return false;
  }

  const token = getCookieMap(req).get(SESSION_COOKIE_NAME);
  if (!token || !token.includes(".")) {
    logger.debug("Session authorization failed: invalid token format");
    return false;
  }

  const [encoded, providedSig] = token.split(".", 2);
  const expectedSig = signValue(encoded, secret);
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

export function isMonitorAuthorized(req) {
  const secret = getCronSecret();
  const provided = req.headers.authorization ?? "";

  if (secret) {
    const expected = `Bearer ${secret}`;
    if (constantTimeEqual(provided, expected)) return true;
  }

  return isDashboardSessionAuthorized(req);
}

export function getSessionCookieHeader(req, token) {
  const secure = getSecureCookieFlag(req) ? " Secure;" : "";
  const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS};${secure}`;
  logger.debug(
    { cookiePreview: cookie.substring(0, 50) },
    "Setting session cookie",
  );
  return cookie;
}

export function getClearSessionCookieHeader(req) {
  const secure = getSecureCookieFlag(req) ? " Secure;" : "";
  const cookie = `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0;${secure}`;
  logger.debug("Clearing session cookie");
  return cookie;
}

/**
 * Validasi Authorization header menggunakan timing-safe comparison
 * untuk mencegah timing attack pada secret comparison.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {boolean}
 */
export function isCronAuthorized(req) {
  const secret = getCronSecret();
  const provided = req.headers.authorization ?? "";

  if (secret) {
    const expected = `Bearer ${secret}`;
    if (constantTimeEqual(provided, expected)) return true;
  }

  return (
    process.env.ALLOW_DASHBOARD_CRON === "true" &&
    isDashboardSessionAuthorized(req)
  );
}
