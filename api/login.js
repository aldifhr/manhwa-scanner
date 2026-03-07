import {
  createDashboardSessionToken,
  getSessionCookieHeader,
  validateDashboardPassword,
} from "../lib/auth.js";

function readPassword(req) {
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

  return "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const password = readPassword(req).trim();
  if (!validateDashboardPassword(password)) {
    return res.status(401).json({ error: "Password salah" });
  }

  const token = createDashboardSessionToken();
  if (!token) {
    return res.status(500).json({ error: "Session secret belum diset" });
  }

  res.setHeader("Set-Cookie", getSessionCookieHeader(req, token));
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ok: true });
}
