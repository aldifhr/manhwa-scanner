export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { COOKIE_NAME } from "@/lib/auth";

async function handleLogout(_request: Request) {
  // NOTE: tidak call backend /auth?action=logout — backend tidak punya handler logout
  // dan call tersebut cuma buang kuota rate_limit 5/min untuk /auth. JWT stateless,
  // clear cookie di FE sudah cukup. Jika backend nanti punya blocklist, aktifkan lagi.

  const response = NextResponse.json({ success: true });
  const clearOpts = {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  };
  // clear host-only (current) + legacy domain cookie from previous none+domain fix
  response.cookies.set(COOKIE_NAME, "", { ...clearOpts, httpOnly: true });
  response.cookies.set(COOKIE_NAME, "", { ...clearOpts, httpOnly: true, domain: ".aldifhr.fun" });
  response.cookies.set("ikiru_csrf_token", "", { ...clearOpts, httpOnly: false });
  response.cookies.set("ikiru_csrf_token", "", { ...clearOpts, httpOnly: false, domain: ".aldifhr.fun" });
  // also clear none variant if still present
  response.cookies.set(COOKIE_NAME, "", { ...clearOpts, httpOnly: true, sameSite: "none" as const, secure: true, domain: ".aldifhr.fun" });
  response.cookies.set("ikiru_csrf_token", "", { ...clearOpts, httpOnly: false, sameSite: "none" as const, secure: true, domain: ".aldifhr.fun" });
  // Ensure caches don't retain auth'd responses after logout
  response.headers.set("Clear-Site-Data", '"cookies"');
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: Request) {
  return handleLogout(request);
}

export async function GET(request: Request) {
  return handleLogout(request);
}
