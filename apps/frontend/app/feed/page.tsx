"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRssCustomFeed, getRssFilterMetadata } from "@/lib/api";
import { PageShell } from "@/components/PageShell";
import { Funnel, SortAscending, Tag } from "@phosphor-icons/react";

export default function FeedPage() {
  const [genres, setGenres] = useState<string>("");
  const [sources, setSources] = useState<string>("");
  const [origins, setOrigins] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [minRating, setMinRating] = useState<string>("");
  const [maxRating, setMaxRating] = useState<string>("");
  const [subscribedOnly, setSubscribedOnly] = useState(false);
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);

  const { data: metadata } = useQuery({
    queryKey: ["rss-filter-metadata"],
    queryFn: getRssFilterMetadata,
    staleTime: 300_000,
  });

  const { data: feed, isLoading } = useQuery({
    queryKey: [
      "rss-custom",
      genres,
      sources,
      origins,
      status,
      minRating,
      maxRating,
      subscribedOnly,
      sort,
      page,
    ],
    queryFn: () =>
      getRssCustomFeed({
        genres,
        sources,
        origins,
        status,
        minRating,
        maxRating,
        subscribedOnly,
        sort,
        page,
        limit: 50,
      }),
    staleTime: 30_000,
  });

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [
    genres,
    sources,
    origins,
    status,
    minRating,
    maxRating,
    subscribedOnly,
    sort,
  ]);

  const results = feed?.results || [];
  const total = feed?.total || 0;
  const totalPages = feed?.totalPages || 1;
  const hasMore = feed?.hasMore || false;

  return (
    <PageShell>
      <h1 className="text-xl font-semibold tracking-tight text-text">
        Custom Feed
      </h1>

      {/* Filters */}
      <section className="rounded-xl bg-surface border border-border p-5 space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-text">
          <Funnel size={16} />
          Filters
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Genres */}
          <div>
            <label className="text-xs text-text-muted block mb-1">Genres</label>
            <select
              value={genres}
              onChange={(e) => setGenres(e.target.value)}
              className="w-full rounded-lg bg-surface-hover border border-border text-text text-sm px-3 py-2"
            >
              <option value="">All Genres</option>
              {metadata?.genres?.map((g: string) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>

          {/* Sources */}
          <div>
            <label className="text-xs text-text-muted block mb-1">
              Sources
            </label>
            <select
              value={sources}
              onChange={(e) => setSources(e.target.value)}
              className="w-full rounded-lg bg-surface-hover border border-border text-text text-sm px-3 py-2"
            >
              <option value="">All Sources</option>
              {metadata?.sources?.map((s: string) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          {/* Origins */}
          <div>
            <label className="text-xs text-text-muted block mb-1">
              Origins
            </label>
            <select
              value={origins}
              onChange={(e) => setOrigins(e.target.value)}
              className="w-full rounded-lg bg-surface-hover border border-border text-text text-sm px-3 py-2"
            >
              <option value="">All Origins</option>
              {metadata?.origins?.map((o: string) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>

          {/* Status */}
          <div>
            <label className="text-xs text-text-muted block mb-1">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full rounded-lg bg-surface-hover border border-border text-text text-sm px-3 py-2"
            >
              <option value="">All Statuses</option>
              {metadata?.statuses?.map((s: string) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          {/* Min Rating */}
          <div>
            <label className="text-xs text-text-muted block mb-1">
              Min Rating
            </label>
            <input
              type="number"
              min="0"
              max="10"
              step="0.5"
              value={minRating}
              onChange={(e) => setMinRating(e.target.value)}
              placeholder="0"
              className="w-full rounded-lg bg-surface-hover border border-border text-text text-sm px-3 py-2"
            />
          </div>

          {/* Max Rating */}
          <div>
            <label className="text-xs text-text-muted block mb-1">
              Max Rating
            </label>
            <input
              type="number"
              min="0"
              max="10"
              step="0.5"
              value={maxRating}
              onChange={(e) => setMaxRating(e.target.value)}
              placeholder="10"
              className="w-full rounded-lg bg-surface-hover border border-border text-text text-sm px-3 py-2"
            />
          </div>
        </div>

        {/* Sort + Subscribed */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <SortAscending size={14} className="text-text-muted" />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="rounded-lg bg-surface-hover border border-border text-text text-sm px-3 py-2"
            >
              <option value="newest">Newest</option>
              <option value="popular">Popular</option>
              <option value="rating">Rating</option>
            </select>
          </div>

          <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={subscribedOnly}
              onChange={(e) => setSubscribedOnly(e.target.checked)}
              className="rounded border-border"
            />
            Subscribed only
          </label>
        </div>
      </section>

      {/* Results */}
      <div className="flex items-center justify-between text-sm text-text-muted">
        <span>{total} results</span>
        <span>
          Page {page} of {totalPages}
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton h-16 rounded-xl" />
          ))}
        </div>
      ) : results.length === 0 ? (
        <div className="rounded-xl bg-surface border border-border p-8 text-center text-text-muted">
          No results match your filters
        </div>
      ) : (
        <div className="space-y-2">
          {results.map(
            (item: {
              titleKey: string;
              title: string;
              chapterNumber: number;
              source: string;
              origin: string;
              rating: number;
              cover: string;
              genres: string[];
              isWhitelisted: boolean;
            }) => (
              <div
                key={`${item.titleKey}-${item.chapterNumber}`}
                className="rounded-xl bg-surface border border-border p-4 flex items-center gap-4"
              >
                <div className="w-10 h-14 shrink-0 rounded-md overflow-hidden bg-surface-hover">
                  {item.cover ? (
                    <img
                      src={item.cover}
                      alt={item.title}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-text-muted text-xs font-bold">
                      {item.title.charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-text truncate">
                    {item.title}
                  </div>
                  <div className="text-xs text-text-muted flex items-center gap-2">
                    <span>Ch. {item.chapterNumber}</span>
                    <span>·</span>
                    <span>{item.source}</span>
                    <span>·</span>
                    <span>{item.origin}</span>
                    {item.rating > 0 && (
                      <>
                        <span>·</span>
                        <span className="text-amber-400">
                          {item.rating.toFixed(1)}★
                        </span>
                      </>
                    )}
                  </div>
                  {item.genres?.length > 0 && (
                    <div className="flex items-center gap-1 mt-1 flex-wrap">
                      {item.genres.slice(0, 3).map((g: string) => (
                        <span
                          key={g}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-surface-hover text-text-muted"
                        >
                          {g}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {item.isWhitelisted && (
                  <Tag size={14} className="text-success shrink-0" />
                )}
              </div>
            )
          )}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-4 py-2 rounded-lg bg-surface border border-border text-sm text-text disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-sm text-text-muted">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={!hasMore}
            className="px-4 py-2 rounded-lg bg-surface border border-border text-sm text-text disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </PageShell>
  );
}
