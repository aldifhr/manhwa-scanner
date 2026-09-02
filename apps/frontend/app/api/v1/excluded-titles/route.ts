import { NextRequest, NextResponse } from "next/server";
import {
  backendUrl,
  authHeaders,
  TIMEOUT,
  errorResponse,
  catchError,
} from "@/lib/server-api";
import { rewriteCoverUrl } from "@/lib/utils";

interface ExcludedBackendItem {
  id?: string;
  title_key?: string;
  title?: string | null;
  source?: string;
  created_at?: string | null;
  cover?: string | null;
  series_url?: string | null;
}

interface BackendResponse {
  success: boolean;
  data: { results?: ExcludedBackendItem[]; total?: number };
  error?: unknown;
}

export async function GET(request: NextRequest) {
  try {
    const res = await fetch(
      `${backendUrl()}/api/excluded-titles?page_size=10000`,
      {
        headers: authHeaders(request),
        signal: AbortSignal.timeout(TIMEOUT.DEFAULT),
      }
    );
    let body: Record<string, unknown>;
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    if (!res.ok || !body?.success) {
      const errObj = body as { error?: unknown };
      const msg =
        typeof errObj?.error === "string"
          ? errObj.error
          : `Upstream ${res.status}`;
      return errorResponse(msg, res.status);
    }
    const backendData =
      (body.data as { results?: ExcludedBackendItem[]; total?: number }) || {};
    const results = (backendData.results ?? []).map((item) => ({
      id: item.id || item.title_key || "",
      titleKey: item.title_key || item.id || "",
      title: item.title || null,
      source: item.source || "all",
      createdAt: item.created_at || null,
      cover: rewriteCoverUrl(item.cover),
      seriesUrl: item.series_url || null,
    }));
    return NextResponse.json({
      success: true,
      data: { results, total: backendData?.total ?? results.length },
    });
  } catch (err) {
    return catchError(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const data = await request.json();
    const res = await fetch(`${backendUrl()}/api/excluded-titles`, {
      method: "POST",
      headers: { ...authHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(TIMEOUT.DEFAULT),
    });
    let respBody: unknown;
    try {
      respBody = await res.json();
    } catch {
      respBody = { success: false, error: `Upstream ${res.status}` };
    }
    return NextResponse.json(respBody, { status: res.ok ? 200 : res.status });
  } catch (err) {
    return catchError(err);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const raw = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    // Normalize: FE may send title_key or titleKey or id, BE expects title_key
    const title_key =
      (raw.title_key as string) ||
      (raw.titleKey as string) ||
      (raw.title as string) ||
      (raw.id as string) ||
      "";
    const source = (raw.source as string) || "all";
    if (!title_key || !String(title_key).trim()) {
      console.error(
        "[excluded DELETE] missing title_key, raw:",
        JSON.stringify(raw).slice(0, 500)
      );
      return NextResponse.json(
        { success: false, error: "title_key is missing", received: raw },
        { status: 400 }
      );
    }
    const normalizedKey = String(title_key)
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .trim();
    const payload = {
      title_key: normalizedKey,
      source: String(source).trim() || "all",
    };
    const res = await fetch(`${backendUrl()}/api/excluded-titles`, {
      method: "DELETE",
      headers: { ...authHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT.DEFAULT),
    });
    let respBody: unknown;
    try {
      respBody = await res.json();
    } catch {
      respBody = { success: false, error: `Upstream ${res.status}` };
    }
    // If backend reports not_found with curly-quote mismatch, retry with raw key and with id fallback
    const bodyAs = respBody as {
      success?: boolean;
      error?: string;
      status?: string;
    };
    if (
      (!res.ok || bodyAs.success === false) &&
      normalizedKey !== String(title_key).trim()
    ) {
      const retryPayload = {
        title_key: String(title_key).trim(),
        source: payload.source,
      };
      const retryRes = await fetch(`${backendUrl()}/api/excluded-titles`, {
        method: "DELETE",
        headers: {
          ...authHeaders(request),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(retryPayload),
        signal: AbortSignal.timeout(TIMEOUT.DEFAULT),
      });
      try {
        const retryBody = await retryRes.json();
        if (
          retryRes.ok &&
          (retryBody as { success?: boolean }).success !== false
        ) {
          return NextResponse.json(retryBody, { status: 200 });
        }
      } catch {}
    }
    return NextResponse.json(respBody, { status: res.ok ? 200 : res.status });
  } catch (err) {
    return catchError(err);
  }
}
