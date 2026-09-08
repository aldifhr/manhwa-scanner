import { env } from "$env/dynamic/private";
export async function proxyToScanner(event: import("@sveltejs/kit").RequestEvent, path: string): Promise<Response> {
  const target = `https://scanner.aldifhr.fun${path}${event.url.search}`;
  const headers: Record<string, string> = {};
  for (const [k, v] of event.request.headers) {
    if (k.toLowerCase() === "host") continue;
    headers[k] = v;
  }
  const cookie = event.request.headers.get("cookie") || "";
  if (cookie) headers["cookie"] = cookie;
  // anon image proxy needs API_TOKEN fallback (Next server-api authHeaders)
  const hasSession = /(?:^|;\s*)ikiru_dashboard_session=/.test(cookie);
  if (!hasSession) {
    const token = (env as any).API_TOKEN || (env as any).BACKEND_API_TOKEN || "manhwascan";
    if (token && !headers["authorization"] && !headers["Authorization"]) headers["Authorization"] = `Bearer ${token}`;
  }
  const init: RequestInit = {
    method: event.request.method,
    headers
  };
  if (event.request.method !== "GET" && event.request.method !== "HEAD") {
    init.body = await event.request.text();
  }
  const res = await fetch(target, init);
  const out = new Headers();
  for (const [k, v] of res.headers) out.set(k, v);
  if (path.includes("/reader/cover") || path.includes("/reader/proxy")) {
    out.set("Content-Type", "image/webp");
    out.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
  }
  if (path.includes("/dispatch-history") || path.includes("/dashboard")) out.set("Cache-Control", "no-store");
  // 304/204 must not have body — Node's Response throws Invalid status code with body
  if (res.status === 304 || res.status === 204) {
    return new Response(null, { status: res.status, headers: out });
  }
  const body = await res.arrayBuffer();
  return new Response(body, { status: res.status, headers: out });
}
