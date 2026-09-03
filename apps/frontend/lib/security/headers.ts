/**
 * Single source of truth for security headers / CSP.
 * Imported by `middleware.ts` (edge) and `next.config.ts` (routing layer).
 * Keeps style-src / font-src / script-src in sync across both layers.
 */

export function getCsp(isDev: boolean): string {
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";
  return [
    "default-src 'self'",
    scriptSrc, // Next.js App Router needs inline RSC hydration; dev needs unsafe-eval for HMR
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: https:",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function getSecurityHeaders(isDev: boolean): Record<string, string> {
  return {
    "Content-Security-Policy": getCsp(isDev),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

// Static export for middleware / next.config that don't need dynamic isDev at import time.
// Middleware will call getSecurityHeaders(process.env.NODE_ENV === 'development') at runtime.
export const SECURITY_HEADERS: Record<string, string> =
  getSecurityHeaders(false);
