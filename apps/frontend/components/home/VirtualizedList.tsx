import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";

interface VirtualizedListProps<T> {
  items: T[];
  /** vertical gap between virtual rows, px */
  gap?: number;
  /** initial estimate for row height, px (real heights are measured) */
  estimateSize?: number;
  overscan?: number;
  /** chunk consecutive items into rows of this size (e.g. grid view) */
  chunkSize?: number;
  /** when set, scrolls the matching item into view on mount/update */
  scrollToTitleKey?: string | null;
  /** extract a key from an item for deep-link matching */
  titleKeyOf?: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
}

/**
 * Window-scroll virtualized list. Only the rows near the viewport are mounted,
 * so feeds with hundreds/thousands of chapter cards stay fast.
 *
 * The list sits BELOW a sticky filter bar, so its distance from the document
 * top grows as the user scrolls (sticky = constant viewport offset). We track
 * that offset (`scrollMargin`) and re-feed it to the virtualizer on scroll so
 * its coordinate space always matches real page positions.
 */
export default function VirtualizedList<T>({
  items,
  gap = 12,
  estimateSize = 150,
  overscan = 5,
  chunkSize = 1,
  scrollToTitleKey,
  titleKeyOf,
  renderItem,
}: VirtualizedListProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  // For grid views (chunkSize > 1) the CSS grid is responsive
  // (grid-cols-2 sm:grid-cols-3 lg:grid-cols-4) while chunkSize was fixed —
  // on small screens that made each virtual row hold 2 visual rows, wasting
  // virtualization granularity. Track the breakpoint and chunk accordingly.
  const [cols, setCols] = useState(2);
  useEffect(() => {
    if (chunkSize <= 1) return;
    const mq = window.matchMedia("(min-width: 640px)");
    const mqLg = window.matchMedia("(min-width: 1024px)");
    const update = () => setCols(mqLg.matches ? 4 : mq.matches ? 3 : 2);
    update();
    mq.addEventListener("change", update);
    mqLg.addEventListener("change", update);
    return () => {
      mq.removeEventListener("change", update);
      mqLg.removeEventListener("change", update);
    };
  }, [chunkSize]);

  const effectiveChunk = chunkSize > 1 ? cols : chunkSize;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const r = el.getBoundingClientRect();
        setScrollMargin(r.top + window.scrollY);
      });
    };
    update();
    window.addEventListener("resize", update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      ro.disconnect();
    };
  }, []);

  const rows = useMemo(() => {
    if (effectiveChunk <= 1) return items.map((it) => [it]);
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += effectiveChunk) {
      out.push(items.slice(i, i + effectiveChunk));
    }
    return out;
  }, [items, effectiveChunk]);

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => estimateSize,
    overscan,
    gap,
    scrollMargin,
  });

  // Deep-link: scroll the matching row into view. Off-screen rows aren't in the
  // DOM, so a DOM query (scrollIntoView) can't find them — scroll by index.
  useEffect(() => {
    if (!scrollToTitleKey || !titleKeyOf) return;
    const idx = items.findIndex(
      (it) => titleKeyOf(it).toLowerCase() === scrollToTitleKey.toLowerCase()
    );
    if (idx === -1) return;
    const rowIndex =
      effectiveChunk <= 1 ? idx : Math.floor(idx / effectiveChunk);
    const t = setTimeout(() => {
      virtualizer.scrollToIndex(rowIndex, { align: "center" });
    }, 300);
    return () => clearTimeout(t);
  }, [scrollToTitleKey, items, effectiveChunk, titleKeyOf, virtualizer]);

  return (
    <div
      ref={containerRef}
      className="relative"
      style={{ height: `${virtualizer.getTotalSize()}px` }}
    >
      {virtualizer.getVirtualItems().map((vi) => {
        const rowItems = rows[vi.index] ?? [];
        return (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${vi.start - scrollMargin}px)` }}
          >
            {effectiveChunk <= 1 ? (
              renderItem(rowItems[0], vi.index)
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {rowItems.map((it, k) => {
                  const realIndex = vi.index * effectiveChunk + k;
                  return <div key={realIndex}>{renderItem(it, realIndex)}</div>;
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
