import { NextRequest, NextResponse } from "next/server";
import { backendUrl, authHeaders, TIMEOUT, catchError } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const qs = new URL(request.url).search;
    const res = await fetch(`${backendUrl()}/api/v1/bookmarks${qs}`, {
      headers: authHeaders(request),
      signal: AbortSignal.timeout(TIMEOUT.DEFAULT),
      cache: "no-store",
    });
    const body = await res
      .json()
      .catch(() => ({ success: false, error: `Upstream ${res.status}` }));
    return NextResponse.json(body, {
      status: res.ok ? 200 : res.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return catchError(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const data = await request.json().catch(() => ({}));
    const res = await fetch(`${backendUrl()}/api/v1/bookmarks`, {
      method: "POST",
      headers: { ...authHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(TIMEOUT.DEFAULT),
      cache: "no-store",
    });
    const body = await res
      .json()
      .catch(() => ({ success: false, error: `Upstream ${res.status}` }));
    return NextResponse.json(body, { status: res.ok ? 200 : res.status });
  } catch (err) {
    return catchError(err);
  }
}
