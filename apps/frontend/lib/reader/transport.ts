// transport — low-level fetch seam (csrf + 401 + abort), testable via injection
import { withCsrf } from "@/lib/csrf";
import { parseErrorMessage } from "@/lib/fetchError";

export type FetchImpl = typeof fetch;

export async function readerFetch<T>(
  path: string,
  init?: RequestInit,
  fetchImpl: FetchImpl = fetch
): Promise<T> {
  const csrfInit = init
    ? (withCsrf(init as RequestInit) as RequestInit)
    : undefined;
  const res = await fetchImpl(path, csrfInit as RequestInit);
  if (res.status === 204) return { success: true, data: { results: [] } } as T;
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    const msg = parseErrorMessage(res.status, text);
    if (res.status === 401) throw new Error(`UNAUTHORIZED: ${msg}`);
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
    params.get("page_size") ?? params.get("limit") ?? 1000
  );
  if (pageSize > 1000) {
    params.set(params.has("page_size") ? "page_size" : "limit", "1000");
    const first = await readerFetch<{
      success: boolean;
      data: { results: unknown[]; totalPages?: number; total_pages?: number };
    }>(`${basePath}?${params}`, signal ? { signal } : undefined, fetchImpl);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const totalPages = (first.data?.totalPages ??
      (first.data as { total_pages?: number })?.total_pages ??
      1) as number;
    const firstRows = (first.data?.results ?? []).map(map);
    if (totalPages <= 1) return firstRows;
    const fetchers = Array.from({ length: totalPages - 1 }, (_, i) => () => {
      const p = new URLSearchParams(params);
      p.set("page", String(i + 2));
      p.set(params.has("page_size") ? "page_size" : "limit", "1000");
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
  }>(`${basePath}?${params}`, signal ? { signal } : undefined, fetchImpl);
  return (data.data?.results ?? []).map(map);
}
