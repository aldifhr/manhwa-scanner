/**
 * Utility functions for button and filter styling
 */
import { cn } from "$lib/utils";

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

  // pill variant (default) — white accent when active
  return cn(
    "px-3 py-1.5 text-xs font-medium rounded-full transition-colors cursor-pointer border shrink-0 whitespace-nowrap min-h-0 min-w-0",
    active
      ? "bg-white text-black border-transparent"
      : "bg-white/[0.06] border-white/[0.08] text-white/60 hover:text-white hover:border-white/20 hover:bg-white/10"
  );
}

const SOURCE_COLOR: Record<string, string> = {
  shinigami: "red",
  ikiru: "emerald",
  voratoon: "orange",
};
const SOURCE_MAP: Record<string, { badge: string; chip: string }> = {
  shinigami: {
    badge: "bg-red-500/15 text-red-400 border border-red-500/20",
    chip: "bg-red-500/15 text-red-400",
  },
  ikiru: {
    badge: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20",
    chip: "bg-green-500/15 text-green-400",
  },
  voratoon: {
    badge: "bg-orange-500/15 text-orange-400 border border-orange-500/20",
    chip: "bg-orange-500/15 text-orange-400",
  },
};
export function sourceBadgeClass(source: string): string {
  return (
    SOURCE_MAP[source.toLowerCase()]?.badge ??
    "bg-white/[0.06] text-white/70 border border-white/[0.08]"
  );
}
export function sourceChipClass(source: string): string {
  return SOURCE_MAP[source.toLowerCase()]?.chip ?? "bg-white/[0.06] text-white/70";
}

// Canonical status / severity colors (single source of truth).
// Use these instead of hardcoding hex in components.
export const STATUS_COLORS: Record<string, string> = {
  healthy: "#22c55e",
  degraded: "#f59e0b",
  down: "#ef4444",
};
