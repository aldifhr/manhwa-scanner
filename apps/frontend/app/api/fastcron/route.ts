import { NextRequest, NextResponse } from "next/server";

const FASTCRON_API = "https://www.fastcron.com/api/v1";

function getToken(): string | null {
  return process.env.FASTCRON_API_KEY || process.env.FASTCRON_TOKEN || null;
}

export async function GET(request: NextRequest) {
  const token = getToken();
  if (!token)
    return NextResponse.json(
      { success: false, error: "FASTCRON_API_KEY not set in env" },
      { status: 500 }
    );
  const action = request.nextUrl.searchParams.get("action") || "cron_list";
  const allowed = new Set([
    "cron_list",
    "cron_get",
    "cron_logs",
    "cron_next",
    "cron_failures",
  ]);
  if (!allowed.has(action))
    return NextResponse.json(
      { success: false, error: "Invalid GET action" },
      { status: 400 }
    );
  const id = request.nextUrl.searchParams.get("id");
  const page = request.nextUrl.searchParams.get("page") || "1";
  const params = new URLSearchParams({ token });
  if (id) params.set("id", id);
  if (action === "cron_list") params.set("page", page);
  const url = `${FASTCRON_API}/${action}?${params}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const body = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(body);
    } catch {
      json = body;
    }
    return NextResponse.json(
      { success: res.ok, data: json, status: res.status },
      { status: res.ok ? 200 : res.status }
    );
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}

export async function POST(request: NextRequest) {
  const token = getToken();
  if (!token)
    return NextResponse.json(
      { success: false, error: "FASTCRON_API_KEY not set" },
      { status: 500 }
    );
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const action = (body.action as string) || "cron_add";
  const allowed = new Set([
    "cron_add",
    "cron_edit",
    "cron_enable",
    "cron_disable",
    "cron_delete",
    "cron_run",
    "cron_pause",
    "cron_batch_add",
  ]);
  if (!allowed.has(action))
    return NextResponse.json(
      { success: false, error: "Invalid POST action" },
      { status: 400 }
    );
  const params = new URLSearchParams({ token });
  // For cron_add/edit, pass url, expression, etc as query params (FastCron API supports query string)
  // Also support JSON body via POST
  const url = `${FASTCRON_API}/${action}?${params}`;
  const payload: Record<string, unknown> = { ...body };
  delete payload.action;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return NextResponse.json(
      { success: res.ok, data: json, status: res.status },
      { status: res.ok ? 200 : res.status }
    );
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
