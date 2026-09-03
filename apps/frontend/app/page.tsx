"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
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
} from "@phosphor-icons/react";
import { useContinueReading } from "@/lib/continueReading";
import { saveBookmark } from "@/lib/api";
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
  onRemove,
}: {
  entry: ReturnType<typeof useContinueReading>["entries"] extends Map<
    string,
    infer V
  >
    ? V
    : never;
  onRemove?: (titleKey: string) => void;
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
      {onRemove && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove(entry.titleKey);
          }}
          aria-label={`Remove ${entry.title} from continue reading`}
          className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-black/70 backdrop-blur border border-white/15 text-white/70 hover:text-white hover:bg-red-500/90 hover:border-red-500/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all text-[10px]"
        >
          ×
        </button>
      )}
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

function HomeGroupedCard({ series }: { series: GroupedSeries }) {
  const origin = normalizeOrigin(series.origin);
  const flag = getOriginFlag(origin);
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
          {flag && (
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
                    const num = Number(String(label).replace(/[^0-9.]/g, "")) || 0;
                    await saveBookmark({ title_key: series.titleKey, chapter_number: num || 1, chapter_url: href, source: ch.source, title: series.title, cover: series.cover });
                    toast.success("Bookmarked Ch. " + label);
                  } catch (err) { toast.error(err instanceof Error ? err.message : "Bookmark failed"); }
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
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.homeFeed,
    queryFn: fetchFeed,
    staleTime: staleTimes.rss,
  });

  const { data: snapshot, isLoading: snapshotLoading } = useQuery({
    queryKey: queryKeys.dashboardSnapshot,
    queryFn: () =>
      Reader.getDashboardSnapshot() as Promise<
        import("@/lib/types").DashboardSnapshot
      >,
    staleTime: staleTimes.dashboard,
  });

  const {
    entries: continueReading,
    removeReading,
    clearAll: clearContinueReading,
  } = useContinueReading();

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

  // grouped by titleKey — same seam as /recent AllTab
  const grouped = useMemo(() => {
    if (rawResults.length === 0) return [];
    const isGrouped =
      typeof (rawResults[0] as Record<string, unknown>)?.chapters !==
        "undefined" &&
      Array.isArray((rawResults[0] as { chapters?: unknown[] })?.chapters);
    if (isGrouped) return rawResults as unknown as GroupedSeries[];
    return groupChapters(rawResults as unknown as FlatChapter[]);
  }, [rawResults]);

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

      {/* Continue Reading */}
      {continueReading.size > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <BookOpen size={18} className="text-white" weight="fill" />
            <h2 className="text-lg sm:text-xl font-bold text-white">
              Continue Reading
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
              <motion.div key={entry.titleKey} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04, duration: 0.25 }}>
                <ContinueReadingCard
                key={entry.titleKey}
                entry={entry}
                onRemove={removeReading}
                />
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
          { icon: ArrowClockwise, label: "Auto Refresh", value: "60s" },
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
          subMessage="Check again later or view all in Recent"
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
          renderItem={(series) => (
            <HomeGroupedCard series={series as GroupedSeries} />
          )}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {grouped.map((series, i) => (
              <motion.div key={series.titleKey + String(i)} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.04, duration: 0.3 }}>
                <HomeGroupedCard series={series} />
              </motion.div>
            ))}
        </div>
      )}
    </PageShell>
  );
}
