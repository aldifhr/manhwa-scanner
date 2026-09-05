import { NextResponse } from "next/server";
import { COOKIE_NAME } from "@/lib/auth";

export async function POST(request: Request) {
  // Best-effort backend invalidation — JWT is stateless but backend may
  // have a blocklist/revocation path in future. Ignore failures.
  try {
    const { backendUrl } = await import("@/lib/server-api");
    const cookie = request.headers.get("cookie") || "";
    await fetch(`${backendUrl()}/api/v1/auth?action=logout`, {
      method: "POST",
      headers: cookie ? { Cookie: cookie } : {},
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch {
    /* ignore */
  }

  const response = NextResponse.json({ success: true });
  const clearOpts = {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  };
  response.cookies.set(COOKIE_NAME, "", { ...clearOpts, httpOnly: true });
  response.cookies.set("ikiru_csrf_token", "", {
    ...clearOpts,
    httpOnly: false,
  });
  response.cookies.set("ikiru_role", "", {
    ...clearOpts,
    httpOnly: false,
  });
  return response;
}
