import { NextRequest, NextResponse } from "next/server";
import {
  backendUrl,
  authHeaders,
  TIMEOUT,
  errorResponse,
  catchError,
} from "@/lib/server-api";

export async function GET(request: NextRequest) {
  const search = (request.nextUrl.searchParams.get("search") || "")
    .trim()
    .slice(0, 100);
  const page = String(
    Math.min(
      Math.max(Number(request.nextUrl.searchParams.get("page")) || 1, 1),
      1000
    )
  );
  const pageSize = String(
    Math.min(
      Math.max(Number(request.nextUrl.searchParams.get("page_size")) || 50, 1),
      1000
    )
  );

  try {
    const params = new URLSearchParams({ page, page_size: pageSize });
    if (search) params.set("search", search);

    const res = await fetch(
      `${backendUrl()}/api/v1/dispatch-history?${params}`,
      {
        headers: authHeaders(request),
        signal: AbortSignal.timeout(TIMEOUT.DEFAULT),
      }
    );

    let body: Record<string, unknown>;
    try {
      body = await res.json();
    } catch {
      return errorResponse(`Upstream produced non-JSON body`, 502);
    }

    if (!res.ok || !body.success) {
      return errorResponse(
        (body.error as string) ?? `Upstream error`,
        res.status
      );
    }

    return NextResponse.json(body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Cache": "MISS",
      },
    });
  } catch (err) {
    return catchError(err);
  }
}
