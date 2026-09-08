import type { PageLoad } from "./$types";
export const load: PageLoad = async ({ fetch }) => {
  try {
    const res = await fetch("/api/v1/reader/rss?limit=36&group=false");
    const json = await res.json();
    return { feed: json, error: null };
  } catch (e) {
    return { feed: null, error: e instanceof Error ? e.message : String(e) };
  }
};

