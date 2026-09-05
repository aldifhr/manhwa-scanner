"use client";

import { useState, memo } from "react";
import { safeUrl } from "@/lib/utils";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { useLongPress } from "@/lib/hooks/useLongPress";
import { useContinueReading } from "@/lib/continueReading";
import { useReadItems } from "./useReadItems";
import {
  SeriesShell,
  SeriesTitle,
  GroupedBadgeRow,
  RatingRow,
  Synopsis,
  CardActions,
  ChapterChips,
} from "./seriesShared";

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
  const { readItems, toggleRead } = useReadItems();

  return (
    <>
      <SeriesShell
        cover={series.cover}
        title={series.title}
        titleKey={series.titleKey}
        seriesUrl={seriesHref}
        isRead={isRead}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchMove={onTouchMove}
        className={
          isDeepMatch
            ? "ring-2 ring-[var(--gold-accent)] ring-offset-2 ring-offset-black"
            : undefined
        }
      >
        <SeriesTitle title={series.title} seriesUrl={seriesHref} />
        <GroupedBadgeRow
          source={series.chapters[0]?.source}
          origin={series.origin}
          type={(series as unknown as { type?: string | null }).type}
          count={series.chapters.length}
          isNew={isNew}
          isSent={isSentToDiscord}
        />
        <RatingRow rating={series.rating} genres={series.genres} />
        <ChapterChips
          chapters={series.chapters}
          seriesTitle={series.title}
          seriesTitleKey={series.titleKey}
          seriesCover={series.cover}
          seriesUrl={series.seriesUrl}
          origin={series.origin}
          trackChapter={trackChapter}
          readUrls={readItems}
          onToggleRead={toggleRead}
        />
        <Synopsis text={series.description} />
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

export default memo(GroupedSeriesCard);
