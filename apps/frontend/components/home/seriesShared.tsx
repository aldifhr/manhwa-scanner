"use client";
import { cn, safeUrl } from "@/lib/utils";
import { decodeHtml } from "@/lib/utils";
import { Check, Eye, EyeSlash, CheckCircle, Plus } from "@phosphor-icons/react";
import { Cover } from "@/components/ui/Cover";
import { RatingStars } from "@/components/ui/RatingStars";
import { OriginFlag } from "@/components/ui/OriginFlag";
import { SourceChip } from "@/components/ui/SourceChip";
import { GenreChips } from "@/components/ui/GenreChips";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getChapterLabel } from "@/lib/utils";

// ── Shell — single seam for all series cards ──
export function SeriesShell({
  cover,
  title,
  titleKey,
  seriesUrl,
  isRead,
  children,
  onTouchStart,
  onTouchEnd,
  onTouchMove,
  onClick,
  onKeyDown,
  role,
  tabIndex,
  ariaLabel,
  titleAttr,
  className,
}: {
  cover: string;
  title: string;
  titleKey?: string;
  seriesUrl: string;
  isRead?: boolean;
  children: React.ReactNode;
  onTouchStart?: React.TouchEventHandler;
  onTouchEnd?: React.TouchEventHandler;
  onTouchMove?: React.TouchEventHandler;
  onClick?: React.MouseEventHandler;
  onKeyDown?: React.KeyboardEventHandler;
  role?: string;
  tabIndex?: number;
  ariaLabel?: string;
  titleAttr?: string;
  className?: string;
}) {
  const href = safeUrl(seriesUrl) || "#";
  return (
    <Card
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchMove={onTouchMove}
      onClick={onClick}
      onKeyDown={onKeyDown}
      role={role}
      tabIndex={tabIndex}
      aria-label={ariaLabel}
      title={titleAttr}
      className={cn(
        "group relative rounded-2xl border border-[var(--gold-border)] bg-[var(--gold-surface)] transition-all hover:border-[var(--gold-border-hover)] hover:bg-[var(--gold-surface-hover)] hover:-translate-y-[1px] hover:shadow-[0_10px_28px_-16px_rgba(0,0,0,0.6)]",
        isRead && "opacity-50",
        "flex flex-row! gap-3 sm:gap-4 p-3 sm:p-4",
        className
      )}
    >
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 focus-visible:ring-2 focus-visible:ring-[var(--gold-accent)] rounded-lg"
        title="Open series"
        onClick={(e) => onClick && e.stopPropagation()}
      >
        <Cover
          src={cover}
          alt={title}
          titleKey={titleKey}
          size="md"
          withRetry
        />
      </a>
      <div className="flex-1 min-w-0 flex flex-col">{children}</div>
    </Card>
  );
}

export function SeriesTitle({
  title,
  seriesUrl,
}: {
  title: string;
  seriesUrl: string;
}) {
  const href = safeUrl(seriesUrl) || "#";
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block focus-visible:ring-2 focus-visible:ring-[var(--gold-accent)] rounded"
      title="Open series"
    >
      <h3
        className="text-[14px] sm:text-[15px] font-semibold leading-snug truncate text-white group-hover:text-white/80 transition-colors"
        style={{ fontFamily: '"Space Grotesk", var(--font-sans)' }}
      >
        {decodeHtml(title)}
      </h3>
    </a>
  );
}

export function FlatBadgeRow({
  source,
  origin,
  type,
  chapterLabel,
  isNew,
  isSent,
  createdAt,
}: {
  source: string;
  origin: string;
  type?: string | null;
  chapterLabel: string;
  isNew?: boolean;
  isSent?: boolean;
  createdAt?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      <SourceChip source={source} />
      <OriginFlag origin={origin} type={type} />
      {chapterLabel !== "?" ? (
        <Badge
          variant="secondary"
          className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/10 text-white/80 border border-[var(--gold-border)]"
        >
          Ch. {chapterLabel}
        </Badge>
      ) : null}
      {isNew && (
        <span className="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full bg-[var(--gold-accent-soft)] text-[var(--gold-accent)] border border-[var(--gold-accent-soft)]">
          NEW
        </span>
      )}
      {isSent && (
        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/5 text-white/70 border border-[var(--gold-border)]">
          <Check size={10} weight="bold" /> Sent
        </span>
      )}
      {createdAt && (
        <span className="text-[10px] text-white/40 tabular-nums">
          {new Date(createdAt).toLocaleDateString()}
        </span>
      )}
    </div>
  );
}

