/**
 * Source metadata and labeling for Discord embeds
 */

import { env } from "../config/env.js";

export interface SourceMeta {
  label: string;
  badge: string;
  color: number;
  siteUrl: string;
}

export const SOURCE_META: Record<string, SourceMeta> = {
  ikiru: {
    label: "Ikiru",
    badge: "IKIRU",
    color: 0x22c55e,
    siteUrl: env.IKIRU_BASE_URL,
  },
  shinigami: {
    label: "Shinigami",
    badge: "SHINIGAMI",
    color: 0xef4444,
    siteUrl:
      env.SHINIGAMI_BASE_URL ||
      env.SECONDARY_PUBLIC_BASE ||
      "https://f.shinigami.asia/",
  },
};

export const statusBar: Record<string, string> = {
  Ongoing: "Ongoing",
  Completed: "Completed",
  Hiatus: "Hiatus",
  Unknown: "Unknown",
};

/**
 * Get normalized status text (case-insensitive)
 */
export function getNormalizedStatus(status: string | null | undefined): string {
  if (!status) return statusBar.Unknown;
  const s = String(status).trim().toLowerCase();
  
  if (s === "ongoing") return statusBar.Ongoing;
  if (s === "completed" || s === "tamat") return statusBar.Completed;
  if (s === "hiatus") return statusBar.Hiatus;
  
  // Try to find match in statusBar by key (case-insensitive)
  const entry = Object.entries(statusBar).find(
    ([key]) => key.toLowerCase() === s
  );
  
  return entry ? entry[1] : statusBar.Unknown;
}

/**
 * Normalize source string to label
 */
export function normalizeSourceLabel(source: string | null | undefined): string {
  const s = String(source || "").toLowerCase();
  if (s === "shinigami") {
    return "Shinigami";
  }
  return "Ikiru";
}

/**
 * Get source metadata
 */
export function sourceMeta(source: string | null | undefined): SourceMeta {
  const s = String(source || "").toLowerCase();
  if (s === "shinigami") {
    return SOURCE_META.shinigami;
  }
  return SOURCE_META.ikiru;
}
