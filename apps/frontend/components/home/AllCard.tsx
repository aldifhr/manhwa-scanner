"use client";

import { useState } from "react";
import { safeUrl, getChapterLabel } from "@/lib/utils";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { useLongPress } from "@/lib/hooks/useLongPress";
import { useContinueReading } from "@/lib/continueReading";
import {
  SeriesShell,
  SeriesTitle,
  FlatBadgeRow,
  RatingRow,
  Synopsis,
  CardActions,
} from "./seriesShared";

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

  const lbl = getChapterLabel(item);
  return (
    <>
      <SeriesShell
        cover={item.cover}
        title={item.title}
        titleKey={item.titleKey}
        seriesUrl={seriesHref}
        isRead={isRead}
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
        ariaLabel={
          chapterHref !== "#"
            ? `Open chapter ${lbl} of ${item.title}`
            : undefined
        }
        titleAttr="Click to open chapter"
      >
        <SeriesTitle title={item.title} seriesUrl={seriesHref} />
        <FlatBadgeRow
          source={item.source}
          origin={item.origin}
          type={item.type}
          chapterLabel={lbl}
          isNew={isNew}
          isSent={isSentToDiscord}
          createdAt={item.createdAt}
        />
        <RatingRow rating={item.rating} genres={item.genres} />
        <Synopsis text={item.description} />
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
    </>
  );
}

export default AllCard;
