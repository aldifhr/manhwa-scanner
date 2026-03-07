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

export function validateDashboardPassword(password) {
  const expected = getDashboardPassword();
  const provided = String(password ?? "").trim();
  if (!expected) return false;
  return constantTimeEqual(provided, expected);
}

export function isDashboardPasswordConfigured() {
  return Boolean(getDashboardPassword());
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
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.authorization ?? "";

  if (secret) {
    const expected = `Bearer ${secret}`;
    if (constantTimeEqual(provided, expected)) return true;
  }

  return isDashboardSessionAuthorized(req);
}
