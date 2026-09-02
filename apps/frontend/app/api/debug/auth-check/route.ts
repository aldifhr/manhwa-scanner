import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/server-api";

export async function GET() {
  const url = backendUrl();
  const started = Date.now();
  let health:
    | { status: number; body: string; ms: number }
    | { error: string; ms: number } = { error: "not fetched", ms: 0 };
  try {
    const t0 = Date.now();
    const res = await fetch(`${url}/api/v1/auth?action=login`, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.text();
    health = {
      status: res.status,
      body: body.slice(0, 2000),
      ms: Date.now() - t0,
    };
  } catch (e) {
    health = {
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      ms: Date.now() - started,
    };
  }

  return NextResponse.json({
    backendUrl: url,
    env: {
      BACKEND_URL_set: !!process.env.BACKEND_URL,
      BACKEND_URL_raw: process.env.BACKEND_URL ?? null,
      NODE_ENV: process.env.NODE_ENV,
    },
    health,
    hint: "GET /api/auth?action=login should return 405/400, not timeout. If it times out = backend down / network block.",
  });
}
