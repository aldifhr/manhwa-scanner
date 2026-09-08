import { NextRequest } from "next/server";
import {
  backendUrl,
  authHeaders,
  TIMEOUT,
  errorResponse,
  catchError,
} from "@/lib/server-api";
import { safeUrl } from "@/lib/utils";

export async function GET(request: NextRequest) {
  try {
    const url = request.nextUrl.searchParams.get("url") || "";
    if (!url) return errorResponse("Missing url parameter", 400);
    if (!safeUrl(url)) return errorResponse("Invalid url scheme", 400);

    const res = await fetch(
      `${backendUrl()}/api/catalog/resolve?url=${encodeURIComponent(url)}`,
      {
        headers: authHeaders(request),
        signal: AbortSignal.timeout(TIMEOUT.DEFAULT),
      }
    );
    let data: Record<string, unknown>;
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok) {
      const errObj = data as { error?: { message?: string } };
      return errorResponse(
        errObj?.error?.message || `Upstream ${res.status}`,
        res.status
      );
    }
    return Response.json(data);
  } catch (err) {
    return catchError(err);
  }
}
