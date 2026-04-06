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

async function readRawBody(req) {
  if (!req || !req.readable) return "";
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
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
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!isDashboardPasswordConfigured()) return res.status(500).json({ error: "DASHBOARD_PASSWORD belum diset di server" });

  const throttle = await readDashboardLoginThrottle(redis, req);
  if (throttle.limited) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", String(throttle.retryAfterSec));
    return res.status(429).json({ error: `Terlalu banyak percobaan. Coba lagi dalam ${throttle.retryAfterSec} detik.` });
  }

  const password = (await readPassword(req)).trim();
  if (!validateDashboardPassword(password)) {
    const failed = await registerDashboardLoginFailure(redis, req);
    res.setHeader("Cache-Control", "no-store");
    if (failed.limited) {
      res.setHeader("Retry-After", String(failed.retryAfterSec));
      return res.status(429).json({ error: `Terlalu banyak percobaan. Coba lagi dalam ${failed.retryAfterSec} detik.` });
    }
    return res.status(401).json({ error: "Password salah" });
  }

  const token = createDashboardSessionToken();
  if (!token) return res.status(500).json({ error: "Session secret belum diset" });

  await clearDashboardLoginThrottle(redis, req);
  res.setHeader("Set-Cookie", getSessionCookieHeader(req, token));
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ok: true });
}

function handleLogout(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Set-Cookie", getClearSessionCookieHeader(req));
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ok: true });
}

function handleStatus(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ authenticated: isDashboardSessionAuthorized(req) });
}

export default async function handler(req, res) {
  const action = req.query.action || "status";

  if (action === "login") return handleLogin(req, res);
  if (action === "logout") return handleLogout(req, res);
  if (action === "status") return handleStatus(req, res);

  return res.status(400).json({ error: "Unknown action" });
}
