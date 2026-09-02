/**
 * Utility functions for button and filter styling
 */
import { cn } from "@/lib/utils";

export function filterButtonClass(
  active: boolean,
  variant: "pill" | "tab" = "pill"
): string {
  if (variant === "tab") {
    return cn(
      "px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer",
      active
        ? "text-white border-white"
        : "text-white/50 border-transparent hover:text-white hover:border-white/20"
    );
  }

  // pill variant (default)
  return cn(
    "px-3 py-1.5 text-xs font-medium rounded-full transition-colors cursor-pointer",
    active
      ? "bg-white text-black"
      : "bg-white/5 border border-white/10 text-white/70 hover:text-white hover:border-white/20"
  );
}

export function sourceBadgeClass(source: string): string {
  const s = source.toLowerCase();
  if (s === "shinigami")
    return "bg-red-500/15 text-red-400 border border-red-500/20";
  if (s === "ikiru")
    return "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20";
  if (s === "voratoon")
    return "bg-orange-500/15 text-orange-400 border border-orange-500/20";
  return "bg-white/10 text-white/80 border border-white/10";
}

export function sourceChipClass(source: string): string {
  const s = source.toLowerCase();
  if (s === "shinigami") return "bg-red-500/15 text-red-400";
  if (s === "ikiru") return "bg-green-500/15 text-green-400";
  if (s === "voratoon") return "bg-orange-500/15 text-orange-400";
  return "bg-white/10 text-white/80";
}

// Canonical status / severity colors (single source of truth).
// Use these instead of hardcoding hex in components.
export const STATUS_COLORS: Record<string, string> = {
  healthy: "#22c55e",
  degraded: "#f59e0b",
  down: "#ef4444",
};
