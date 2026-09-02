// ── Shared In-Memory Image Cache ──────────────────────────────────────────
// Global pool used by proxy, image, and cover routes. Persists across HMR in
// dev via globalThis. Fresh entries served for 1h; stale entries served on
// fetch failure for up to 24h. Concurrent requests for the same key are
// coalesced so the upstream is hit once.
// ───────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CacheEntry {
  data: ArrayBuffer;
  contentType: string;
  timestamp: number;
}

export interface ResolvedResult {
  ok: boolean;
  status?: number;
  data?: ArrayBuffer;
  contentType?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const FRESH_TTL = 60 * 60 * 1000; // 1 hour
const STALE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Memory bounds: cap the pool by entry count AND total decoded bytes so a
// burst of unique cover/proxy URLs can't grow memory without limit. Eviction
// is oldest-first (entries carry a timestamp already). Re-fetch on next hit.
const MAX_ENTRIES = 2000;
const MAX_BYTES = 256 * 1024 * 1024; // 256 MiB

// ── Global pool ────────────────────────────────────────────────────────────

type CacheStore = Map<string, CacheEntry>;
type PendingStore = Map<string, Promise<ResolvedResult>>;

interface ByteCounter {
  bytes: number;
}

declare global {
  var __imgCache: CacheStore | undefined;
  var __imgPending: PendingStore | undefined;
  var __imgSweeper: boolean | undefined;
  var __imgCacheBytes: ByteCounter | undefined;
}

const cache: CacheStore = (globalThis.__imgCache ??= new Map());
const pending: PendingStore = (globalThis.__imgPending ??= new Map());
// Object reference (not a primitive) so the byte count survives HMR and stays
// in sync with the persisted cache Map on `globalThis`.
const cacheBytes = (globalThis.__imgCacheBytes ??= { bytes: 0 });

function evictUntilWithinBudget() {
  if (cache.size <= MAX_ENTRIES && cacheBytes.bytes <= MAX_BYTES) return;
  const ordered = [...cache.entries()].sort(
    (a, b) => a[1].timestamp - b[1].timestamp,
  );
  for (const [key, entry] of ordered) {
    if (cache.size <= MAX_ENTRIES && cacheBytes.bytes <= MAX_BYTES) break;
    cache.delete(key);
    cacheBytes.bytes -= entry.data.byteLength;
  }
}

// ── Sweeper (once per process) ─────────────────────────────────────────────

if (!globalThis.__imgSweeper) {
  globalThis.__imgSweeper = true;
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now - entry.timestamp > STALE_TTL) {
        cache.delete(key);
        cacheBytes.bytes -= entry.data.byteLength;
      }
    }
  }, 5 * 60 * 1000);
  // Don't keep process alive in tests/CLI — allow vitest to exit cleanly
  if (typeof (sweeper as unknown as { unref?: () => void }).unref === "function") {
    (sweeper as unknown as { unref: () => void }).unref();
  }
}

// ── Cache accessors ────────────────────────────────────────────────────────

/** Returns entry if still within the 1h fresh window. */
export function getFresh(key: string): CacheEntry | undefined {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < FRESH_TTL) return entry;
  return undefined;
}

/** Returns entry if still within the 24h stale window. */
export function getStale(key: string): CacheEntry | undefined {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < STALE_TTL) return entry;
  return undefined;
}

/** Stores a value in the cache with current timestamp. */
export function setCache(key: string, data: ArrayBuffer, contentType: string): void {
  const existing = cache.get(key);
  if (existing) cacheBytes.bytes -= existing.data.byteLength;
  cache.set(key, { data, contentType, timestamp: Date.now() });
  cacheBytes.bytes += data.byteLength;
  evictUntilWithinBudget();
}

// ── Request coalescing ─────────────────────────────────────────────────────

/**
 * Deduplicates concurrent fetches for the same key. The fetcher must return a
 * ResolvedResult. While the fetch is in-flight, all subsequent calls with the
 * same key await the same promise — the body stream is consumed exactly once.
 */
export function coalesceFetch(
  key: string,
  fetcher: () => Promise<ResolvedResult>,
): Promise<ResolvedResult> {
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const promise = fetcher().finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

// ── Response builders ──────────────────────────────────────────────────────

// Browser/CDN cache 24h (cover jarang ganti), s-maxage 24h biar Vercel/CDN tidak hit BE tiap reload.
// In-memory FRESH 1h tetap ada untuk absorb repeat server-side. Stale serve override max-age 60s.
const IMAGE_CACHE_CONTROL = "public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400";

export function cacheHitResponse(
  entry: CacheEntry,
  extraHeaders?: Record<string, string>,
) {
  return new NextResponse(entry.data, {
    headers: {
      "Content-Type": entry.contentType,
      "Cache-Control": IMAGE_CACHE_CONTROL,
      ...extraHeaders,
    },
  });
}

export function imageResponse(
  data: ArrayBuffer,
  contentType: string,
  extraHeaders?: Record<string, string>,
) {
  return new NextResponse(data, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": IMAGE_CACHE_CONTROL,
      ...extraHeaders,
    },
  });
}