export function GroupedBadgeRow({
  source,
  origin,
  type,
  count,
  isNew,
  isSent,
}: {
  source?: string;
  origin: string;
  type?: string | null;
  count: number;
  isNew?: boolean;
  isSent?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      <SourceChip source={source ?? ""} />
      <OriginFlag origin={origin} type={type} />
      <Badge
        variant="secondary"
        className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/10 text-white/80 border border-[var(--gold-border)]"
      >
        {count} ch
      </Badge>
      {isNew && (
        <span className="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full bg-[var(--gold-accent-soft)] text-[var(--gold-accent)] border border-[var(--gold-accent-soft)]">
          NEW
        </span>
      )}
      {isSent && (
        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/5 text-white/70 border border-[var(--gold-border)]">
          <Check size={10} weight="bold" /> Sent
        </span>
      )}
    </div>
  );
}

export function RatingRow({
  rating,
  genres,
}: {
  rating?: string | number | null;
  genres?: string[];
}) {
  return (
    <div className="flex items-center gap-2 mt-1.5">
      <RatingStars rating={rating} />
      <GenreChips genres={genres} />
    </div>
  );
}

export function Synopsis({ text }: { text?: string | null }) {
  if (!text) return null;
  return (
    <p className="text-[11px] leading-[1.45] text-white/55 line-clamp-2 mt-1.5">
      {decodeHtml(text)}
    </p>
  );
}

export function CardActions({
  isWhitelisted,
  isExcluded,
  excluding,
  onExclude,
  adding,
  onAdd,
  isRead,
  onToggleRead,
  showRead = true,
  showAdd = true,
}: {
  isWhitelisted: boolean;
  isExcluded: boolean;
  excluding: boolean;
  onExclude: () => void;
  adding: boolean;
  onAdd: () => void;
  isRead?: boolean;
  onToggleRead?: () => void;
  showRead?: boolean;
  showAdd?: boolean;
}) {
  // ponytail: adminOnly gate for Add WL — member/anon cuma bookmark, keep hook inside component for SSR safety
  const isAdmin =
    typeof document !== "undefined" &&
    (() => {
      const m = document.cookie.match(
        /(?:^|;\s*)ikiru_dashboard_session=([^;]*)/
      );
      if (!m?.[1]) return false;
      try {
        const p = JSON.parse(
          atob(m[1].split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))
        );
        return p?.role === "admin";
      } catch {
        return false;
      }
    })();
  const showAddEff = showAdd && isAdmin;
  const showExcludeEff = !isWhitelisted && isAdmin;
  return (
    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 mt-auto pt-3">
      {showRead && onToggleRead && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleRead();
          }}
          aria-pressed={isRead}
          className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-white/5 border border-[var(--gold-border)] text-white/70 hover:text-white hover:bg-white/10 transition-colors min-h-0 min-w-0"
        >
          {isRead ? <Check size={13} weight="bold" /> : null}
          {isRead ? "Read" : "Mark read"}
        </button>
      )}
      {showExcludeEff &&
        (isExcluded ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onExclude();
            }}
            disabled={excluding}
            title="Remove from excluded"
            className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-white/5 border border-[var(--gold-border)] text-white/60 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-50 min-h-0 min-w-0"
          >
            <Eye size={13} weight="bold" /> {excluding ? "..." : "Show"}
          </button>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onExclude();
            }}
            disabled={excluding}
            title="Exclude this title"
            className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-white/5 border border-[var(--gold-border)] text-white/60 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-50 min-h-0 min-w-0"
          >
            <EyeSlash size={13} weight="bold" /> {excluding ? "..." : "Exclude"}
          </button>
        ))}
      {isWhitelisted ? (
        <span className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-green-500/12 text-green-400 border border-green-500/20 font-medium ml-auto">
          <CheckCircle size={13} weight="fill" /> Verified
        </span>
      ) : (
        showAddEff && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
            disabled={adding}
            className="inline-flex items-center gap-1 text-[11px] px-3 py-1 rounded-full bg-[var(--gold-accent)] text-black hover:bg-[var(--gold-accent-hover)] font-semibold transition-colors disabled:opacity-50 ml-auto min-h-0 min-w-0 shadow-[0_2px_10px_var(--gold-accent-soft)]"
          >
            <Plus size={13} weight="bold" /> {adding ? "..." : "Add WL"}
          </button>
        )
      )}
    </div>
  );
}

