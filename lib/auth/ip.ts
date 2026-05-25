/**
 * Client IP address detection and validation
 */

import { getHeader } from "./http.js";
import { env } from "../config/env.js";
import type { RequestLike } from "./http.js";

/**
 * Normalize IP token from forwarded header
 */
export function normalizeIpToken(raw: string | undefined): string {
  const token = String(raw || "").trim();
  if (!token) return "";
  if (token.startsWith("[") && token.includes("]")) {
    return token.slice(1, token.indexOf("]"));
  }
  if (token.includes(":") && token.includes(".")) {
    const [host] = token.split(":");
    return host;
  }
  return token;
}

/**
 * Check if we should trust proxy headers (X-Forwarded-For, etc.)
 */
export function shouldTrustProxyHeaders(): boolean {
  if (env.TRUST_PROXY !== undefined) {
    return env.TRUST_PROXY;
  }
  return env.VERCEL;
}

/**
 * Validate IPv4 address
 */
function isValidIpv4(ip: string): boolean {
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipv4Regex.test(ip)) return false;
  const parts = ip.split(".");
  return parts.every((part) => {
    const num = parseInt(part, 10);
    return num >= 0 && num <= 255 && part === String(num);
  });
}

/**
 * Validate IPv6 address (basic check)
 */
function isValidIpv6(ip: string): boolean {
  const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  if (!ipv6Regex.test(ip)) return false;
  return ip.split(":").every((part) => part.length <= 4);
}

/**
 * Check if string is a valid IP address (IPv4 or IPv6)
 */
export function isValidIpAddress(ip: string | null | undefined): boolean {
  if (!ip || typeof ip !== "string") return false;
  return isValidIpv4(ip) || isValidIpv6(ip);
}

/**
 * Get client IP address from request
 * Respects proxy headers if TRUST_PROXY is enabled
 */
export function getClientAddress(req: RequestLike): string {
  const trustProxy = shouldTrustProxyHeaders();
  const forwarded = getHeader(req, "x-forwarded-for");

  if (trustProxy && forwarded) {
    const candidate = String(forwarded)
      .split(",")
      .map((ip) => normalizeIpToken(ip))
      .find((ip) => isValidIpAddress(ip));
    if (candidate) return candidate;
  }

  const realIp = normalizeIpToken(getHeader(req, "x-real-ip"));
  if (trustProxy && isValidIpAddress(realIp)) {
    return realIp;
  }

  // Socket remote address (if available)
  const reqWithSocket = req as RequestLike & { socket?: { remoteAddress?: string } };
  const remoteAddress = normalizeIpToken(reqWithSocket.socket?.remoteAddress);
  if (isValidIpAddress(remoteAddress)) {
    return remoteAddress;
  }

  return "unknown";
}
