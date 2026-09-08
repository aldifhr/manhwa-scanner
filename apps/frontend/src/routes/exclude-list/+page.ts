import type { PageLoad } from "./$types";
export const load: PageLoad = async ({ fetch }) => {
  try {
    const res = await fetch("/api/v1/excluded-titles");
    const json:any = await res.json().catch(()=>({}));
    if (!res.ok) return { data: json, error: json?.error || `HTTP ${res.status}`, status: res.status };
    return { data: json, error: null, status: res.status };
  } catch(e:any){ return { data:null, error: e.message, status:0 }; }
};
