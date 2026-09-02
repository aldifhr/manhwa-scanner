import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const rawUrl = request.nextUrl.searchParams.get("url");
  if (!rawUrl) {
    return NextResponse.json({ error: "Missing url param" }, { status: 400 });
  }

  // Redirect to backend v1 cover-img endpoint (public, no auth needed)
  const backendUrl = process.env.BACKEND_URL || "https://scanner.aldifhr.fun";
  const target = new URL("/api/v1/reader/cover-img", backendUrl);
  target.searchParams.set("url", rawUrl);

  return NextResponse.redirect(target.toString(), 307);
}
