"use client";

import { BookOpen } from "@phosphor-icons/react";

import { useContinueReading } from "@/lib/continueReading";
import type { ContinueReadingEntry } from "@/lib/continueReading";
import { decodeHtml, getChapterLabel, rewriteCoverUrl } from "@/lib/utils";
import { motion } from "framer-motion";

function CoverImage({ src, alt }: { src: string | null; alt: string }) {
  if (!src) {
    return (
      <div className="w-full aspect-3/4 rounded-xl cover-placeholder flex items-center justify-center bg-surface border border-white/6">
        <BookOpen size={24} className="text-white/30" />
      </div>
    );
  }
  return (
    <img
      src={rewriteCoverUrl(src) || src}
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
        : s === "komiku"
          ? "bg-purple-500/15 text-purple-400 border-purple-500/20"
          : "bg-white/10 text-white/80 border-white/10";
  return (
    <span
      className={`text-[10px] font-semibold px-2.5 py-1 rounded-full capitalize backdrop-blur-md border shadow-sm ${cls}`}
    >
      {source}
    </span>
  );
}

function ContinueReadingCard({ entry, onRemove }: { entry: ContinueReadingEntry; onRemove?: () => void }) {
  const label = getChapterLabel({ chapterLabel: entry.lastChapter });
  const displayLabel = label === "?" ? entry.lastChapter : label;
  return (
    <div className="group shrink-0 w-36 sm:w-44 relative">
      {onRemove && (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
          aria-label="Remove"
          className="absolute -right-1 -top-1 z-10 w-6 h-6 rounded-full bg-black/70 border border-white/15 text-white/70 hover:text-white hover:bg-black/90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        >
          ×
        </button>
      )}
