import { getClearSessionCookieHeader } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Set-Cookie", getClearSessionCookieHeader(req));
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ok: true });
}
