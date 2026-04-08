import {
  clearDashboardLoginThrottle,
  createDashboardSessionToken,
  getClearSessionCookieHeader,
  getSessionCookieHeader,
  isDashboardPasswordConfigured,
  isDashboardSessionAuthorized,
  readDashboardLoginThrottle,
  registerDashboardLoginFailure,
  validateDashboardPassword,
} from "../lib/auth.js";
import { redis } from "../lib/redis.js";
import {
  createErrorResponse,
  createSuccessResponse,
} from "../lib/api/response.js";

const METHOD_MAP = { login: "POST", logout: "POST", status: "GET" };

async function readRawBody(req) {
  if (!req || !req.readable) return "";
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const result = Buffer.concat(chunks).toString("utf8");

  // Warn if body is empty but Content-Type suggests JSON (may be consumed by middleware)
  const contentType = req.headers?.["content-type"] || "";
  if (!result && contentType.includes("application/json")) {
    console.warn("[auth] Raw body empty despite application/json Content-Type (possibly consumed by middleware)");
  }

  return result;
}

async function readPassword(req) {
  const body = req.body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      return String(parsed?.password ?? "");
    } catch {
      return "";
    }
  }

  if (body && typeof body === "object") {
    return String(body.password ?? "");
  }

  const raw = await readRawBody(req);
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return String(parsed?.password ?? "");
  } catch {
    return "";
  }
}

async function handleLogin(req, res) {
  if (!isDashboardPasswordConfigured()) {
    return res.status(500).json(createErrorResponse("SERVER_ERROR", "DASHBOARD_PASSWORD belum diset di server"));
  }

  const throttle = await readDashboardLoginThrottle(redis, req);
  if (throttle.limited) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", String(throttle.retryAfterSec));
    return res.status(429).json(createErrorResponse("RATE_LIMITED", `Terlalu banyak percobaan. Coba lagi dalam ${throttle.retryAfterSec} detik.`));
  }

  const password = (await readPassword(req)).trim();
  if (!password) {
    return res.status(400).json(createErrorResponse("INVALID_INPUT", "Password tidak boleh kosong"));
  }

  if (!validateDashboardPassword(password)) {
    const failed = await registerDashboardLoginFailure(redis, req);
    res.setHeader("Cache-Control", "no-store");
    if (failed.limited) {
      res.setHeader("Retry-After", String(failed.retryAfterSec));
      return res.status(429).json(createErrorResponse("RATE_LIMITED", `Terlalu banyak percobaan. Coba lagi dalam ${failed.retryAfterSec} detik.`));
    }
    return res.status(401).json(createErrorResponse("UNAUTHORIZED", "Password salah"));
  }

  const token = createDashboardSessionToken();
  if (!token) return res.status(500).json(createErrorResponse("SERVER_ERROR", "Session secret belum diset"));

  await clearDashboardLoginThrottle(redis, req);
  res.setHeader("Set-Cookie", getSessionCookieHeader(req, token));
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(createSuccessResponse({ ok: true }));
}

function handleLogout(req, res) {
  const wasAuthenticated = isDashboardSessionAuthorized(req);
  res.setHeader("Set-Cookie", getClearSessionCookieHeader(req));
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(createSuccessResponse({ ok: true, wasAuthenticated }));
}

function handleStatus(req, res) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(createSuccessResponse({ authenticated: isDashboardSessionAuthorized(req) }));
}

export default async function handler(req, res) {
  const action = req.query.action || "status";
  const expectedMethod = METHOD_MAP[action];

  if (!expectedMethod) {
    return res.status(400).json(createErrorResponse("INVALID_ACTION", "Unknown action"));
  }

  if (req.method !== expectedMethod) {
    return res.status(405).json(createErrorResponse("METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  if (action === "login") return handleLogin(req, res);
  if (action === "logout") return handleLogout(req, res);
  if (action === "status") return handleStatus(req, res);

  return res.status(400).json(createErrorResponse("INVALID_ACTION", "Unknown action"));
}
