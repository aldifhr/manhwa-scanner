import type { PageLoad } from "./$types";
export const load: PageLoad = async ({ fetch }) => {
  try {
    const res = await fetch("/api/v1/reader/whitelist");
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { data: json, error: (json as any)?.error || `HTTP ${res.status}`, status: res.status };
    return { data: json, error: null, status: res.status };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e), status: 0 };
  }
};
