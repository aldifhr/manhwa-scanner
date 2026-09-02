import { withCsrf } from "@/lib/csrf";

// Deep module: api client seam — single place for fetch + csrf + error parsing
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init ? (withCsrf(init as RequestInit) as RequestInit) : undefined);
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: unknown; received?: unknown }));
    const msg =
      typeof (body as { error?: unknown }).error === "string"
        ? String((body as { error: string }).error)
        : ((body as { error?: { message?: string } }).error?.message as string) ||
          (body as { message?: string }).message ||
          `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}
export function apiUrl(path: string, params?: URLSearchParams) {
  return params ? `${path}?${params}` : path;
}
