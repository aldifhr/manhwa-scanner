import { createHmac, timingSafeEqual } from "crypto";

const SESSION_COOKIE_NAME = "ikiru_dashboard_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 jam

function toBase64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input) {
  const normalized = String(input).replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
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
  return process.env.DASHBOARD_SESSION_SECRET || process.env.CRON_SECRET || "";
}

function getCronSecret() {
  return String(process.env.CRON_SECRET || "");
}

function getDashboardLoginWindowSeconds() {
  return Math.max(60, Number(process.env.DASHBOARD_LOGIN_WINDOW_SECONDS || 10 * 60));
}

function getDashboardLoginMaxAttempts() {
  return Math.max(1, Number(process.env.DASHBOARD_LOGIN_MAX_ATTEMPTS || 5));
}

function getDashboardPassword() {
  // Backward compatibility: support common typo in env name.
  return String(process.env.DASHBOARD_PASSWORD ?? process.env.DASHBORD_PASSWORD ?? "").trim();
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
  return String(req?.headers?.["x-real-ip"] || req?.socket?.remoteAddress || "unknown");
}

function getDashboardLoginThrottleKey(req) {
  return `auth:dashboard:login:${getClientAddress(req) || "unknown"}`;
}

function normalizeLoginThrottleState(value, nowMs = Date.now()) {
  if (!value || typeof value !== "object") return null;
  const count = Number(value.count);
  const expiresAt = Number(value.expiresAt);
  if (!Number.isFinite(count) || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= nowMs) return null;
  return { count, expiresAt };
}

function buildThrottleSnapshot(state, nowMs = Date.now()) {
  const active = normalizeLoginThrottleState(state, nowMs);
  if (!active) {
    return {
      count: 0,
      limited: false,
      retryAfterSec: 0,
    };
  }

  return {
    count: active.count,
    limited: active.count >= getDashboardLoginMaxAttempts(),
    retryAfterSec: Math.max(1, Math.ceil((active.expiresAt - nowMs) / 1000)),
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

export async function readDashboardLoginThrottle(redis, req, nowMs = Date.now()) {
  if (!redis) return buildThrottleSnapshot(null, nowMs);
  const state = normalizeLoginThrottleState(
    await redis.get(getDashboardLoginThrottleKey(req)).catch(() => null),
    nowMs,
  );
  return buildThrottleSnapshot(state, nowMs);
}

export async function registerDashboardLoginFailure(redis, req, nowMs = Date.now()) {
  if (!redis) {
    return {
      count: 1,
      limited: false,
      retryAfterSec: getDashboardLoginWindowSeconds(),
    };
  }

  const key = getDashboardLoginThrottleKey(req);
  const current = normalizeLoginThrottleState(await redis.get(key).catch(() => null), nowMs);
  const next = {
    count: (current?.count || 0) + 1,
    expiresAt: current?.expiresAt || nowMs + getDashboardLoginWindowSeconds() * 1000,
  };
  const ttlSec = Math.max(1, Math.ceil((next.expiresAt - nowMs) / 1000));
  await redis.set(key, next, { ex: ttlSec }).catch(() => {});
  return buildThrottleSnapshot(next, nowMs);
}

export async function clearDashboardLoginThrottle(redis, req) {
  if (!redis) return;
  await redis.del(getDashboardLoginThrottleKey(req)).catch(() => {});
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
  if (!secret) return false;

  const token = getCookieMap(req).get(SESSION_COOKIE_NAME);
  if (!token || !token.includes(".")) return false;

  const [encoded, providedSig] = token.split(".", 2);
  const expectedSig = signValue(encoded, secret);
  if (!constantTimeEqual(providedSig, expectedSig)) return false;

  try {
    const payload = JSON.parse(fromBase64Url(encoded));
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp)) return false;
    return Date.now() < exp;
  } catch {
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
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS};${secure}`;
}

export function getClearSessionCookieHeader(req) {
  const secure = getSecureCookieFlag(req) ? " Secure;" : "";
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0;${secure}`;
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

  return process.env.ALLOW_DASHBOARD_CRON === "true" && isDashboardSessionAuthorized(req);
}


