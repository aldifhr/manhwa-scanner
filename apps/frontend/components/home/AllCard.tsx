"use client";

import { useState } from "react";
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
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useContinueReading } from "@/lib/continueReading";

interface AllCardItem {
  title: string;
  titleKey: string;
  chapter: string;
  chapterLabel: string;
  chapterNumber: number;
  url: string;
  chapterUrl: string;
  source: string;
  cover: string;
  origin: string;
  type?: string | null;
  seriesUrl: string;
  rating?: string | number | null;
  genres?: string[];
  createdAt: string;
  sentAt: string;
  description?: string | null;
}

function AllCard({
  item,
  isRead,
  isWhitelisted,
  adding,
  onToggleRead,
  onAdd,
  isExcluded,
  excluding,
  onExclude,
  isPinned = false,
  onTogglePin,
  showReadButton = true,
  showAddButton = true,
  isNew = false,
  isSentToDiscord = false,
}: {
  item: AllCardItem;
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
  showReadButton?: boolean;
  showAddButton?: boolean;
  isNew?: boolean;
  isSentToDiscord?: boolean;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const seriesHref = safeUrl(item.seriesUrl || item.url) || "#";
  const chapterHref = safeUrl(item.chapterUrl || item.url) || "#";
  const { onTouchStart, onTouchEnd, onTouchMove, wasLongPressed } =
    useLongPress((pos) => setMenu(pos));
  const { trackChapter } = useContinueReading();

  const doTrack = () => {
    trackChapter({
      title: item.title,
      titleKey: item.titleKey,
      cover: item.cover,
      source: item.source,
      chapter: item.chapter,
      chapterLabel: item.chapterLabel,
      chapterNumber: item.chapterNumber,
      chapterUrl:
        chapterHref !== "#" ? chapterHref : item.chapterUrl || item.url,
      seriesUrl: item.seriesUrl,
      origin: item.origin,
    });
  };

  const openChapter = (e?: React.SyntheticEvent) => {
    if (wasLongPressed()) {
      e?.preventDefault();
      return;
    }
    if (chapterHref !== "#") {
      doTrack();
      window.open(chapterHref, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <Card
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchMove={onTouchMove}
      onClick={openChapter}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (chapterHref !== "#") {
            doTrack();
            window.open(chapterHref, "_blank", "noopener,noreferrer");
          }
        }
      }}
      role={chapterHref !== "#" ? "link" : undefined}
      tabIndex={chapterHref !== "#" ? 0 : undefined}
      aria-label={
        chapterHref !== "#"
          ? `Open chapter ${getChapterLabel(item)} of ${item.title}`
          : undefined
      }
      title="Click to open chapter"
      className={cn(
        "group relative rounded-2xl border border-white/10 bg-white/5 transition-all hover:border-white/20 hover:shadow-lg hover:shadow-black/30",
        isRead && "opacity-50",
        "flex flex-row! gap-4 p-4"
      )}
    >
      <a
        href={seriesHref}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 focus-visible:ring-2 focus-visible:ring-accent rounded-lg"
        title="Open series"
        onClick={(e) => e.stopPropagation()}
      >
        <Cover src={item.cover} alt={item.title} size="md" />
      </a>

      {/* Body */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="">
          <a
            href={seriesHref}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-visible:ring-2 focus-visible:ring-accent rounded"
            title="Open series"
          >
            <h3 className="text-[15px] font-semibold leading-snug truncate text-white group-hover:text-white/80 transition-colors">
              {decodeHtml(item.title)}
            </h3>
          </a>
        </div>

        {/* Badge row */}
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
          <SourceChip source={item.source} />
          {item.type && <OriginFlag origin={item.origin} />}
          {(() => {
            const lbl = getChapterLabel(item);
            return lbl === "?" ? null : (
              <Badge
                variant="secondary"
                className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-white/10 text-white/80 border-0"
              >
                Ch. {lbl}
              </Badge>
            );
          })()}
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
          {item.createdAt && (
            <span className="text-[10px] text-white/40">
              {new Date(item.createdAt).toLocaleDateString()}
            </span>
          )}
        </div>

        {/* Rating + genres */}
        <div className="flex items-center gap-2 mt-1.5">
          <RatingStars rating={item.rating} />
          <GenreChips genres={item.genres} />
        </div>

        {/* Synopsis */}
        {item.description && (
          <p className="text-[10px] leading-[1.4] text-white/50 line-clamp-2 mt-1.5">
            {decodeHtml(item.description)}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 mt-auto pt-3">
          {showReadButton && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleRead();
              }}
              aria-pressed={isRead}
              aria-label={isRead ? "Mark as unread" : "Mark as read"}
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-white/5 text-white/70 hover:text-white hover:bg-white/10 transition-colors focus-visible:ring-2 focus-visible:ring-accent"
            >
              {isRead ? <Check size={13} weight="bold" /> : null}
              {isRead ? "Read" : "Mark read"}
            </button>
          )}
          {!isWhitelisted &&
            (isExcluded ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onExclude();
                }}
                disabled={excluding}
                title="Remove from excluded (show again in feed)"
                className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-white/5 text-white/70 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Eye size={13} weight="bold" />
                {excluding ? "..." : "Show"}
              </button>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onExclude();
                }}
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
            showAddButton && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onAdd();
                }}
                disabled={adding}
                className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
              >
                <Plus size={13} weight="bold" />
                {adding ? "..." : "Add WL"}
              </button>
            )
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

export default AllCard;
