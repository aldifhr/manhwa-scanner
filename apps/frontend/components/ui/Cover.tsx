"use client";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { rewriteCoverUrl, decodeHtml } from "@/lib/utils";
import { BookOpen } from "@phosphor-icons/react";

interface CoverProps {
  src: string | null | undefined;
  alt: string;
  titleKey?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
  withRetry?: boolean; // shinigami fallback via /api/reader/cover?series=
}

const sizeClass: Record<NonNullable<CoverProps["size"]>, string> = {
  sm: "w-16 sm:w-20 h-24 sm:h-28",
  md: "w-20 h-28",
  lg: "w-full aspect-3/4",
};

export function Cover({
  src,
  alt,
  titleKey,
  size = "md",
  className,
  withRetry = false,
}: CoverProps) {
  const [imgError, setImgError] = useState(false);
  const [hasRetried, setHasRetried] = useState(false);
  const [coverSrc, setCoverSrc] = useState(() => rewriteCoverUrl(src));
  const [imgLoaded, setImgLoaded] = useState(false);

  useEffect(() => {
    setCoverSrc(rewriteCoverUrl(src));
    setImgError(false);
    setHasRetried(false);
    setImgLoaded(false);
  }, [src]);

  if (!src || imgError) {
    return (
      <div
        className={cn(
          sizeClass[size],
          "rounded-lg bg-[var(--gold-surface)] ring-1 ring-[var(--gold-border)] flex items-center justify-center",
          className
        )}
      >
        <BookOpen size={22} className="text-white/25" />
      </div>
    );
  }

  return (
    <img
      src={coverSrc || ""}
      alt={decodeHtml(alt)}
      loading="lazy"
      decoding="async"
      fetchPriority="low"
      onError={() => {
        if (withRetry && !hasRetried && titleKey) {
          setCoverSrc(
            `/api/reader/cover?series=${encodeURIComponent(titleKey)}`
          );
          setHasRetried(true);
        } else setImgError(true);
      }}
      onLoad={() => setImgLoaded(true)}
      className={cn(
        sizeClass[size],
        "object-cover rounded-lg bg-[var(--gold-surface)] ring-1 ring-[var(--gold-border)] transition-all duration-500",
        imgLoaded ? "blur-0 scale-100" : "blur-md scale-105",
        "group-hover:scale-[1.02]",
        className
      )}
    />
  );
}
