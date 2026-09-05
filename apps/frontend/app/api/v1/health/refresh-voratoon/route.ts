import { NextRequest, NextResponse } from "next/server";
import { backendUrl, authHeaders, TIMEOUT, catchError } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const token =
      process.env.API_TOKEN ||
      process.env.NEXT_PUBLIC_API_TOKEN ||
      "manhwascan";
    const res = await fetch(`${backendUrl()}/api/v1/health/refresh-voratoon`, {
      method: "POST",
      headers: {
        ...authHeaders(request),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT.SLOW),
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
