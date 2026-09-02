import { NextRequest, NextResponse } from "next/server";
import { backendUrl, authHeaders, TIMEOUT, catchError } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ testName: string }> }
) {
  try {
    const { testName } = await params;
    const res = await fetch(
      `${backendUrl()}/api/v1/ab-tests/${encodeURIComponent(testName)}/results`,
      {
        headers: authHeaders(request),
        signal: AbortSignal.timeout(TIMEOUT.DEFAULT),
        cache: "no-store",
      }
    );
    const body = await res
      .json()
      .catch(() => ({ success: false, error: `Upstream ${res.status}` }));
    return NextResponse.json(body, { status: res.ok ? 200 : res.status });
  } catch (err) {
    return catchError(err);
  }
}
