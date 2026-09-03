import path from "path";
import type { NextConfig } from "next";

// Mirrors the SECURITY_HEADERS block in middleware.ts. Applied at the routing
// layer to ALL responses (including static assets) so security headers are
// never absent on any path.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`, // Next.js App Router needs inline RSC hydration; dev needs 'unsafe-eval' for HMR
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:", // voratoon presigned S3 direct + proxied covers
  "font-src 'self'",
  "connect-src 'self'", // SW fetches only same-origin (proxy/cache) URLs
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../../"),
  typescript: { ignoreBuildErrors: false },
  experimental: {
    optimizePackageImports: ["@phosphor-icons/react"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "scanner.aldifhr.fun" },
      { protocol: "https", hostname: "manhwa.aldifhr.fun" },
      { protocol: "https", hostname: "ikiru.wtf" },
      { protocol: "https", hostname: "imgkc1.my.id" },
      { protocol: "https", hostname: "minio.imgkc1.my.id" },
      { protocol: "https", hostname: "cvr.voratoon.id" },
      { protocol: "https", hostname: "voratoon.com" },
    ],
  },
  async headers() {
    return [
      {
        source: "/api/v1/reader/cover",
        headers: [
          { key: "Content-Type", value: "image/webp" },
          {
            key: "Cache-Control",
            value: "public, max-age=86400, s-maxage=86400",
          },
        ],
      },
      {
        source: "/api/v1/reader/proxy",
        headers: [
          { key: "Content-Type", value: "image/webp" },
          {
            key: "Cache-Control",
            value: "public, max-age=86400, s-maxage=86400",
          },
        ],
      },
      {
        source: "/api/v1/dispatch-history",
        headers: [
          { key: "Content-Type", value: "application/json" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        source: "/api/v1/dashboard-snapshot",
        headers: [
          { key: "Content-Type", value: "application/json" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
