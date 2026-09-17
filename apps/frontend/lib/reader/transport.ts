// transport — low-level fetch seam (csrf + 401 + abort), testable via injection
import { withCsrf } from "@/lib/csrf";
import { parseErrorMessage } from "@/lib/fetchError";

// global 401 handler — triggers refreshSession then redirect to /login
let _handling401 = false;
async function handle401() {
  if (typeof window === "undefined" || _handling401) return;
  // ponytail: jangan redirect kalau sudah di login page — avoid infinite refresh
  if (typeof window !== "undefined" && window.location.pathname === "/login") return;
  _handling401 = true;
  try {
    const { refreshSession } = await import("@/lib/server-api");
    const ok = await refreshSession();
    if (!ok) window.location.href = "/login";
  } catch {
    window.location.href = "/login";
  } finally {
    _handling401 = false;
  }
}

export type FetchImpl = typeof fetch;

// Klasifikasi endpoint: publik boleh HTTP cache (private SWR), privat jangan
// credentials: include + Cache-Control private → browser cache per-user (Vary: Cookie)
// Privat tanpa cache biar React Query yang jadi source of truth (stale/gc per P1)
// Publik: /rss (flat), /public/stats, /sources/health, /dashboard-snapshot (anon, aggregate)
// Privat: whitelist, dispatch-history, excluded, continue-reading, auth — must-revalidate no-store
const PUBLIC_RE = /\/rss(\?|$)|^\/api\/public\/stats|^\/api\/v1\/public\/stats|^\/api\/v1\/sources\/health|\/dashboard-snapshot/;
const PRIVATE_RE = /\/whitelist|\/dispatch-history|\/excluded-titles|\/continue-reading|auth|\/queue|\/failed-dispatches/;
function cacheForPath(path: string, init?: RequestInit): RequestCache | undefined {
  // Mutasi tidak pernah cache
  const m = (init?.method ?? "GET").toUpperCase();
  if (m !== "GET" && m !== "HEAD") return "no-store";
  if (PUBLIC_RE.test(path)) return undefined; // default → hormati Cache-Control backend (private SWR)
  if (PRIVATE_RE.test(path)) return "no-store";
  return undefined;
}

export async function readerFetch<T>(
  path: string,
  init?: RequestInit,
  fetchImpl: FetchImpl = fetch
): Promise<T> {
  const cache = cacheForPath(path, init);
  const baseInit: RequestInit = cache ? { cache } : {};
  const mergedInit = init ? { ...baseInit, ...init, ...(cache && !init.cache ? { cache } : {}) } : (cache ? { cache } as RequestInit : undefined);
  const csrfInit = mergedInit
    ? (withCsrf(mergedInit as RequestInit) as RequestInit)
    : undefined;
  const res = await fetchImpl(path, { ...(csrfInit as RequestInit), credentials: "include" });
  if (res.status === 204) return { success: true, data: { results: [] } } as T;
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    const msg = parseErrorMessage(res.status, text);
    if (res.status === 401) {
      void handle401();
      throw new Error(`401 Unauthorized: ${msg}`);
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// ponytail: dedup concurrent identical paginatedGet (A: React Query cache alone still
// triggers N parallel fetches if N components mount before first resolves; inflight collapses to 1)
const _inflightPaginated = new Map<string, Promise<unknown[]>>();

export async function paginatedGet<T>(
  basePath: string,
  params: URLSearchParams,
  map: (r: unknown) => T,
  signal?: AbortSignal,
  fetchImpl: FetchImpl = fetch,
  hardCap = 100
): Promise<T[]> {
  const pageSize = Number(
    params.get("page_size") ?? params.get("limit") ?? 100
  );
  // Respect per-endpoint bulk limit: whitelist/dispatch support 1000, RSS capped 100
  const cap = hardCap;
  const inflightKey = `${basePath}?${params.toString()}|cap=${cap}`;
  if (_inflightPaginated.has(inflightKey) && !signal?.aborted) {
    return _inflightPaginated.get(inflightKey)! as Promise<T[]>;
  }
  const promise = (async (): Promise<T[]> => {
    const q = new URLSearchParams(params); // clone to avoid mutating caller
    if (pageSize > cap) {
      q.set(q.has("page_size") ? "page_size" : "limit", String(cap));
      const first = await readerFetch<{
        success: boolean;
        data: { results: unknown[]; totalPages?: number; total_pages?: number };
      }>(`${basePath}?${q}`, signal ? { signal } : undefined, fetchImpl);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const totalPages = (first.data?.totalPages ??
        (first.data as { total_pages?: number })?.total_pages ??
        1) as number;
      const firstRows = (first.data?.results ?? []).map(map);
      if (totalPages <= 1) return firstRows;
      const fetchers = Array.from({ length: totalPages - 1 }, (_, i) => () => {
        const p = new URLSearchParams(q);
        p.set("page", String(i + 2));
        p.set(q.has("page_size") ? "page_size" : "limit", String(cap));
        return readerFetch<{ success: boolean; data: { results: unknown[] } }>(
          `${basePath}?${p}`,
          signal ? { signal } : undefined,
          fetchImpl
        );
      });
      const batched: unknown[] = [];
      for (let i = 0; i < fetchers.length; i += 4) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const batch = await Promise.allSettled(
          fetchers.slice(i, i + 4).map((f) => f())
        );
        for (const r of batch) {
          if (r.status === "fulfilled")
            batched.push(...(r.value.data?.results ?? []));
          else if ((r.reason as Error)?.name !== "AbortError") throw r.reason;
        }
      }
      return [...firstRows, ...batched.map(map)];
    }
    const data = await readerFetch<{
      success: boolean;
      data: { results: unknown[] };
    }>(`${basePath}?${q}`, signal ? { signal } : undefined, fetchImpl);
    return (data.data?.results ?? []).map(map);
  })();
  _inflightPaginated.set(inflightKey, promise as Promise<unknown[]>);
  try {
    return await promise;
  } finally {
    _inflightPaginated.delete(inflightKey);
  }
}
