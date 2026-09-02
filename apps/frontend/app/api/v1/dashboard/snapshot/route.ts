import { NextRequest, NextResponse } from "next/server";
import { backendUrl, authHeaders, TIMEOUT, catchError } from "@/lib/server-api";

export async function GET(request: NextRequest) {
  try {
    const res = await fetch(`${backendUrl()}/api/v1/dashboard-snapshot`, {
      headers: authHeaders(request),
      signal: AbortSignal.timeout(TIMEOUT.DEFAULT),
    });
    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: `Upstream ${res.status}` },
        { status: res.status }
      );
    }
    const body = await res.json();
    return NextResponse.json(body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return catchError(err);
  }
}
