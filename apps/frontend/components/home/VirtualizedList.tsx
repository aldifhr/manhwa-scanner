import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWindowVirtualizer, useVirtualizer } from "@tanstack/react-virtual";

interface VirtualizedListProps<T> {
  items: T[];
  gap?: number;
  estimateSize?: number;
  /** Intentional overscan: extra rows beyond viewport to avoid flash */
  overscan?: number;
  chunkSize?: number;
  scrollToTitleKey?: string | null;
  titleKeyOf?: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** window = document scroll (homepage), element = container scroll (e.g. modal) */
  scrollMode?: "window" | "element";
  /** Snapshot to restore scroll position from (e.g. localStorage) */
  initialScrollOffset?: number;
}

export default function VirtualizedList<T>({
  items,
  gap = 12,
  estimateSize = 150,
  overscan = 5,
  chunkSize = 1,
  scrollToTitleKey,
  titleKeyOf,
  renderItem,
  scrollMode = "window",
  initialScrollOffset,
}: VirtualizedListProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
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

  // Window virtualizer (default) — scroll surface is document, product UI owns container markup
  const windowVirtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => estimateSize,
    overscan,
    gap,
    scrollMargin,
    enabled: scrollMode === "window",
    initialOffset: initialScrollOffset,
  });

  // Element virtualizer — when scrollMode="element", scroll container is owned by product UI
  const elementVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan,
    gap,
    enabled: scrollMode === "element",
    initialOffset: initialScrollOffset,
  });

  const virtualizer = scrollMode === "element" ? elementVirtualizer : windowVirtualizer;

  // Dynamic measurement: content height unknown until rendered (cover + text)
  const measureRef = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      queueMicrotask(() => {
        try {
          virtualizer.measureElement(el);
        } catch {}
      });
    },
    [virtualizer]
  );

  // Stable anchors for prepends/streaming: keep first visible index anchored
  const anchorIndexRef = useRef<number | null>(null);
  useEffect(() => {
    const onScroll = () => {
      const first = virtualizer.getVirtualItems()[0];
      if (first) anchorIndexRef.current = first.index;
    };
    if (scrollMode === "window") window.addEventListener("scroll", onScroll, { passive: true });
    else scrollRef.current?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      scrollRef.current?.removeEventListener("scroll", onScroll);
    };
  }, [virtualizer, scrollMode]);

  // When items prepend (new chapters stream at top), restore anchor instead of jumping
  const prevLenRef = useRef(items.length);
  useEffect(() => {
    if (items.length > prevLenRef.current && anchorIndexRef.current !== null) {
      const delta = items.length - prevLenRef.current;
      const anchor = anchorIndexRef.current + delta;
      virtualizer.scrollToIndex(anchor, { align: "start" });
    }
    prevLenRef.current = items.length;
  }, [items.length, virtualizer]);

  // Deep-link & snapshot restore: scroll matching row into view (virtual rows not in DOM)
  useEffect(() => {
    if (scrollToTitleKey && titleKeyOf) {
      const idx = items.findIndex((it) => titleKeyOf(it).toLowerCase() === scrollToTitleKey.toLowerCase());
      if (idx !== -1) {
        const rowIndex = effectiveChunk <= 1 ? idx : Math.floor(idx / effectiveChunk);
        const t = setTimeout(() => virtualizer.scrollToIndex(rowIndex, { align: "center" }), 300);
        return () => clearTimeout(t);
      }
    }
    if (initialScrollOffset !== undefined && initialScrollOffset > 0) {
      virtualizer.scrollToOffset(initialScrollOffset);
    }
  }, [scrollToTitleKey, items, effectiveChunk, titleKeyOf, virtualizer, initialScrollOffset]);

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // Product UI owns scroll surface & markup — virtualizer only positions
  if (scrollMode === "element") {
    return (
      <div ref={scrollRef} className="overflow-auto" style={{ height: "70vh" }}>
        <div ref={containerRef} className="relative" style={{ height: `${totalSize}px` }}>
          {virtualItems.map((vi) => {
            const rowItems = rows[vi.index] ?? [];
            return (
              <div key={vi.key} data-index={vi.index} ref={measureRef} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${vi.start}px)` }}>
                {effectiveChunk <= 1 ? renderItem(rowItems[0], vi.index) : (
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
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative" style={{ height: `${totalSize}px` }}>
      {virtualItems.map((vi) => {
        const rowItems = rows[vi.index] ?? [];
        return (
          <div key={vi.key} data-index={vi.index} ref={measureRef} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${vi.start - scrollMargin}px)` }}>
            {effectiveChunk <= 1 ? renderItem(rowItems[0], vi.index) : (
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
