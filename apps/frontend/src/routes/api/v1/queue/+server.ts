import type { RequestHandler } from "./$types";
import { backendUrl, authHeaders, TIMEOUT } from "$lib/server-api";
export const GET: RequestHandler = async ({ request }) => {
  try {
    const res = await fetch(`${backendUrl()}/api/failed-dispatches/queue`, {
      headers: authHeaders(request),
      signal: AbortSignal.timeout(TIMEOUT.QUEUE)
    });
    const body = await res.text();
    return new Response(body, { status: res.status, headers: { "Content-Type":"application/json" } });
  } catch (e:any) { return Response.json({ success:false, error: e?.message||String(e) }, { status: 502 }); }
};
