"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Reader } from "@/lib/reader";
import type { WhitelistRouteItem } from "@/lib/types";
import { queryKeys } from "@/lib/queryKeys";
import { MangaCardSkeleton } from "@/components/MangaCard";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useDebounced } from "@/lib/useDebounced";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/EmptyState";
import { ErrorFallback } from "@/components/ErrorFallback";
import { Select } from "@/components/ui/Select";
import { CompactSearchInput } from "@/components/ui/SearchInput";
import { GRID_CLASS } from "@/lib/grid";
import { useWhitelistFilters } from "@/components/home/hooks/useWhitelistFilters";
import { WhitelistCard } from "@/components/WhitelistCard";

export function WhitelistGrid() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.whitelist,
    queryFn: () =>
      Reader.getWhitelist(1, 1000, false) as unknown as Promise<
        WhitelistRouteItem[]
      >,
    staleTime: 30_000,
  });

  const [sourceFilter, setSourceFilter] = useState("All");
  const [typeFilter, setTypeFilter] = useState("All");
  const [originFilter, setOriginFilter] = useState("All");
  const [searchTerm, setSearchTerm] = useState("");
  const debouncedSearch = useDebounced(searchTerm, 300);
  const [sort, setSort] = useState<"title" | "rating" | "recent">("recent");

  const items = data ?? [];
  const filtered = useWhitelistFilters(items, {
    sourceFilter,
    typeFilter,
    originFilter,
    debouncedSearch,
    sort,
  });

  const sources = useMemo(() => {
    const set = new Set<string>();
    items.forEach((i) => {
      if (i.source) set.add(i.source);
      if (Array.isArray(i.sources))
        i.sources.forEach((s: string | { source: string }) => {
          const v =
            typeof s === "string" ? s : (s as { source: string }).source;
          if (v) set.add(v);
        });
    });
    return [...set].sort();
  }, [items]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        {/* Search skeleton */}
        <div className="flex items-center justify-between gap-2">
          <div className="skeleton h-8 w-48 rounded-lg" />
          <div className="flex items-center gap-2">
            <div className="skeleton h-8 w-20 rounded-lg" />
          </div>
        </div>

        {/* Filters skeleton */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="skeleton h-8 w-24 rounded-lg" />
          <div className="skeleton h-8 w-28 rounded-lg" />
          <div className="skeleton h-8 w-24 rounded-lg" />
          <div className="skeleton h-8 w-28 rounded-lg" />
          <div className="skeleton h-7 w-14 rounded-lg" />
          <div className="skeleton h-4 w-16 rounded ml-auto" />
        </div>

        {/* Grid skeleton — co-located with MangaCard for locality */}
        <div className={GRID_CLASS}>
          {Array.from({ length: 12 }).map((_, i) => (
            <MangaCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <ErrorFallback
        title="Failed to load data"
        message={error instanceof Error ? error.message : "An error occurred"}
        onRetry={() => refetch()}
        icon="warning"
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2 p-1 bg-surface rounded-lg border border-border w-fit">
        <Link
          href="/whitelist"
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-white text-black"
        >
          Whitelist
        </Link>
        <Link
          href="/exclude-list"
          className="px-3 py-1.5 text-xs font-medium rounded-md text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
        >
          Exclude
        </Link>
      </div>

      <div className="flex items-center justify-between gap-2">
        <CompactSearchInput value={searchTerm} onChange={setSearchTerm} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          ariaLabel="Filter by source"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          options={[
            { value: "All", label: "Source: All" },
            ...sources.map((s) => ({ value: s, label: s })),
          ]}
        />

        {/* Type filter */}
        <Select
          ariaLabel="Filter by type"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          options={[
            { value: "All", label: "Type: All" },
            { value: "manhwa", label: "Manhwa (KR)" },
            { value: "manhua", label: "Manhua (CN)" },
            { value: "manga", label: "Manga (JP)" },
          ]}
        />

        {/* Origin filter */}
        <Select
          ariaLabel="Filter by origin"
          value={originFilter}
          onChange={(e) => setOriginFilter(e.target.value)}
          options={[
            { value: "All", label: "Origin: All" },
            { value: "KR", label: "KR" },
            { value: "CN", label: "CN" },
            { value: "JP", label: "JP" },
          ]}
        />

        {/* Sort */}
        <Select
          ariaLabel="Sort by"
          value={sort}
          onChange={(e) =>
            setSort(e.target.value as "title" | "rating" | "recent")
          }
          options={[
            { value: "title", label: "Sort: A–Z" },
            { value: "rating", label: "Sort: Rating" },
            { value: "recent", label: "Sort: Recent" },
          ]}
        />

        {(sourceFilter !== "All" ||
          typeFilter !== "All" ||
          originFilter !== "All" ||
          debouncedSearch !== "" ||
          sort !== "recent") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSourceFilter("All");
              setTypeFilter("All");
              setOriginFilter("All");
              setSearchTerm("");
              setSort("recent");
            }}
          >
            Reset
          </Button>
        )}

        <span className="text-xs text-text-muted ml-auto">
          {filtered.length} / {items.length}
        </span>
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
          <EmptyState
            icon={<MagnifyingGlass />}
            message="No manga found"
            subMessage="Try adjusting the search above"
          />
        </div>
      ) : (
        <div className={GRID_CLASS}>
          {filtered.map((item) => (
            <WhitelistCard key={item.id} item={item} onRefetch={refetch} />
          ))}
        </div>
      )}
    </div>
  );
}
