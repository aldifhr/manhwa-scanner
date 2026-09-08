import type { RequestHandler } from "./$types";
import { backendUrl, authHeaders, TIMEOUT } from "$lib/server-api";
export const GET: RequestHandler = async ({ request }) => {
  try {
    const res = await fetch(`${backendUrl()}/api/v1/dashboard-snapshot`, {
      headers: authHeaders(request),
      signal: AbortSignal.timeout(TIMEOUT.DEFAULT)
    });
    if (!res.ok && (res.status===401||res.status===403)) return Response.json({ success:true, data:null }, { headers:{ "Cache-Control":"no-store" } });
    const body = await res.text();
    return new Response(body, { status: res.status, headers: { "Content-Type":"application/json", "Cache-Control":"no-store" } });
  } catch (e:any) { return Response.json({ success:false, error: e?.message||String(e) }, { status: 502 }); }
};
