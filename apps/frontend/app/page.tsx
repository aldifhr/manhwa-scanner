"use client";

import { useDeferredValue, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { decodeHtml, rewriteCoverUrl, getChapterLabel } from "@/lib/utils";
import { Reader } from "@/lib/reader";
import {
  Clock,
  TrendUp,
  Star,
  ArrowClockwise,
  BookOpen,
  Compass,
  MagnifyingGlass,
  Plus,
  CheckCircle,
  BookBookmark,
} from "@phosphor-icons/react";
import { useContinueReading } from "@/lib/continueReading";
import { saveBookmark, getBookmarks } from "@/lib/api";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { PageShell } from "@/components/PageShell";
import EmptyState from "@/components/EmptyState";
import { ErrorFallback } from "@/components/ErrorFallback";
import VirtualizedList from "@/components/home/VirtualizedList";
import { groupChapters, type GroupedSeries } from "@/lib/groupChapters";
import { normalizeOrigin, getOriginFlag } from "@/lib/constants";
import { queryKeys, staleTimes } from "@/lib/queryKeys";
import type { FlatChapter } from "@/components/home/AllTab";
import { useFeedActions } from "@/components/home/hooks/useFeedActions";

interface FeedResponse {
  success: boolean;
  data: {
    results: unknown[];
    total: number;
    hasMore: boolean;
  };
}

async function fetchFeed(): Promise<FeedResponse> {
  // Flat + client groupChapters — server grouped (?group=true) missing chapter numbers for ikiru (Ch. ?), so force flat
  const res = await fetch("/api/v1/reader/rss?limit=36&group=false");
  return res.json();
}

function CoverImage({ src, alt }: { src: string | null; alt: string }) {
  if (!src) {
    return (
      <div className="w-full aspect-3/4 rounded-xl cover-placeholder flex items-center justify-center bg-surface border border-white/6">
        <span className="text-white/30 text-xs tracking-wide">No cover</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className="w-full aspect-3/4 object-cover bg-surface group-hover:scale-[1.03] transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
      loading="lazy"
    />
  );
}

function SourcePill({ source }: { source: string }) {
  const s = source?.toLowerCase();
  const cls =
    s === "shinigami"
      ? "bg-red-500/15 text-red-400 border-red-500/20"
      : s === "ikiru"
        ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/20"
        : s === "voratoon"
          ? "bg-orange-500/15 text-orange-400 border border-orange-500/20"
          : "bg-white/10 text-white/80 border-white/10";
  return (
    <span
      className={`text-[10px] font-semibold px-2.5 py-1 rounded-full capitalize backdrop-blur-md border shadow-sm ${cls}`}
    >
      {source}
    </span>
  );
}

function ContinueReadingCard({
  entry,
}: {
  entry: ReturnType<typeof useContinueReading>["entries"] extends Map<
    string,
    infer V
  >
    ? V
    : never;
}) {
  return (
    <div className="group shrink-0 w-36 sm:w-44 relative">
      <a
        href={entry.chapterUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block"
      >
        <div className="relative overflow-hidden rounded-xl card-hover border border-white/8 hover:border-white/15 bg-surface">
          <CoverImage src={entry.cover} alt={decodeHtml(entry.title)} />
          <div className="absolute inset-0 bg-linear-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
          <div className="absolute top-2.5 left-2.5">
            <SourcePill source={entry.source} />
          </div>
          <div className="absolute bottom-0 left-0 right-0 bg-linear-to-t from-black via-black/70 to-transparent pt-6 p-2.5">
            <p className="text-[11px] font-bold tracking-wide text-white">
              Ch. {entry.lastChapter}
            </p>
          </div>
        </div>
      </a>

      <div className="mt-2.5 px-1">
        <h3 className="text-xs sm:text-[13px] font-semibold leading-snug text-white line-clamp-2 min-h-[2.2rem] group-hover:text-white/80 transition-colors">
          {decodeHtml(entry.title)}
        </h3>
        <p className="text-[10px] text-white/45 mt-1 tracking-wide">
          {entry.origin} • {entry.source}
        </p>
      </div>
    </div>
  );
}

function HomeGroupedCard({
  series,
  isWhitelisted,
  adding,
  onAdd,
  isBookmarked,
}: {
  series: GroupedSeries;
  isWhitelisted?: boolean;
  adding?: boolean;
  onAdd?: () => void;
  isBookmarked?: boolean;
}) {
  const origin = normalizeOrigin(series.origin);
  const flag = series.type ? getOriginFlag(origin) : "";
  const [coverSrc, setCoverSrc] = useState(() => rewriteCoverUrl(series.cover));
  const [hasRetried, setHasRetried] = useState(false);
  const [imgErrorFinal, setImgErrorFinal] = useState(false);
  const { trackChapter } = useContinueReading();

  return (
    <div className="group relative flex gap-4 p-4 rounded-2xl border border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/[0.07] transition-all">
      {/* Cover */}
      <a
        href={series.seriesUrl || series.chapters[0]?.seriesUrl || "#"}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0"
      >
        {coverSrc && !imgErrorFinal ? (
          <img
            src={coverSrc}
            alt={decodeHtml(series.title)}
            className="w-16 sm:w-20 h-24 sm:h-28 object-cover rounded-lg bg-white/5 ring-1 ring-white/10"
            loading="lazy"
            onError={() => {
              if (!hasRetried && series.titleKey) {
                setCoverSrc(
                  `/api/v1/reader/cover?series=${encodeURIComponent(series.titleKey)}`
                );
                setHasRetried(true);
              } else {
                setImgErrorFinal(true);
              }
            }}
          />
        ) : (
          <div
            className="w-16 sm:w-20 h-24 sm:h-28 rounded-lg bg-white/5 ring-1 ring-white/10 flex items-center justify-center"
            title={
              hasRetried ? "Cover expired — fallback also failed" : undefined
            }
          >
            <BookOpen size={20} className="text-white/30" />
          </div>
        )}
      </a>

      {/* Body */}
      <div className="flex-1 min-w-0 flex flex-col">
        <a
          href={series.seriesUrl || series.chapters[0]?.seriesUrl || "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
        >
          <h3 className="text-[14px] sm:text-[15px] font-semibold leading-snug truncate text-white group-hover:text-white/80 transition-colors">
            {decodeHtml(series.title)}
          </h3>
        </a>

        <div className="flex flex-wrap items-center gap-1 mt-1">
          {flag && (series as unknown as { type?: string | null }).type && (
            <img
              src={flag}
              alt={origin}
              className="w-4 h-3 rounded-sm object-cover block shrink-0"
            />
          )}
          <span className="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md bg-white/10 text-white/80">
            {series.chapters.length} ch
          </span>
          {series.chapters[0] &&
            (() => {
              const src = series.chapters[0].source?.toLowerCase();
              const chipColor =
                src === "shinigami"
                  ? "bg-red-500/15 text-red-400"
                  : src === "ikiru"
                    ? "bg-green-500/15 text-green-400"
                    : "bg-white/10 text-white/80";
              return (
                <span
                  className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded capitalize ${chipColor}`}
                >
                  {series.chapters[0].source}
                </span>
              );
            })()}
          {isBookmarked && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
              <BookBookmark size={10} weight="fill" /> BM
            </span>
          )}
        </div>

        {/* Description */}
        {series.description && (
          <p className="text-[11px] leading-[1.4] text-white/55 line-clamp-2 mt-1.5">
            {decodeHtml(series.description)}
          </p>
        )}

        {/* Chapter chips — per source */}
        <div className="flex gap-1.5 flex-wrap mt-1.5">
          {series.chapters.map((ch) => {
            const label = getChapterLabel(
              ch as unknown as {
                chapterLabel?: string | null;
                chapterNumber?: number | string | null;
                chapter?: string | null;
                url?: string | null;
                chapterUrl?: string | null;
              }
            );
            if (label === "?") return null;
            const href = ch.chapterUrl || ch.url || series.seriesUrl || "#";
            const src = ch.source?.toLowerCase();
            const chipColor =
              src === "shinigami"
                ? "bg-red-500/15 text-red-400 hover:bg-red-500/25"
                : src === "ikiru"
                  ? "bg-green-500/15 text-green-400 hover:bg-green-500/25"
                  : src === "voratoon"
                    ? "bg-orange-500/15 text-orange-400 hover:bg-orange-500/25"
                    : "bg-white/10 text-white/80 hover:bg-white/20";
            return (
              <span key={ch.key} className="inline-flex items-center gap-1">
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() =>
                    trackChapter({
                      title: series.title,
                      titleKey: series.titleKey,
                      cover: series.cover,
                      source: ch.source,
                      chapter:
                        (ch as unknown as { chapter?: string }).chapter ??
                        ch.chapterLabel,
                      chapterLabel: ch.chapterLabel,
                      chapterNumber: ch.chapterNumber,
                      chapterUrl: href !== "#" ? href : ch.chapterUrl || ch.url,
                      seriesUrl: series.seriesUrl,
                      origin: series.origin,
                    })
                  }
                  title={`${ch.source} · Ch. ${label}`}
                  className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-md transition-colors whitespace-nowrap ${chipColor}`}
                >
                  <span className="capitalize">{ch.source}</span>
                  Ch. {label}
                </a>
                <button
                  onClick={async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    try {
                      const num =
                        Number(String(label).replace(/[^0-9.]/g, "")) || 0;
                      await saveBookmark({
                        title_key: series.titleKey,
                        chapter_number: num || 1,
                        chapter_url: href,
                        source: ch.source,
                        title: series.title,
                        cover: series.cover,
                      });
                      toast.success("Bookmarked Ch. " + label);
                    } catch (err) {
                      toast.error(
                        err instanceof Error ? err.message : "Bookmark failed"
                      );
                    }
                  }}
                  title={`Bookmark Ch. ${label}`}
                  className="inline-flex items-center justify-center px-2.5 py-1 text-[11px] font-medium leading-none rounded-md bg-white/5 hover:bg-white/15 border border-white/10 text-white/60 hover:text-white transition-colors"
                >
                  Bookmark
                </button>
              </span>
            );
          })}
          {series.chapters.every(
            (c) =>
              getChapterLabel(
                c as unknown as {
                  chapterLabel?: string | null;
                  chapterNumber?: number | string | null;
                  chapter?: string | null;
                  url?: string | null;
                  chapterUrl?: string | null;
                }
              ) === "?"
          ) && (
            <a
              href={series.seriesUrl || series.chapters[0]?.seriesUrl || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-md bg-white/10 text-white/80 hover:bg-white/20 transition-colors whitespace-nowrap"
            >
              View Series
            </a>
          )}
        </div>

        {/* Actions — Add WL */}
        <div className="flex items-center gap-2 mt-3">
          {isWhitelisted ? (
            <span className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-green-500/15 text-green-400 border border-green-500/20 font-medium ml-auto">
              <CheckCircle size={13} weight="fill" />
              Added
            </span>
          ) : (
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onAdd?.();
              }}
              disabled={adding}
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
            >
              <Plus size={13} weight="bold" />
              {adding ? "..." : "Add WL"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function GroupedSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex gap-4 p-4 rounded-2xl border border-white/10 bg-white/5"
        >
          <div className="skeleton w-16 sm:w-20 h-24 sm:h-28 rounded-lg shrink-0" />
          <div className="flex-1 space-y-3 py-1">
            <div className="skeleton h-4 w-3/4 rounded" />
            <div className="skeleton h-3 w-1/3 rounded" />
            <div className="flex gap-2">
              <div className="skeleton h-6 w-20 rounded-md" />
              <div className="skeleton h-6 w-20 rounded-md" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function HomePage() {
  const [isPending, startTransition] = useTransition();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.homeFeed,
    queryFn: fetchFeed,
    staleTime: staleTimes.rss,
    gcTime: 300_000,
    placeholderData: keepPreviousData,
  });

  const { optimisticWhitelist, addingKey, handleAddGroup } = useFeedActions();

  const { data: bookmarks } = useQuery({
    queryKey: ["bookmarks"],
    queryFn: () => getBookmarks(),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const bookmarkSet = useMemo(() => {
    const s = new Set<string>();
    for (const b of bookmarks ?? []) {
      s.add(b.title_key);
      s.add(`${b.title_key}:${b.chapter_number}`);
    }
    return s;
  }, [bookmarks]);

  const { data: snapshot, isLoading: snapshotLoading } = useQuery({
    queryKey: queryKeys.dashboardSnapshot,
    queryFn: () =>
      Reader.getDashboardSnapshot() as Promise<
        import("@/lib/types").DashboardSnapshot
      >,
    staleTime: staleTimes.dashboard,
  });

  const { entries: continueReading, clearAll: clearContinueReading } =
    useContinueReading();

  const sortedContinueReading = useMemo(
    () =>
      [...continueReading.values()]
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        )
        .slice(0, 10),
    [continueReading]
  );

  const rawResults = (data?.data?.results ?? []) as unknown[];
  const deferredResults = useDeferredValue(rawResults);

  // Get latest timestamp from results
  const latestTimestamp = useMemo(() => {
    if (deferredResults.length === 0) return null;
    const times = deferredResults
      .map((r: any) => r?.updated_time || r?.sent_at || r?.updatedAt)
      .filter(Boolean)
      .map((t: string) => new Date(t).getTime());
    return times.length > 0 ? Math.max(...times) : null;
  }, [deferredResults]);

  // grouped by titleKey — same seam as /recent AllTab (deferred + transition biar gak block main thread pas 1k row)
  const grouped = useMemo(() => {
    if (deferredResults.length === 0) return [];
    const isGrouped =
      typeof (deferredResults[0] as Record<string, unknown>)?.chapters !==
        "undefined" &&
      Array.isArray((deferredResults[0] as { chapters?: unknown[] })?.chapters);
    if (isGrouped) return deferredResults as unknown as GroupedSeries[];
    return groupChapters(deferredResults as unknown as FlatChapter[]);
  }, [deferredResults]);

  const totalSent = snapshot?.overview?.totalChaptersSent ?? 0;
  const totalTracked = snapshot?.overview?.totalMangaTracked ?? 0;

  return (
    <PageShell>
      <div className="mb-8">
        <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-white mb-2">
          ManhwaScan
        </h1>
        <p className="text-white/60 text-sm sm:text-base">
          Read manhwa, manga, and webtoon for free. Daily updates from multiple
          sources.
        </p>
      </div>

      {/* Bookmark */}
      {continueReading.size > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <BookBookmark size={18} className="text-white" weight="fill" />
            <h2 className="text-lg sm:text-xl font-bold text-white">
              Bookmark
            </h2>
            <span className="text-xs text-white/50">
              ({continueReading.size})
            </span>
            <button
              onClick={clearContinueReading}
              className="ml-auto text-[11px] px-2.5 py-1 rounded-lg bg-white/5 text-white/60 hover:text-white hover:bg-white/10 transition-colors"
            >
              Clear all
            </button>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide snap-x snap-mandatory">
            {sortedContinueReading.map((entry, i) => (
              <motion.div
                key={entry.titleKey}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04, duration: 0.25 }}
              >
                <ContinueReadingCard key={entry.titleKey} entry={entry} />
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-8">
        {[
          {
            icon: Clock,
            label: "Today's Updates",
            value: grouped.length || rawResults.length,
          },
          {
            icon: TrendUp,
            label: "Total Series",
            value: totalTracked || (data?.data?.total ?? 0),
          },
          { icon: Star, label: "Total Sent", value: totalSent },
          {
            icon: ArrowClockwise,
            label: "Last Update",
            value: latestTimestamp
              ? new Date(latestTimestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "Manual",
          },
        ].map(({ icon: Icon, label, value }) => (
          <div
            key={label}
            className="bg-white/5 border border-white/10 rounded-xl p-3 sm:p-4 flex items-center gap-3"
          >
            {isLoading || snapshotLoading ? (
              <>
                <div className="skeleton w-9 h-9 sm:w-10 sm:h-10 rounded-lg shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="skeleton h-3.5 w-14 rounded" />
                  <div className="skeleton h-2.5 w-10 rounded" />
                </div>
              </>
            ) : (
              <>
                <div className="p-2 rounded-lg bg-white/10">
                  <Icon size={18} className="text-white" weight="fill" />
                </div>
                <div>
                  <p className="text-base sm:text-lg font-bold text-white">
                    {value}
                  </p>
                  <p className="text-[10px] sm:text-xs text-white/50">
                    {label}
                  </p>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between mb-4 sm:mb-6">
        <h2 className="text-lg sm:text-xl font-bold text-white">
          Latest Updates
        </h2>
        <button
          onClick={() => refetch()}
          className="text-sm text-white/60 hover:text-white transition-colors"
        >
          Refresh
        </button>
      </div>

      {isLoading ? (
        <GroupedSkeleton />
      ) : error ? (
        <ErrorFallback
          title="Failed to load updates"
          message={
            error instanceof Error ? error.message : "Try refreshing the page"
          }
          onRetry={() => refetch()}
        />
      ) : grouped.length === 0 ? (
        <EmptyState
          icon={<MagnifyingGlass />}
          message="No updates today"
          subMessage={
            latestTimestamp
              ? `Last update: ${new Date(latestTimestamp).toLocaleString()}`
              : "Check again later or view all in Recent"
          }
          action={
            <Link
              href="/recent"
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors"
            >
              <Compass size={14} />
              Lihat Recent
            </Link>
          }
        />
      ) : grouped.length > 14 ? (
        <VirtualizedList
          items={grouped}
          gap={12}
          estimateSize={184}
          renderItem={(series) => {
            const s = series as GroupedSeries;
            const isWL =
              s.isWhitelisted ||
              s.chapters.some((c: { titleKey: string; source: string }) =>
                optimisticWhitelist.has(
                  `${c.titleKey || s.titleKey}:${c.source}`
                )
              ) ||
              optimisticWhitelist.has(s.titleKey);
            const adding = addingKey === s.titleKey;
            const isBM =
              bookmarkSet.has(s.titleKey) ||
              s.chapters.some(
                (c: { titleKey: string; chapterNumber: number }) =>
                  bookmarkSet.has(
                    `${c.titleKey || s.titleKey}:${c.chapterNumber}`
                  ) || bookmarkSet.has(c.titleKey || s.titleKey)
              );
            return (
              <HomeGroupedCard
                series={s}
                isWhitelisted={isWL}
                adding={adding}
                onAdd={() => handleAddGroup(s)}
                isBookmarked={isBM}
              />
            );
          }}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {grouped.map((series, i) => {
            const isWL =
              series.isWhitelisted ||
              series.chapters.some((c: { titleKey: string; source: string }) =>
                optimisticWhitelist.has(
                  `${c.titleKey || series.titleKey}:${c.source}`
                )
              ) ||
              optimisticWhitelist.has(series.titleKey);
            const adding = addingKey === series.titleKey;
            const isBM =
              bookmarkSet.has(series.titleKey) ||
              series.chapters.some(
                (c: { titleKey: string; chapterNumber: number }) =>
                  bookmarkSet.has(
                    `${c.titleKey || series.titleKey}:${c.chapterNumber}`
                  ) || bookmarkSet.has(c.titleKey || series.titleKey)
              );
            return (
              <motion.div
                key={series.titleKey + String(i)}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i, 12) * 0.04, duration: 0.3 }}
              >
                <HomeGroupedCard
                  series={series}
                  isWhitelisted={isWL}
                  adding={adding}
                  onAdd={() => handleAddGroup(series)}
                  isBookmarked={isBM}
                />
              </motion.div>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
