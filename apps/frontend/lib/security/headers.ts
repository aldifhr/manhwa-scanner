/**
 * Single source of truth for security headers / CSP.
 * Imported by `middleware.ts` (edge) and `next.config.ts` (routing layer).
 * Keeps style-src / font-src / script-src in sync across both layers.
 */

export function getCsp(isDev: boolean): string {
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";
  const connectExtra = isDev ? " ws://localhost:* wss://localhost:* http://localhost:*" : "";
  return [
    "default-src 'self'",
    scriptSrc, // Next.js App Router needs inline RSC hydration; dev needs unsafe-eval for HMR
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: https: blob:",
    "font-src 'self' https://fonts.gstatic.com",
    // connect-src: 'self' + scanner + image CDNs (sw.js fetch() counts as connect-src, not img-src)
    `connect-src 'self' https://scanner.aldifhr.fun https://manhwa.aldifhr.fun https://fe.aldifhr.fun https://assets.shngm.id https://*.shngm.id https://*.shinigami.asia https://shinigami.asia https://*.ikiru.wtf https://ikiru.wtf https://*.voratoon.id https://voratoon.com https://imgkc1.my.id https://minio.imgkc1.my.id https://cvr.voratoon.id https:${connectExtra} wss: ws: blob:`,
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
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=()",
  };
}

// Static export for middleware / next.config that don't need dynamic isDev at import time.
// Middleware will call getSecurityHeaders(process.env.NODE_ENV === 'development') at runtime.
export const SECURITY_HEADERS: Record<string, string> =
  getSecurityHeaders(false);
