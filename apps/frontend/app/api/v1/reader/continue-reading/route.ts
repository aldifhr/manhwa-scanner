import { NextRequest, NextResponse } from "next/server";
import {
  backendUrl,
  authHeaders,
  TIMEOUT,
  errorResponse,
  catchError,
} from "@/lib/server-api";

export const dynamic = "force-dynamic";

/**
 * Cross-device Continue Reading sync — strict proxy to BE.
 * BE now implements GET/PUT /api/v1/continue-reading (DB table).
 */

export async function GET(request: NextRequest) {
  try {
    const res = await fetch(`${backendUrl()}/api/v1/continue-reading`, {
      headers: authHeaders(request),
      signal: AbortSignal.timeout(TIMEOUT.DEFAULT),
      cache: "no-store",
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      return NextResponse.json(body);
    }
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (e) {
    return catchError(e);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const res = await fetch(`${backendUrl()}/api/v1/continue-reading`, {
      method: "PUT",
      headers: {
        ...authHeaders(request),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT.DEFAULT),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    return catchError(e);
  }
}
