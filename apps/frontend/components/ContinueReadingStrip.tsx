"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { BookOpen } from "@phosphor-icons/react";
import { useContinueReading } from "@/lib/continueReading";
import { decodeHtml } from "@/lib/utils";
import { PageShell } from "@/components/PageShell";

function CoverImage({ src, alt }: { src: string | null; alt: string }) {
  if (!src) {
    return (
      <div className="w-full aspect-3/4 rounded-xl flex items-center justify-center bg-white/5 border border-white/10">
        <span className="text-white/30 text-xs tracking-wide">No cover</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className="w-full aspect-3/4 object-cover bg-white/5 group-hover:scale-[1.03] transition-transform duration-500"
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
  entry: ReturnType<typeof useContinueReading>["entries"] extends Map<string, infer V> ? V : never;
  onRemove?: (titleKey: string) => void;
}) {
  return (
    <div className="group shrink-0 w-36 sm:w-44 relative">
      <a href={entry.chapterUrl} target="_blank" rel="noopener noreferrer" className="block">
        <div className="relative overflow-hidden rounded-xl card-hover border border-white/10 hover:border-white/15 bg-white/5">
          <CoverImage src={entry.cover} alt={decodeHtml(entry.title)} />
          <div className="absolute inset-0 bg-linear-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
          <div className="absolute top-2.5 left-2.5">
            <SourcePill source={entry.source} />
          </div>
          <div className="absolute bottom-0 left-0 right-0 bg-linear-to-t from-black via-black/70 to-transparent pt-6 p-2.5">
            <p className="text-[11px] font-bold tracking-wide text-white">Ch. {entry.lastChapter}</p>
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

export function ContinueReadingStrip() {
  const { entries, removeReading, clearAll } = useContinueReading();
  const sorted = useMemo(
    () =>
      [...entries.values()]
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 10),
    [entries]
  );
  if (entries.size === 0) return null;
  return (
    <PageShell>
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-4">
        <BookOpen size={18} className="text-white" weight="fill" />
        <h2 className="text-lg sm:text-xl font-bold text-white">Continue Reading</h2>
        <span className="text-xs text-white/50">({entries.size})</span>
        <button
          onClick={clearAll}
          className="ml-auto text-[11px] px-2.5 py-1 rounded-lg bg-white/5 text-white/60 hover:text-white hover:bg-white/10 transition-colors"
        >
          Clear all
        </button>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide snap-x snap-mandatory">
        {sorted.map((entry, i) => (
          <motion.div key={entry.titleKey} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04, duration: 0.25 }}>
            <ContinueReadingCard entry={entry} onRemove={removeReading} />
          </motion.div>
        ))}
      </div>
      </div>
    </PageShell>
  );
}
