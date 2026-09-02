import { NextRequest, NextResponse } from "next/server";
import {
  backendUrl,
  TIMEOUT,
  errorResponse,
  catchError,
} from "@/lib/server-api";

export const dynamic = "force-dynamic";

/** Public aggregate — no session required (counts only, no titles). */
export async function GET(request: NextRequest) {
  try {
    const weeks = request.nextUrl.searchParams.get("weeks") || "26";
    const res = await fetch(
      `${backendUrl()}/api/activity/heatmap?weeks=${encodeURIComponent(weeks)}`,
      {
        signal: AbortSignal.timeout(TIMEOUT.SLOW),
        cache: "no-store",
      }
    );
    if (!res.ok) return errorResponse(`Upstream ${res.status}`, res.status);
    return NextResponse.json(await res.json(), {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch (e) {
    return catchError(e);
  }
}
