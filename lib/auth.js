import { timingSafeEqual } from "crypto";

/**
 * Validasi Authorization header menggunakan timing-safe comparison
 * untuk mencegah timing attack pada secret comparison.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {boolean}
 */
export function isCronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const provided = req.headers.authorization ?? "";
  const expected = `Bearer ${secret}`;

  // Length check dulu — timingSafeEqual butuh buffer yang sama panjangnya
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
