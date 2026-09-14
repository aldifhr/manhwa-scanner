"use client";

import { useState, memo } from "react";
import { safeUrl, getChapterLabel } from "@/lib/utils";
import { decodeHtml } from "@/lib/utils";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { useLongPress } from "@/lib/hooks/useLongPress";
import { useContinueReading } from "@/lib/continueReading";
import { useReadItems } from "./useReadItems";
import { normalizeOrigin, getOriginFlag } from "@/lib/constants";
import { SeriesShell, Synopsis, CardActions, RatingRow } from "./seriesShared";

interface GroupedSeries {
  title: string;
  titleKey: string;
  chapters: {
    key: string;
    source: string;
    chapter: string;
    chapterLabel: string;
    chapterNumber: number;
    url: string;
    chapterUrl: string;
    sentAt: string;
  }[];
  cover: string;
  origin: string;
  seriesUrl: string;
  rating?: string | number | null;
  genres?: string[];
  description?: string | null;
  isWhitelisted: boolean;
  type?: string | null;
}

function GroupedSeriesCard({
  series,
  isRead,
  isWhitelisted,
  adding,
  onToggleRead,
  onAdd,
  isExcluded,
  excluding,
  onExclude,
  isPinned,
  onTogglePin,
  isDeepMatch,
}: {
  series: GroupedSeries;
  isRead: boolean;
  isWhitelisted: boolean;
  adding: boolean;
  onToggleRead: () => void;
  onAdd: () => void;
  isExcluded: boolean;
  excluding: boolean;
  onExclude: () => void;
  isPinned?: boolean;
  onTogglePin?: () => void;
  isDeepMatch?: boolean;
  readCount?: number;
  totalChapters?: number;
  isNew?: boolean;
  unreadCount?: number;
  onMarkRead?: () => void;
  isSentToDiscord?: boolean;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const { onTouchStart, onTouchEnd, onTouchMove } = useLongPress((pos) => setMenu(pos));
  const seriesHref = safeUrl(series.seriesUrl) || "#";
  const { trackChapter } = useContinueReading();
  const { readItems } = useReadItems();
  const origin = normalizeOrigin(series.origin);
  const t = (series.type || "").toLowerCase().trim();
  const flag = t === "manhwa" || t === "manhua" ? getOriginFlag(origin) : "";

  const first = series.chapters[0];
  return (
    <>
      <SeriesShell
        cover={series.cover}
        title={series.title}
        titleKey={series.titleKey}
        seriesUrl={seriesHref}
        isRead={isRead}
        overlaySource={first?.source ?? null}
        overlayLabel={null}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchMove={onTouchMove}
        className={isDeepMatch ? "ring-2 ring-white ring-offset-2 ring-offset-black" : undefined}
      >
        {/* Title + flag — same as HomeGroupedCard */}
        <div className="flex min-w-0 items-start gap-2">
          {flag && <img src={flag} alt={origin} className="mt-0.5 h-4 w-4 shrink-0" loading="lazy" />}
          <a href={seriesHref} target="_blank" rel="noopener noreferrer" className="block min-h-0 min-w-0 flex-1 rounded focus-visible:ring-2 focus-visible:ring-white">
            <h3 className="line-clamp-2 text-[15px] font-semibold leading-tight text-white transition-colors group-hover:text-white/80 sm:text-base">
              {decodeHtml(series.title)}
            </h3>
          </a>
        </div>

        <RatingRow rating={series.rating} genres={series.genres} />

        <Synopsis text={series.description} />

        {/* Pills — same as HomeGroupedCard: slice 0-4, rounded-md, Ch. only */}
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
          {series.chapters.slice(0, 4).map((ch) => {
            const label = getChapterLabel(ch as any);
            if (label === "?") return null;
            const href = ch.chapterUrl || ch.url || series.seriesUrl || "#";
            const src = ch.source?.toLowerCase();
            const chipColor =
              src === "shinigami"
                ? "bg-red-500/15 text-red-400 hover:bg-red-500/25 border-red-500/20"
                : src === "ikiru"
                  ? "bg-green-500/15 text-green-400 hover:bg-green-500/25 border-green-500/20"
                  : src === "voratoon"
                    ? "bg-orange-500/15 text-orange-400 hover:bg-orange-500/25 border-orange-500/20"
                    : "bg-white/10 text-white/80 hover:bg-white/20 border-white/8";
            return (
              <a
                key={ch.key}
                href={safeUrl(href) || "#"}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() =>
                  trackChapter({
                    title: series.title,
                    titleKey: series.titleKey,
                    cover: series.cover,
                    source: ch.source,
                    chapter: ch.chapter,
                    chapterLabel: ch.chapterLabel,
                    chapterNumber: ch.chapterNumber,
                    chapterUrl: href !== "#" ? href : ch.chapterUrl || ch.url,
                    seriesUrl: series.seriesUrl,
                    origin: series.origin,
                  })
                }
                className={`inline-flex min-h-0 min-w-0 items-center justify-center rounded-md border px-2 py-1 text-[11px] leading-none transition-colors ${chipColor}`}
              >
                Ch. {label}
              </a>
            );
          })}
          {series.chapters.every((c) => getChapterLabel(c as any) === "?") && (
            <a
              href={seriesHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-0 min-w-0 items-center justify-center rounded-md border border-white/8 bg-white/10 px-2 py-1 text-[11px] leading-none text-white/80 transition-colors hover:bg-white/20"
            >
              View Series
            </a>
          )}
        </div>

        <CardActions
          isWhitelisted={isWhitelisted}
          isExcluded={isExcluded}
          excluding={excluding}
          onExclude={onExclude}
          adding={adding}
          onAdd={onAdd}
          isRead={isRead}
          onToggleRead={onToggleRead}
          showRead={false}
          showAdd={true}
        />
      </SeriesShell>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: isRead ? "Mark as unread" : "Mark as read", onClick: onToggleRead },
            { label: isPinned ? "Unpin" : "Pin to top", onClick: () => onTogglePin?.() },
          ]}
        />
      )}
    </>
  );
}

export default memo(GroupedSeriesCard);
