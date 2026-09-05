"use client";

import React from "react";

interface SkeletonGridProps {
  count?: number;
  variant?: "grid-item" | "list-item" | "group-item";
  hideHeader?: boolean;
}

export const SkeletonGrid = ({
  count = 8,
  variant = "list-item",
  hideHeader = false,
}: SkeletonGridProps) => {
  if (variant === "grid-item") {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className="rounded-2xl border border-[var(--gold-border)] bg-[var(--gold-surface)] p-3 space-y-2"
          >
            <div className="relative w-full aspect-2/3 rounded-lg overflow-hidden">
              <div className="skeleton absolute inset-0 rounded-lg" />
            </div>
            <div className="skeleton h-4 w-3/4 rounded" />
            <div className="skeleton h-2.5 w-16 rounded" />
            <div className="flex items-center gap-1.5">
              <div className="skeleton h-4 w-12 rounded-md" />
              <div className="skeleton h-4 w-10 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (variant === "group-item") {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className="flex gap-4 p-4 rounded-2xl border border-[var(--gold-border)] bg-[var(--gold-surface)]"
          >
            <div className="relative shrink-0 w-20 h-28 rounded-lg overflow-hidden">
              <div className="skeleton absolute inset-0 rounded-lg" />
            </div>
            <div className="flex-1 min-w-0 flex flex-col gap-2">
              <div className="skeleton h-4 w-2/3 rounded" />
              <div className="skeleton h-2.5 w-20 rounded" />
              <div className="flex items-center gap-1.5 mt-1">
                <div className="skeleton h-5 w-12 rounded-md" />
                <div className="skeleton h-5 w-10 rounded-md" />
                <div className="skeleton h-5 w-16 rounded-md ml-auto" />
              </div>
              <div className="flex items-center gap-2 mt-1.5">
                <div className="flex-1 h-1.5 rounded-full overflow-hidden">
                  <div className="skeleton h-full w-1/3 rounded-full" />
                </div>
                <div className="skeleton h-3 w-8 rounded" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {!hideHeader && <div className="skeleton h-7 w-44 rounded" />}
      <div className="flex flex-col gap-3">
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className="flex items-start gap-4 p-4 rounded-2xl border border-[var(--gold-border)] bg-[var(--gold-surface)]"
          >
            <div className="relative shrink-0 w-20 h-28 rounded-lg overflow-hidden">
              <div className="skeleton absolute inset-0 rounded-lg" />
            </div>

            <div className="flex-1 min-w-0 flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <div className="skeleton h-4 w-3/4 rounded" />
                <div className="skeleton h-2.5 w-16 rounded" />
              </div>

              <div className="flex items-center gap-1.5 mt-1">
                <div className="skeleton h-4 w-14 rounded-md" />
                <div className="skeleton h-4 w-10 rounded-md" />
                <div className="skeleton h-4 w-10 rounded-md" />
                <div className="skeleton h-2.5 w-10 rounded" />
              </div>

              <div className="skeleton h-3 w-full rounded mt-1" />
              <div className="skeleton h-3 w-2/3 rounded" />

              <div className="flex items-center gap-2 mt-auto pt-2">
                <div className="skeleton h-7 w-20 rounded-lg" />
                <div className="skeleton h-7 w-16 rounded-lg ml-auto" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
