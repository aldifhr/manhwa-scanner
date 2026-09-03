import { withCsrf } from "@/lib/csrf";
import type { ContinueReadingEntry } from "./index";

const SYNC_ENDPOINT = "/api/v1/continue-reading";

export async function fetchRemote(): Promise<Record<string, ContinueReadingEntry>> {
  const res = await fetch(SYNC_ENDPOINT, { cache: "no-store" });
  if (!res.ok) return {};
  const body = await res.json().catch(() => null);
  const remote: Record<string, ContinueReadingEntry> = body?.data ?? body ?? {};
  if (!remote || typeof remote !== "object") return {};
  return remote;
}

export async function pushRemote(clean: Record<string, ContinueReadingEntry>): Promise<void> {
  await fetch(
    SYNC_ENDPOINT,
    withCsrf({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(clean),
    })
  ).catch(() => {});
}
