import { NextRequest, NextResponse } from "next/server";
import { backendUrl, authHeaders, TIMEOUT, catchError } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const res = await fetch(`${backendUrl()}/api/v1/graphql`, {
      method: "POST",
      headers: { ...authHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT.DEFAULT),
      cache: "no-store",
    });
    const respBody = await res
      .json()
      .catch(() => ({ success: false, error: `Upstream ${res.status}` }));
    return NextResponse.json(respBody, { status: res.ok ? 200 : res.status });
  } catch (err) {
    return catchError(err);
  }
}

export async function GET(request: NextRequest) {
  try {
    const res = await fetch(`${backendUrl()}/api/v1/graphql`, {
      headers: authHeaders(request),
      signal: AbortSignal.timeout(TIMEOUT.DEFAULT),
      cache: "no-store",
    });
    const respBody = await res
      .json()
      .catch(() => ({ success: false, error: `Upstream ${res.status}` }));
    return NextResponse.json(respBody, { status: res.ok ? 200 : res.status });
  } catch (err) {
    return catchError(err);
  }
}