export function ChapterChips({
  chapters,
  seriesTitle,
  seriesTitleKey,
  seriesCover,
  seriesUrl,
  origin,
  trackChapter,
  readUrls,
  onToggleRead,
}: {
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
  seriesTitle: string;
  seriesTitleKey: string;
  seriesCover: string;
  seriesUrl: string;
  origin: string;
  trackChapter: (e: any) => void;
  readUrls?: Set<string>;
  onToggleRead?: (url: string) => void;
}) {
  if (chapters.every((c) => getChapterLabel(c) === "?")) {
    return (
      <div className="flex gap-1.5 flex-wrap mt-1.5">
        <a
          href={safeUrl(seriesUrl) || "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-full bg-white/10 text-white/80 hover:bg-white/20 transition-colors whitespace-nowrap"
        >
          View Series
        </a>
      </div>
    );
  }
  return (
    <div className="flex gap-1.5 flex-wrap mt-1.5">
      {chapters.map((ch) => {
        const label = getChapterLabel(ch);
        if (label === "?") return null;
        const chHref = safeUrl(ch.chapterUrl || ch.url) || "#";
        const src = ch.source?.toLowerCase();
        const isRead = !!(
          readUrls &&
          (readUrls.has(ch.url) ||
            readUrls.has(ch.chapterUrl) ||
            readUrls.has(chHref))
        );
        const chipColor =
          src === "shinigami"
            ? "bg-red-500/15 text-red-400 hover:bg-red-500/25 border-red-500/20"
            : src === "ikiru"
              ? "bg-green-500/15 text-green-400 hover:bg-green-500/25 border-green-500/20"
              : src === "voratoon"
                ? "bg-orange-500/15 text-orange-400 hover:bg-orange-500/25 border-orange-500/20"
                : "bg-white/10 text-white/80 hover:bg-white/20 border-[var(--gold-border)]";
        return (
          <span key={ch.key} className="inline-flex items-center gap-1">
            <a
              href={chHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() =>
                trackChapter({
                  title: seriesTitle,
                  titleKey: seriesTitleKey,
                  cover: seriesCover,
                  source: ch.source,
                  chapter: ch.chapter,
                  chapterLabel: ch.chapterLabel,
                  chapterNumber: ch.chapterNumber,
                  chapterUrl: chHref !== "#" ? chHref : ch.chapterUrl || ch.url,
                  seriesUrl,
                  origin,
                })
              }
              title={`${ch.source} · Ch. ${label}${ch.sentAt ? ` · ${new Date(ch.sentAt).toLocaleDateString()}` : ""}`}
              className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-full border transition-colors whitespace-nowrap ${chipColor} ${isRead ? "opacity-50" : ""}`}
            >
              <span className="capitalize">{ch.source}</span> Ch. {label}{" "}
              {isRead ? "✓" : ""}
            </a>
            {onToggleRead && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleRead(
                    chHref !== "#" ? chHref : ch.chapterUrl || ch.url
                  );
                }}
                title={isRead ? "Mark unread" : "Mark read"}
                className={`inline-flex items-center justify-center w-6 h-6 rounded-full border text-[10px] ${isRead ? "bg-white/10 border-white/20 text-white/60 hover:bg-white/15" : "bg-white/5 border-[var(--gold-border)] text-white/40 hover:text-white hover:bg-white/10"}`}
              >
                {isRead ? <EyeSlash size={12} /> : <Eye size={12} />}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
