"use client";

import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addExcludedTitle,
  removeExcludedTitle,
  bulkExcludeBySource,
} from "@/lib/api";
import { Reader } from "@/lib/reader";
import type { ExcludedTitleItem } from "@/lib/types";
import { queryKeys } from "@/lib/queryKeys";
import { useToast } from "@/lib/useToast";
import { MagnifyingGlass, Prohibit, Trash, Plus } from "@phosphor-icons/react";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/EmptyState";
import { Select } from "@/components/ui/Select";
import { useDebounced } from "@/lib/useDebounced";
import { decodeHtml } from "@/lib/utils";
import Link from "next/link";
import { PageShell } from "@/components/PageShell";

function SourceBadge({ source }: { source: string }) {
  const color =
    source === "ikiru"
      ? "bg-sky-500/15 text-sky-400"
      : source === "shinigami"
        ? "bg-violet-500/15 text-violet-400"
        : source === "all"
          ? "bg-amber-500/15 text-amber-400"
          : "bg-surface-hover text-text-muted";
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${color}`}>
      {source}
    </span>
  );
}

export function ExcludeListClient() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.excludedTitles,
    queryFn: () => Reader.getExcludedTitles() as Promise<ExcludedTitleItem[]>,
    staleTime: 15 * 1000,
  });

  const [searchTerm, setSearchTerm] = useState("");
  const [sourceFilter, setSourceFilter] = useState("All");
  const debouncedSearch = useDebounced(searchTerm, 300);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [bulkSource, setBulkSource] = useState("ikiru");
  const [bulkLoading, setBulkLoading] = useState(false);

  const items: ExcludedTitleItem[] = data ?? [];

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (debouncedSearch) {
        const t = (it.title || it.titleKey || "").toLowerCase();
        if (!t.includes(debouncedSearch.toLowerCase())) return false;
      }
      if (sourceFilter !== "All" && (it.source || "all") !== sourceFilter)
        return false;
      return true;
    });
  }, [items, debouncedSearch, sourceFilter]);

  const displayTitle = (it: ExcludedTitleItem) =>
    decodeHtml(it.title || it.titleKey || "Unknown title");

  // Group the visible items by source so the user sees the distinct
  // exclude lists (all / ikiru / shinigami) side by side.
  const grouped = useMemo(() => {
    const map: Record<string, ExcludedTitleItem[]> = {};
    for (const it of filtered) {
      const s = it.source || "all";
      (map[s] ??= []).push(it);
    }
    return map;
  }, [filtered]);

  const groupOrder = useMemo(() => {
    const order = ["all", "ikiru", "shinigami"];
    const present = Object.keys(grouped);
    present.sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    return present;
  }, [grouped]);

  const sources = useMemo(() => {
    const set = new Set<string>();
    items.forEach((i) => set.add(i.source || "all"));
    return [...set].sort();
  }, [items]);

  const handleRemove = async (it: ExcludedTitleItem) => {
    const key = `${it.titleKey || it.id}:${it.source || "all"}`;
    const prev =
      queryClient.getQueryData<ExcludedTitleItem[]>(queryKeys.excludedTitles) ??
      items;
    // Optimistic: hide immediately
    queryClient.setQueryData<ExcludedTitleItem[]>(
      queryKeys.excludedTitles,
      (old) =>
        (old ?? prev).filter(
          (x) =>
            !(
              (x.titleKey || x.id) === (it.titleKey || it.id) &&
              (x.source || "all") === (it.source || "all")
            )
        )
    );
    setBusyKey(key);
    try {
      const rawKey = it.titleKey || it.id || it.title || "";
      // Normalize curly quotes — backend stores straight quotes, FE display uses ’
      const title_key = rawKey
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .trim();
      if (process.env.NODE_ENV === "development") {
        console.log("[exclude delete] payload", {
          title_key,
          rawKey,
          source: it.source,
          it,
        });
      }
      if (!title_key) throw new Error("title_key missing");
      await removeExcludedTitle({
        title_key,
        source: it.source || "all",
        title: it.title ?? undefined,
      } as unknown as { title_key: string; source?: string });
      toast(`Un-excluded ${displayTitle(it)}`, {
        type: "info",
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              await addExcludedTitle({
                title_key: it.titleKey || it.id || "",
                title: it.title ?? undefined,
                source: it.source || "all",
                cover: it.cover ?? null,
                series_url: it.seriesUrl ?? null,
              });
              queryClient.invalidateQueries({
                queryKey: queryKeys.excludedTitles,
              });
              toast(`Re-excluded ${displayTitle(it)}`, { type: "success" });
            } catch {}
          },
        },
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.excludedTitles });
    } catch (err) {
      // Revert optimistic
      queryClient.setQueryData(queryKeys.excludedTitles, prev);
      toast(err instanceof Error ? err.message : "Failed to remove", {
        type: "error",
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleBulk = async () => {
    if (!bulkSource) return;
    const before =
      queryClient.getQueryData<ExcludedTitleItem[]>(queryKeys.excludedTitles) ??
      items;
    setBulkLoading(true);
    try {
      const res = await bulkExcludeBySource(bulkSource);
      queryClient.invalidateQueries({ queryKey: queryKeys.excludedTitles });
      // Fetch new list to diff for undo
      let added: ExcludedTitleItem[] = [];
      try {
        const fresh = (await Reader.getExcludedTitles()) as ExcludedTitleItem[];
        const beforeSet = new Set(
          before.map((x) => `${x.titleKey || x.id}:${x.source || "all"}`)
        );
        added = fresh.filter(
          (x) => !beforeSet.has(`${x.titleKey || x.id}:${x.source || "all"}`)
        );
      } catch {}
      toast(`Excluded ${res.excluded} titles from ${bulkSource}`, {
        type: "success",
        action:
          added.length > 0
            ? {
                label: "Undo",
                onClick: async () => {
                  let undone = 0;
                  for (const it of added) {
                    try {
                      await removeExcludedTitle({
                        title_key: it.titleKey || it.id || "",
                        source: it.source,
                      });
                      undone++;
                    } catch {}
                  }
                  queryClient.invalidateQueries({
                    queryKey: queryKeys.excludedTitles,
                  });
                  toast(`Undid ${undone} excludes`, { type: "info" });
                },
              }
            : undefined,
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Bulk exclude failed", {
        type: "error",
      });
    } finally {
      setBulkLoading(false);
    }
  };

  return (
    <PageShell>
      <div className="flex gap-2 p-1 bg-surface rounded-lg border border-border w-fit">
        <Link
          href="/whitelist"
          className="px-3 py-1.5 text-xs font-medium rounded-md text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
        >
          Whitelist
        </Link>
        <Link
          href="/exclude-list"
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-white text-black"
        >
          Exclude
        </Link>
      </div>

      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight text-text">
          Exclude List
        </h1>
        {isLoading ? (
          <div className="skeleton h-3 w-20 rounded" />
        ) : (
          <span className="text-xs text-text-muted">
            {items.length} excluded
          </span>
        )}
      </div>

      {/* Search + bulk-exclude */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <MagnifyingGlass
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            placeholder="Search title..."
            aria-label="Search excluded titles"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-surface border border-border text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent transition-colors"
          />
        </div>

        <Select
          ariaLabel="Filter by source"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          options={[
            { value: "All", label: "Source: All" },
            ...sources.map((s) => ({ value: s, label: s })),
          ]}
        />

        <div className="flex items-center gap-1.5 ml-auto">
          <Select
            ariaLabel="Bulk exclude source"
            value={bulkSource}
            onChange={(e) => setBulkSource(e.target.value)}
            options={[
              { value: "ikiru", label: "ikiru" },
              { value: "shinigami", label: "shinigami" },
            ]}
          />
          <Button
            variant="danger"
            size="sm"
            onClick={handleBulk}
            disabled={bulkLoading}
          >
            <Plus size={14} />
            {bulkLoading ? "Excluding..." : "Exclude all"}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-6">
          {["all", "ikiru", "shinigami"].map((src) => (
            <div key={src} className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="skeleton h-5 w-12 rounded" />
                <div className="skeleton h-3 w-20 rounded" />
              </div>
              <div className="flex flex-col gap-1.5">
                {Array.from({ length: src === "all" ? 1 : 2 }).map((_, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-surface-hover/40"
                  >
                    <div className="skeleton w-12 h-16 rounded-lg shrink-0" />
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="skeleton h-3.5 w-3/4 rounded" />
                      <div className="skeleton h-2.5 w-1/3 rounded" />
                    </div>
                    <div className="skeleton w-8 h-8 rounded-full shrink-0" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <EmptyState
          icon={<Prohibit />}
          message="Failed to load exclude list"
          subMessage={
            error instanceof Error ? error.message : "An error occurred"
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Prohibit />}
          message="No excluded titles"
          subMessage="Titles you exclude will appear here and be hidden from the RSS feed and notifications."
        />
      ) : (
        <div className="space-y-6">
          {groupOrder.map((src) => {
            const list = grouped[src];
            return (
              <div key={src} className="space-y-2">
                <div className="flex items-center gap-2">
                  <SourceBadge source={src} />
                  <span className="text-xs font-medium text-text-muted">
                    {list.length} title{list.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {list.map((it, idx) => {
                    const key = `${it.titleKey || it.id}:${it.source || "all"}`;
                    return (
                      <div
                        key={`${key}:${idx}`}
                        className="group flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-surface-hover/40 hover:bg-surface-hover transition-colors"
                      >
                        <div className="relative shrink-0 w-12 h-16 rounded-lg overflow-hidden bg-surface">
                          {it.cover ? (
                            <img
                              src={it.cover}
                              alt={displayTitle(it)}
                              className="w-full h-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-text-muted">
                              <Prohibit size={16} />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-text truncate">
                            {displayTitle(it)}
                          </p>
                          <p className="text-[11px] text-text-muted truncate">
                            {it.source || "all"}
                          </p>
                        </div>
                        <button
                          onClick={() => handleRemove(it)}
                          disabled={busyKey === key}
                          aria-label="Remove from exclude list"
                          className="p-2 rounded-full text-text-muted hover:text-danger hover:bg-danger/15 transition-colors disabled:opacity-50"
                        >
                          <Trash size={16} weight="bold" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
