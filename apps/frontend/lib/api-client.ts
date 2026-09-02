import { readerFetch } from "@/lib/reader/transport";

// Deep module: api client seam — single place for fetch + csrf + error parsing
// Delegates to Reader transport (single error parser via fetchError.ts)
export async function apiFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  return readerFetch<T>(path, init);
}
export function apiUrl(path: string, params?: URLSearchParams) {
  return params ? `${path}?${params}` : path;
}
