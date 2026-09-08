import type { PageLoad } from "./$types";
export const load: PageLoad = async ({ fetch }) => {
  try {
    const res = await fetch("/api/v1/reader/whitelist");
    const json = await res.json();
    return { data: json, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
};
