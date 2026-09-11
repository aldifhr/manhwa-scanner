import path from "path";
import type { NextConfig } from "next";

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
      { protocol: "https", hostname: "assets.shngm.id" },
      { protocol: "https", hostname: "*.shngm.id" },
      { protocol: "https", hostname: "shinigami.asia" },
      { protocol: "https", hostname: "*.shinigami.asia" },
    ],
  },

  async rewrites() {
    return [
      // Vercel → scanner proxy for API that lives on VPS (not on Vercel)
      { source: "/api/v1/failed-dispatches/:path*", destination: "https://scanner.aldifhr.fun/api/v1/failed-dispatches/:path*" },
      { source: "/api/v1/failed-dispatches", destination: "https://scanner.aldifhr.fun/api/v1/failed-dispatches" },
      { source: "/api/v1/logs/:path*", destination: "https://scanner.aldifhr.fun/api/v1/logs/:path*" },
      { source: "/api/v1/queue/:path*", destination: "https://scanner.aldifhr.fun/api/v1/queue/:path*" },
      { source: "/api/v1/queue", destination: "https://scanner.aldifhr.fun/api/v1/queue" },
      { source: "/api/v1/health/detailed", destination: "https://scanner.aldifhr.fun/api/v1/health/detailed" },
      { source: "/api/v1/health/refresh-voratoon", destination: "https://scanner.aldifhr.fun/api/v1/health/refresh-voratoon" },
      { source: "/api/v1/auth/:path*", destination: "https://scanner.aldifhr.fun/api/v1/auth/:path*" },
      { source: "/api/v1/auth", destination: "https://scanner.aldifhr.fun/api/v1/auth" },
      { source: "/api/v1/continue-reading/:path*", destination: "https://scanner.aldifhr.fun/api/v1/continue-reading/:path*" },
      { source: "/api/v1/reader/badge-counts", destination: "https://scanner.aldifhr.fun/api/v1/reader/badge-counts" },
      { source: "/api/v1/catalog/badge-counts", destination: "https://scanner.aldifhr.fun/api/v1/catalog/badge-counts" },
      // Legacy compat — deleted duplicate route files now served via rewrites (no duplicate handler)
      { source: "/api/auth/:path*", destination: "/api/v1/auth/:path*" },
      {
        source: "/api/excluded-titles/:path*",
        destination: "/api/v1/excluded-titles/:path*",
      },
      {
        source: "/api/excluded-titles",
        destination: "/api/v1/excluded-titles",
      },
      {
        source: "/api/v1/dashboard-snapshot",
        destination: "/api/v1/dashboard/snapshot",
      },
      {
        source: "/api/v1/reader/rss/:path*",
        destination: "/api/v1/rss/:path*",
      },
      { source: "/api/v1/reader/rss", destination: "/api/v1/rss" },
      // Explicit legacy -> canonical v1 mappings
      { source: "/api/reader/stats", destination: "/api/v1/stats" },
      { source: "/api/reader/queue", destination: "/api/v1/queue" },
      {
        source: "/api/reader/dashboard",
        destination: "/api/v1/dashboard/snapshot",
      },
      {
        source: "/api/reader/catalog/resolve",
        destination: "/api/v1/catalog/resolve",
      },
      {
        source: "/api/reader/cron/status",
        destination: "/api/v1/cron/status",
      },
      {
        source: "/api/reader/activity/heatmap",
        destination: "/api/v1/analytics/engagement",
      },
      { source: "/api/reader/cover-img", destination: "/api/v1/reader/cover" },
      // Catch-all for remaining /api/reader/* -> /api/v1/reader/*
      { source: "/api/reader/:path*", destination: "/api/v1/reader/:path*" },
    ];
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
      // CSP is set by middleware (proxy.ts); other headers kept here for static/non-matched routes
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https: blob:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://scanner.aldifhr.fun https://manhwa.aldifhr.fun https://fe.aldifhr.fun https://assets.shngm.id https://*.shngm.id https://*.shinigami.asia https://shinigami.asia https://*.ikiru.wtf https://ikiru.wtf https://*.voratoon.id https://voratoon.com https://imgkc1.my.id https://minio.imgkc1.my.id https://cvr.voratoon.id https: wss: ws: blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
