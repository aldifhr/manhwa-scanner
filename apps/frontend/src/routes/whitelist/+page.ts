import type { PageLoad } from "./$types";
export const load: PageLoad = async ({ fetch }) => {
  try {
    // Reader.getWhitelist uses ?page=1&page_size=1000&merge=false
    const res = await fetch("/api/v1/reader/whitelist?page=1&page_size=1000&merge=false");
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) return { data: json, raw: json, error: json?.error || `HTTP ${res.status}`, status: res.status };
    return { data: json, raw: json, error: null, status: res.status };
  } catch (e) {
    return { data: null, raw: null, error: e instanceof Error ? e.message : String(e), status: 0 };
  }
};
