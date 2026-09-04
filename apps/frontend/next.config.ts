import path from "path";
import type { NextConfig } from "next";
import { getCsp } from "./lib/security/headers";

const csp = getCsp(process.env.NODE_ENV === "development");

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
  async rewrites() {
    return [
      // Generic fallback: any /api/reader/* without explicit mapping goes to /api/v1/reader/*
      // Must be last in the list so explicit rewrites win.
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
      {
        source: "/api/reader/auth-refresh",
        destination: "/api/v1/auth/login",
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
              "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
