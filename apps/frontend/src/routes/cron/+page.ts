import type { PageLoad } from "./$types";
export const load: PageLoad = async ({ fetch }) => {
  const j = async (url: string) =>
    fetch(url)
      .then((r) => r.json().catch(() => null))
      .catch(() => null);
  const [cron, health, snap] = await Promise.all([
    j("/api/v1/cron/status"),
    j("/api/v1/health/detailed"),
    j("/api/v1/dashboard/snapshot"),
  ]);
  return { cron, health, snap };
};
