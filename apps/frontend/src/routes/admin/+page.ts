import type { PageLoad } from "./$types";
export const load: PageLoad = async ({ fetch }) => {
  const j = async (url:string)=> fetch(url).then(r=>r.json().catch(()=>null)).catch(()=>null);
  const [snap, queue, cron, health, errors, failed] = await Promise.all([
    j("/api/v1/dashboard/snapshot"),
    j("/api/v1/queue"),
    j("/api/v1/cron/status"),
    j("/api/v1/health/detailed"),
    j("/api/v1/logs/errors?page=1&page_size=20"),
    j("/api/v1/failed-dispatches?limit=20")
  ]);
  return { snap, queue, cron, health, errors, failed, error: null };
};
