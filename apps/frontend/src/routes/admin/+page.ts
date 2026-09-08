import type { PageLoad } from "./$types";
export const load: PageLoad = async ({ fetch }) => {
  try {
    const [snap, queue, cron] = await Promise.all([
      fetch("/api/v1/dashboard/snapshot").then(r=>r.json().catch(()=>null)),
      fetch("/api/v1/queue").then(r=>r.json().catch(()=>null)),
      fetch("/api/v1/cron/status").then(r=>r.json().catch(()=>null))
    ]);
    return { snap, queue, cron, error: null };
  } catch (e) { return { snap:null, queue:null, cron:null, error: String(e) }; }
};
