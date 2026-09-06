// Bookmark seam — anon localStorage, authed backend. Other domains use Reader directly.
// ponytail: shim deleted (was 150L re-export of Reader). Import Reader for rss/whitelist/exclude.

// Bookmarks — anon pakai localStorage, authed (ikiru_csrf_token readable twin of httpOnly session) pakai backend
const LS_BM_KEY = "bookmarks";
function isAnonBookmark(): boolean {
  if (typeof document === "undefined") return true;
  // ponytail: session is httpOnly → check readable csrf twin
  return !document.cookie.match(/(?:^|;\s*)ikiru_csrf_token=/);
}
function loadLocalBookmarks(): BookmarkEntry[] {
  try {
    const raw = localStorage.getItem(LS_BM_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as BookmarkEntry[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveLocalBookmarks(list: BookmarkEntry[]) {
  try {
    localStorage.setItem(LS_BM_KEY, JSON.stringify(list.slice(0, 100)));
  } catch {}
}

export interface BookmarkEntry {
  title_key: string;
  chapter_number: number;
  chapter_url: string;
  source: string;
  position_pct: number;
  updated_at: string;
  title?: string;
  cover?: string | null;
}
export async function getBookmarks(
  page = 1,
  pageSize = 50
): Promise<BookmarkEntry[]> {
  if (isAnonBookmark()) {
    const all = loadLocalBookmarks().sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
    const start = (page - 1) * pageSize;
    return all.slice(start, start + pageSize);
  }
  try {
    const { readerFetch } = await import("@/lib/reader/transport");
    const qs =
      page !== 1 || pageSize !== 50
        ? `?page=${page}&page_size=${pageSize}`
        : "";
    const body = await readerFetch<{
      success: boolean;
      data: BookmarkEntry[] | { results: BookmarkEntry[] };
    }>(`/api/v1/bookmarks${qs}`);
    const d = body.data as unknown;
    if (Array.isArray(d)) return d as BookmarkEntry[];
    if (
      d &&
      typeof d === "object" &&
      "results" in (d as Record<string, unknown>)
    )
      return (
        ((d as { results: BookmarkEntry[] }).results as BookmarkEntry[]) || []
      );
    return [];
  } catch (e) {
    if (
      (e as Error)?.message?.includes("404") ||
      (e as Error)?.message?.includes("401") ||
      (e as Error)?.message?.includes("403")
    )
      return [];
    throw e;
  }
}
export async function getBookmarksPaginated(
  page = 1,
  pageSize = 50
): Promise<{ results: BookmarkEntry[]; total: number; hasMore: boolean }> {
  if (isAnonBookmark()) {
    const all = loadLocalBookmarks().sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
    const start = (page - 1) * pageSize;
    const slice = all.slice(start, start + pageSize);
    return {
      results: slice,
      total: all.length,
      hasMore: start + pageSize < all.length,
    };
  }
  const { readerFetch } = await import("@/lib/reader/transport");
  const body = await readerFetch<{
    success: boolean;
    data: { results: BookmarkEntry[]; total: number; hasMore: boolean };
  }>(`/api/v1/bookmarks?page=${page}&page_size=${pageSize}`);
  const d = body.data as unknown;
  if (Array.isArray(d))
    return {
      results: d as BookmarkEntry[],
      total: (d as BookmarkEntry[]).length,
      hasMore: false,
    };
  return (
    (d as { results: BookmarkEntry[]; total: number; hasMore: boolean }) || {
      results: [],
      total: 0,
      hasMore: false,
    }
  );
}
export async function saveBookmark(data: {
  title_key: string;
  chapter_number: number;
  chapter_url: string;
  source?: string;
  position_pct?: number;
  title?: string;
  cover?: string | null;
}): Promise<void> {
  if (isAnonBookmark()) {
    const all = loadLocalBookmarks();
    const idx = all.findIndex(
      (b) =>
        b.title_key === data.title_key &&
        b.chapter_number === data.chapter_number
    );
    const entry: BookmarkEntry = {
      ...data,
      position_pct: data.position_pct ?? 0,
      updated_at: new Date().toISOString(),
      source: data.source ?? "",
      title: data.title ?? data.title_key,
      cover: data.cover ?? null,
    };
    if (idx >= 0) all[idx] = entry;
    else all.unshift(entry);
    saveLocalBookmarks(all);
    return;
  }
  const { readerFetch } = await import("@/lib/reader/transport");
  await readerFetch("/api/v1/bookmarks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
export async function deleteBookmark(
  titleKey: string,
  chapterNumber: number
): Promise<void> {
  if (isAnonBookmark()) {
    const all = loadLocalBookmarks().filter(
      (b) => !(b.title_key === titleKey && b.chapter_number === chapterNumber)
    );
    saveLocalBookmarks(all);
    return;
  }
  const { readerFetch } = await import("@/lib/reader/transport");
  await readerFetch(`/api/v1/bookmarks/${titleKey}/${chapterNumber}`, {
    method: "DELETE",
  });
}
