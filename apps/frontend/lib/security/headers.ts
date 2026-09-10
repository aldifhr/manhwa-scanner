/**
 * Single source of truth for security headers / CSP.
 * Imported by middleware (edge) and next.config (routing layer).
 * Keeps style-src / font-src / script-src in sync across both layers.
 *
 * Nonce-based: 'unsafe-inline' is dropped entirely. Next.js 16 auto-applies
 * the nonce to inline RSC hydration scripts and all <style> blocks generated
 * by styled-jsx/Tailwind. Any inline <script> or style attribute lacking the
 * matching nonce will be blocked by the browser (correct behavior).
 */

export function getCsp(nonce: string, isDev: boolean): string {
  const scriptSrc = isDev
    ? `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}'`;
  const connectExtra = isDev ? " ws://localhost:* wss://localhost:* http://localhost:*" : "";
  return [
    "default-src 'self'",
    scriptSrc,
    `style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com`,
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

export function getSecurityHeaders(nonce: string, isDev: boolean): Record<string, string> {
  return {
    "Content-Security-Policy": getCsp(nonce, isDev),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=()",
  };
}
