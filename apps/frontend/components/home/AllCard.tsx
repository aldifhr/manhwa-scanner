"use client";

import { useState } from "react";
import { safeUrl, getChapterLabel } from "@/lib/utils";
import { decodeHtml } from "@/lib/utils";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { useLongPress } from "@/lib/hooks/useLongPress";
import { useContinueReading } from "@/lib/continueReading";
import { normalizeOrigin, getOriginFlag } from "@/lib/constants";
import { SeriesShell, Synopsis, CardActions, RatingRow } from "./seriesShared";

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
  const { onTouchStart, onTouchEnd, onTouchMove, wasLongPressed } = useLongPress((pos) => setMenu(pos));
  const { trackChapter } = useContinueReading();
  const origin = normalizeOrigin(item.origin);
  const t = (item.type || "").toLowerCase().trim();
  const flag = t === "manhwa" || t === "manhua" ? getOriginFlag(origin) : "";
  const lbl = getChapterLabel(item);
  const doTrack = () => {
    trackChapter({
      title: item.title,
      titleKey: item.titleKey,
      cover: item.cover,
      source: item.source,
      chapter: item.chapter,
      chapterLabel: item.chapterLabel,
      chapterNumber: item.chapterNumber,
      chapterUrl: chapterHref !== "#" ? chapterHref : item.chapterUrl || item.url,
      seriesUrl: item.seriesUrl,
      origin: item.origin,
    });
  };
  const openChapter = (e?: React.SyntheticEvent) => {
    if (wasLongPressed()) { e?.preventDefault(); return; }
    if (chapterHref !== "#") { doTrack(); window.open(chapterHref, "_blank", "noopener,noreferrer"); }
  };
  const src = item.source?.toLowerCase();
  const chipColor =
    src === "shinigami"
      ? "bg-red-500/15 text-red-400 hover:bg-red-500/25 border-red-500/20"
      : src === "ikiru"
        ? "bg-green-500/15 text-green-400 hover:bg-green-500/25 border-green-500/20"
        : src === "voratoon"
          ? "bg-orange-500/15 text-orange-400 hover:bg-orange-500/25 border-orange-500/20"
          : "bg-white/10 text-white/80 hover:bg-white/20 border-white/8";

  return (
    <>
      <SeriesShell
        cover={item.cover}
        title={item.title}
        titleKey={item.titleKey}
        seriesUrl={seriesHref}
        isRead={isRead}
        overlaySource={item.source}
        overlayLabel={null}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchMove={onTouchMove}
        onClick={openChapter}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (chapterHref !== "#") { doTrack(); window.open(chapterHref, "_blank", "noopener,noreferrer"); }
          }
        }}
        role={chapterHref !== "#" ? "link" : undefined}
        tabIndex={chapterHref !== "#" ? 0 : undefined}
        ariaLabel={chapterHref !== "#" ? `Open chapter ${lbl} of ${item.title}` : undefined}
        titleAttr="Click to open chapter"
      >
        <div className="flex min-w-0 items-start gap-2">
          {flag && <img src={flag} alt={origin} className="mt-0.5 h-4 w-4 shrink-0" loading="lazy" />}
          <a href={seriesHref} target="_blank" rel="noopener noreferrer" className="block min-h-0 min-w-0 flex-1 rounded focus-visible:ring-2 focus-visible:ring-white">
            <h3 className="line-clamp-2 text-[15px] font-semibold leading-tight text-white transition-colors group-hover:text-white/80 sm:text-base">
              {decodeHtml(item.title)}
            </h3>
          </a>
        </div>

        <RatingRow rating={item.rating} genres={item.genres} />

        <Synopsis text={item.description} />

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
          {lbl !== "?" ? (
            <a
              href={chapterHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={doTrack}
              className={`inline-flex min-h-0 min-w-0 items-center justify-center rounded-md border px-2 py-1 text-[11px] leading-none transition-colors ${chipColor}`}
            >
              Ch. {lbl}
            </a>
          ) : (
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
          showRead={showReadButton}
          showAdd={showAddButton}
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

export default AllCard;
