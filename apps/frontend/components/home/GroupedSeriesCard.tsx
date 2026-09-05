"use client";

import { useState, memo } from "react";
import { cn, safeUrl } from "@/lib/utils";
import { decodeHtml, getChapterLabel } from "@/lib/utils";
import { Check, Eye, EyeSlash, CheckCircle, Plus } from "@phosphor-icons/react";
import { Cover } from "@/components/ui/Cover";
import { RatingStars } from "@/components/ui/RatingStars";
import { OriginFlag } from "@/components/ui/OriginFlag";
import { SourceChip } from "@/components/ui/SourceChip";
import { GenreChips } from "@/components/ui/GenreChips";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { useLongPress } from "@/lib/hooks/useLongPress";
import { useContinueReading } from "@/lib/continueReading";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

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
  readCount,
  totalChapters,
  isNew,
  unreadCount,
  onMarkRead,
  isSentToDiscord,
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
  readCount: number;
  totalChapters: number;
  isNew?: boolean;
  unreadCount?: number;
  onMarkRead?: () => void;
  isSentToDiscord?: boolean;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const { onTouchStart, onTouchEnd, onTouchMove } = useLongPress((pos) =>
    setMenu(pos)
  );
  const seriesHref = safeUrl(series.seriesUrl) || "#";
  const { trackChapter } = useContinueReading();

  return (
    <Card
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchMove={onTouchMove}
      className={cn(
        "group relative rounded-2xl border border-white/10 bg-white/5 transition-all hover:border-white/20 hover:shadow-lg hover:shadow-black/30",
        isRead && "opacity-50",
        "flex flex-row! gap-4 p-4"
      )}
      ref={
        isDeepMatch
          ? (el) => el?.scrollIntoView({ block: "center" })
          : undefined
      }
    >
      <a
        href={seriesHref}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0"
        title="Open series"
      >
        <Cover
          src={series.cover}
          alt={series.title}
          titleKey={series.titleKey}
          size="md"
          withRetry
        />
      </a>

      {/* Body */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="">
          <a
            href={seriesHref}
            target="_blank"
            rel="noopener noreferrer"
            className=""
            title="Open series"
          >
            <h3 className="text-[15px] font-semibold leading-snug truncate text-white group-hover:text-white/80 transition-colors">
              {decodeHtml(series.title)}
            </h3>
          </a>
        </div>

        {/* Badge row */}
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
          <SourceChip source={series.chapters[0]?.source} />
          <OriginFlag
            origin={series.origin}
            type={(series as unknown as { type?: string | null }).type}
          />
          <Badge
            variant="secondary"
            className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-white/10 text-white/80 border-0"
          >
            {series.chapters.length} ch
          </Badge>
          {isNew && (
            <span className="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md bg-white/10 text-white/80 border border-white/20">
              NEW
            </span>
          )}
          {isSentToDiscord && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-white/10 text-white/80 border border-white/20">
              <Check size={10} weight="bold" />
              Sent
            </span>
          )}
        </div>

        {/* Rating + genres */}
        <div className="flex items-center gap-2 mt-1.5">
          <RatingStars rating={series.rating} />
          <GenreChips genres={series.genres} />
        </div>

        {/* Per-source chapter chips */}
        <div className="flex gap-1.5 flex-wrap mt-1.5">
          {series.chapters.map((ch) => {
            const label = getChapterLabel(ch);
            if (label === "?") return null;
            const chHref = safeUrl(ch.chapterUrl || ch.url) || "#";
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
              <a
                key={ch.key}
                href={chHref}
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
                    chapterUrl:
                      chHref !== "#" ? chHref : ch.chapterUrl || ch.url,
                    seriesUrl: series.seriesUrl,
                    origin: series.origin,
                  })
                }
                title={`${ch.source} · Ch. ${label}${ch.sentAt ? ` · ${new Date(ch.sentAt).toLocaleDateString()}` : ""}`}
                className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-md transition-colors whitespace-nowrap ${chipColor}`}
              >
                <span className="capitalize">{ch.source}</span>
                Ch. {label}
              </a>
            );
          })}
          {series.chapters.every((c) => getChapterLabel(c) === "?") && (
            <a
              href={safeUrl(series.seriesUrl) || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-md bg-white/10 text-white/80 hover:bg-white/20 transition-colors whitespace-nowrap"
            >
              View Series
            </a>
          )}
        </div>

        {/* Synopsis */}
        {series.description && (
          <p className="text-[10px] leading-[1.4] text-white/50 line-clamp-2 mt-1.5">
            {decodeHtml(series.description)}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 mt-auto pt-3">
          <button
            onClick={onToggleRead}
            className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-white/5 text-white/70 hover:text-white hover:bg-white/10 transition-colors"
          >
            {isRead ? <Check size={13} weight="bold" /> : null}
            {isRead ? "Read" : "Mark read"}
          </button>
          {!isWhitelisted &&
            (isExcluded ? (
              <button
                onClick={onExclude}
                disabled={excluding}
                title="Remove from excluded (show again in feed)"
                className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-white/5 text-white/70 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Eye size={13} weight="bold" />
                {excluding ? "..." : "Show"}
              </button>
            ) : (
              <button
                onClick={onExclude}
                disabled={excluding}
                title="Exclude this title from the RSS feed permanently"
                className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-white/5 text-white/70 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <EyeSlash size={13} weight="bold" />
                {excluding ? "..." : "Exclude"}
              </button>
            ))}
          {isWhitelisted ? (
            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-green-500/15 text-green-400 border border-green-500/20 font-medium ml-auto">
              <CheckCircle size={13} weight="fill" />
              Verified
            </span>
          ) : (
            <button
              onClick={onAdd}
              disabled={adding}
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
            >
              <Plus size={13} weight="bold" />
              {adding ? "..." : "Add WL"}
            </button>
          )}
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: isRead ? "Mark as unread" : "Mark as read",
              onClick: onToggleRead,
            },
            {
              label: isPinned ? "Unpin" : "Pin to top",
              onClick: () => onTogglePin?.(),
            },
          ]}
        />
      )}
    </Card>
  );
}

export default memo(GroupedSeriesCard);
