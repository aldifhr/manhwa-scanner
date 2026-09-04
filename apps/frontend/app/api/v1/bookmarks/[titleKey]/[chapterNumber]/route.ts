import { NextRequest, NextResponse } from "next/server";
import { backendUrl, authHeaders, TIMEOUT, catchError } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ titleKey: string; chapterNumber: string }> }
) {
  try {
    const { titleKey, chapterNumber } = await params;
    const res = await fetch(
      `${backendUrl()}/api/v1/bookmarks/${encodeURIComponent(titleKey)}/${encodeURIComponent(chapterNumber)}`,
      {
        method: "DELETE",
        headers: authHeaders(request),
        signal: AbortSignal.timeout(TIMEOUT.DEFAULT),
        cache: "no-store",
      }
    );
    if (res.status === 404) {
      return NextResponse.json({
        success: true,
        data: { _localFallback: true },
      });
    }
    const body = await res
      .json()
      .catch(() => ({ success: false, error: `Upstream ${res.status}` }));
    return NextResponse.json(body, { status: res.ok ? 200 : res.status });
  } catch (err) {
    return catchError(err);
  }
}
