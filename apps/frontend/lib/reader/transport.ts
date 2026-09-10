// transport — low-level fetch seam (csrf + 401 + abort), testable via injection
import { withCsrf } from "@/lib/csrf";
import { parseErrorMessage } from "@/lib/fetchError";

// global 401 handler — triggers refreshSession then redirect to /login
let _handling401 = false;
async function handle401() {
  if (typeof window === "undefined" || _handling401) return;
  _handling401 = true;
  try {
    // trigger refreshSession (dynamic import avoids circular static dep)
    const { refreshSession } = await import("@/lib/server-api");
    await refreshSession();
  } catch {}
  window.location.href = "/login";
}

export type FetchImpl = typeof fetch;

export async function readerFetch<T>(
  path: string,
  init?: RequestInit,
  fetchImpl: FetchImpl = fetch
): Promise<T> {
  const csrfInit = init
    ? (withCsrf(init as RequestInit) as RequestInit)
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

export async function paginatedGet<T>(
  basePath: string,
  params: URLSearchParams,
  map: (r: unknown) => T,
  signal?: AbortSignal,
  fetchImpl: FetchImpl = fetch
): Promise<T[]> {
  const pageSize = Number(
    params.get("page_size") ?? params.get("limit") ?? 100
  );
  const q = new URLSearchParams(params); // clone to avoid mutating caller
  if (pageSize > 100) {
    q.set(q.has("page_size") ? "page_size" : "limit", "100");
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
      p.set(q.has("page_size") ? "page_size" : "limit", "100");
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
}
