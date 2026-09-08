import type { RequestHandler } from "./$types";
import { COOKIE_NAME } from "$lib/auth";
import { backendUrl } from "$lib/server-api";
export const POST: RequestHandler = async ({ request, cookies }) => {
  try {
    const cookie = request.headers.get("cookie") || "";
    await fetch(`${backendUrl()}/api/v1/auth?action=logout`, {
      method: "POST",
      headers: cookie ? { Cookie: cookie } : {},
      signal: AbortSignal.timeout(5000)
    }).catch(() => {});
  } catch {}
  cookies.delete(COOKIE_NAME, { path: "/" });
  cookies.delete("ikiru_csrf_token", { path: "/" });
  return Response.json({ success: true });
};
export const GET: RequestHandler = async ({ request, cookies }) => {
  cookies.delete(COOKIE_NAME, { path: "/" });
  cookies.delete("ikiru_csrf_token", { path: "/" });
  return Response.json({ success: true });
};
