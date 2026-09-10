"use client";

import { useState, useMemo } from "react";
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
import { useWhitelistFilters } from "@/components/home/hooks/useWhitelistFilters";
import { WhitelistCard } from "@/components/WhitelistCard";

export function WhitelistGrid() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.whitelist(false),
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
  const [sort, setSort] = useState<"title" | "rating" | "recent">("title");

  const [catalogSearch, setCatalogSearch] = useState("");
  const debouncedCatalogSearch = useDebounced(catalogSearch, 400);
  const { data: catalogResults } = useQuery({
    queryKey: ["catalog-search", debouncedCatalogSearch],
    queryFn: () => Reader.searchCatalog(debouncedCatalogSearch),
    enabled: debouncedCatalogSearch.length > 0,
    staleTime: 30_000,
  });

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
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
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

  const catalogItems = Array.isArray(catalogResults) ? catalogResults : [];
  const isCatalogSearching = debouncedCatalogSearch.length > 0;

  return (
    <div className="space-y-4">
      {/* Catalog search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <MagnifyingGlass
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            placeholder="Search catalog..."
            value={catalogSearch}
            onChange={(e) => setCatalogSearch(e.target.value)}
            data-search-input="catalog"
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-surface border border-border text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent transition-colors"
          />
        </div>


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
            { value: "no_type", label: "No Type" },
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

      {/* Catalog results */}
      {isCatalogSearching && catalogItems.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-text-muted uppercase tracking-wide">
            Catalog results ({catalogItems.length})
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {catalogItems.map((item, i) => {
              const c = item as Record<string, unknown>;
              return (
                <div
                  key={`catalog-${i}-${String(c.id ?? c.title ?? i)}`}
                  className="rounded-lg border border-border bg-surface p-2 hover:ring-1 hover:ring-accent transition-colors"
                >
                  {c.coverImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={String(c.coverUrl ?? c.cover_image_url ?? c.coverImageUrl)}
                      alt={String(c.title ?? "")}
                      className="w-full aspect-[3/4] object-cover rounded mb-2"
                    />
                  ) : (
                    <div className="w-full aspect-[3/4] rounded bg-white/5 mb-2 flex items-center justify-center">
                      <MagnifyingGlass size={20} className="text-white/20" />
                    </div>
                  )}
                  <p className="text-xs text-text truncate">
                    {String(c.title ?? "Untitled")}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {isCatalogSearching && catalogItems.length === 0 && (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <EmptyState
            icon={<MagnifyingGlass />}
            message="No catalog results"
            subMessage={`Nothing found for "${debouncedCatalogSearch}"`}
          />
        </div>
      )}

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
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {filtered.map((item) => (
            <WhitelistCard
              key={`${item.id}:${item.source}`}
              item={item}
              onRefetch={refetch}
            />
          ))}
        </div>
      )}
    </div>
  );
}
