"use client";
import { useMemo } from "react";
import { normalizeOrigin } from "@/lib/constants";
import type { WhitelistRouteItem } from "@/lib/types";

export function useWhitelistFilters(
  items: WhitelistRouteItem[],
  opts: {
    sourceFilter: string;
    typeFilter: string;
    originFilter: string;
    debouncedSearch: string;
    sort: "title" | "rating" | "recent";
  }
) {
  const { sourceFilter, typeFilter, originFilter, debouncedSearch, sort } =
    opts;
  return useMemo(() => {
    const out = items.filter((item) => {
      if (
        debouncedSearch &&
        !item.title.toLowerCase().includes(debouncedSearch.toLowerCase())
      )
        return false;
      if (sourceFilter !== "All" && item.source !== sourceFilter) return false;
      if (typeFilter !== "All") {
        const raw = String(item.type || "").toLowerCase().trim();
        const t = raw === "manhwa" || raw === "manhua" ? raw : "no_type";
        if (t !== typeFilter.toLowerCase()) return false;
      }
      if (
        originFilter !== "All" &&
        normalizeOrigin(item.origin) !== normalizeOrigin(originFilter)
      )
        return false;
      return true;
    });
    out.sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "rating") {
        const ra = parseFloat(String(a.rating ?? "0")) || 0;
        const rb = parseFloat(String(b.rating ?? "0")) || 0;
        return rb - ra;
      }
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
    return out;
  }, [items, sourceFilter, typeFilter, originFilter, debouncedSearch, sort]);
}
