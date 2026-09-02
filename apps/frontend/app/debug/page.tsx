"use client";

import { useEffect, useState } from "react";

type Result = {
  label: string;
  status: number | string;
  ms: number;
  body: string;
  headers?: Record<string, string>;
};

function fmtMs(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function tryParseJson(text: string): string {
  try {
    const j = JSON.parse(text);
    return JSON.stringify(j, null, 2).slice(0, 4000);
  } catch {
    return text.slice(0, 4000);
  }
}

export default function DebugPage() {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [storageDump, setStorageDump] = useState<Record<string, string> | null>(
    null
  );
  const [cookieStr, setCookieStr] = useState("");

  useEffect(() => {
    setCookieStr(document.cookie || "(no cookies)");
    try {
      const keys = [
        "continue_reading",
        "home_read_items",
        "alltab-ui",
        "alltab_scroll",
      ];
      const dump: Record<string, string> = {};
      for (const k of keys) {
        const v = localStorage.getItem(k);
        if (v) dump[k] = v.slice(0, 2000);
      }
      setStorageDump(dump);
    } catch {
      setStorageDump({});
    }
  }, []);

  async function run(
    label: string,
    fn: () => Promise<{
      status: number | string;
      body: string;
      headers?: Record<string, string>;
    }>
  ) {
    setLoading(label);
    const t0 = performance.now();
    try {
      const r = await fn();
      setResults((prev) => [
        {
          label,
          status: r.status,
          ms: Math.round(performance.now() - t0),
          body: r.body,
          headers: r.headers,
        },
        ...prev,
      ]);
    } catch (e) {
      setResults((prev) => [
        {
          label,
          status: "ERR",
          ms: Math.round(performance.now() - t0),
          body: e instanceof Error ? e.message : String(e),
        },
        ...prev,
      ]);
    } finally {
      setLoading(null);
    }
  }

  const btnPrimary =
    "px-3 py-2.5 bg-accent text-black rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-accent/90 transition-colors";
  const btnSurface =
    "px-3 py-2.5 bg-surface border border-border rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-surface-hover transition-colors";

  return (
    <div className="min-h-screen bg-bg text-text p-4 sm:p-6 max-w-4xl mx-auto">
      <h1 className="text-xl font-bold">debug — live diagnostics</h1>
      <p className="text-sm text-text-muted mt-1">
        Test FE proxy vs backend langsung. Semua error ditampilkan mentah.
        Endpoint debug bersifat public (middleware).
      </p>

      {/* Password */}
      <div className="mt-6 flex gap-2">
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password (untuk test login)"
          type="password"
          className="flex-1 bg-surface border border-border rounded-lg px-3 py-2 text-sm"
        />
        <button
          onClick={() => setResults([])}
          className="px-3 py-2 text-sm border border-border rounded-lg hover:bg-surface"
        >
          clear log
        </button>
      </div>

      {/* Env & storage inspector */}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="border border-border bg-surface rounded-lg p-3">
          <div className="text-xs font-semibold mb-1">
            cookies (document.cookie)
          </div>
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-text-muted bg-bg rounded p-2 max-h-28 overflow-auto">
            {cookieStr}
          </pre>
          <div className="text-[11px] text-text-muted mt-1">
            httpOnly ikiru_dashboard_session tidak terlihat di JS (cek via
            /api/debug/auth-check).
          </div>
        </div>
        <div className="border border-border bg-surface rounded-lg p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold">localStorage</span>
            <button
              onClick={() => {
                try {
                  const keys = [
                    "continue_reading",
                    "home_read_items",
                    "alltab-ui",
                    "alltab_scroll",
                  ];
                  const dump: Record<string, string> = {};
                  for (const k of keys)
                    dump[k] =
                      localStorage.getItem(k)?.slice(0, 2000) ?? "(empty)";
                  setStorageDump(dump);
                } catch {}
              }}
              className="text-[11px] px-2 py-1 rounded bg-bg border border-border hover:bg-surface-hover"
            >
              refresh
            </button>
          </div>
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-text-muted bg-bg rounded p-2 max-h-28 overflow-auto">
            {storageDump ? JSON.stringify(storageDump, null, 2) : "loading..."}
          </pre>
          <div className="flex gap-1 mt-2">
            <button
              onClick={() => {
                if (!confirm("Delete continue_reading & home_read_items?"))
                  return;
                localStorage.removeItem("continue_reading");
                localStorage.removeItem("home_read_items");
                setStorageDump((p) => ({
                  ...p!,
                  continue_reading: "(cleared)",
                  home_read_items: "(cleared)",
                }));
              }}
              className="text-[11px] px-2 py-1 rounded bg-red-500/15 text-red-400 border border-red-500/20"
            >
              clear CR & read
            </button>
          </div>
        </div>
      </div>

      {/* Section: Auth */}
      <h2 className="text-sm font-bold mt-6 mb-2">Auth</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <button
          disabled={!!loading}
          onClick={() =>
            run("POST /api/auth/login (FE proxy)", async () => {
              const res = await fetch("/api/v1/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password }),
              });
              const text = await res.text();
              return {
                status: res.status,
                body: tryParseJson(text),
                headers: Object.fromEntries(res.headers.entries()),
              };
            })
          }
          className={btnPrimary}
        >
          {loading === "POST /api/auth/login (FE proxy)"
            ? "..."
            : "FE → /api/auth/login"}
        </button>

        <button
          disabled={!!loading}
          onClick={() =>
            run("GET /api/debug/auth-check", async () => {
              const res = await fetch("/api/v1/debug/auth-check");
              const text = await res.text();
              return {
                status: res.status,
                body: tryParseJson(text),
                headers: Object.fromEntries(res.headers.entries()),
              };
            })
          }
          className={btnSurface}
        >
          {loading === "GET /api/debug/auth-check"
            ? "..."
            : "Check backendUrl + health"}
        </button>

        <button
          disabled={!!loading}
          onClick={() =>
            run(
              "POST backend direct (via /api/debug/login-direct)",
              async () => {
                const res = await fetch("/api/v1/debug/login-direct", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ password }),
                });
                const text = await res.text();
                return {
                  status: res.status,
                  body: tryParseJson(text),
                  headers: Object.fromEntries(res.headers.entries()),
                };
              }
            )
          }
          className={btnSurface}
        >
          {loading === "POST backend direct (via /api/debug/login-direct)"
            ? "..."
            : "Direct → backend"}
        </button>
      </div>

      {/* Section: Feed & RSS */}
      <h2 className="text-sm font-bold mt-6 mb-2">Feed & RSS</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <button
          disabled={!!loading}
          onClick={() =>
            run("GET /api/reader/rss?limit=3&group=false", async () => {
              const res = await fetch("/api/v1/reader/rss?limit=3&group=false");
              const text = await res.text();
              const j = JSON.parse(text) as { data?: { results?: unknown[] } };
              const summary = `total=${j?.data?.results?.length ?? "?"} hasMore=${(j as unknown as { data?: { hasMore?: boolean } })?.data?.hasMore} sampleKeys=${Object.keys(
                (j?.data?.results?.[0] as object) ?? {}
              )
                .slice(0, 8)
                .join(",")}`;
              return {
                status: res.status,
                body: summary + "\n\n" + tryParseJson(text).slice(0, 3000),
              };
            })
          }
          className={btnSurface}
        >
          {loading === "GET /api/reader/rss?limit=3&group=false"
            ? "..."
            : "RSS flat (3)"}
        </button>
        <button
          disabled={!!loading}
          onClick={() =>
            run("GET /api/reader/rss/new?since=0", async () => {
              const res = await fetch("/api/v1/reader/rss/new?since=0");
              const text = await res.text();
              return { status: res.status, body: tryParseJson(text) };
            })
          }
          className={btnSurface}
        >
          {loading === "GET /api/reader/rss/new?since=0"
            ? "..."
            : "RSS new count"}
        </button>
        <button
          disabled={!!loading}
          onClick={() =>
            run("GET /api/reader/queue", async () => {
              const res = await fetch("/api/v1/reader/queue");
              const text = await res.text();
              return { status: res.status, body: tryParseJson(text) };
            })
          }
          className={btnSurface}
        >
          {loading === "GET /api/reader/queue" ? "..." : "Queue depth"}
        </button>
      </div>

      {/* Section: Whitelist / Exclude / ContinueReading / Dashboard */}
      <h2 className="text-sm font-bold mt-6 mb-2">Cron</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <button
          disabled={!!loading}
          onClick={() =>
            run("POST /api/cron?action=update", async () => {
              const res = await fetch("/api/v1/cron?action=update", {
                method: "POST",
              });
              const text = await res.text();
              return {
                status: res.status,
                body: tryParseJson(text).slice(0, 4000),
              };
            })
          }
          className={btnSurface}
        >
          {loading === "POST /api/cron?action=update"
            ? "..."
            : "Trigger cron (update)"}
        </button>
        <button
          disabled={!!loading}
          onClick={() =>
            run("GET /api/cron?action=health", async () => {
              const res = await fetch("/api/v1/cron?action=health");
              const text = await res.text();
              return {
                status: res.status,
                body: tryParseJson(text).slice(0, 3000),
              };
            })
          }
          className={btnSurface}
        >
          {loading === "GET /api/cron?action=health" ? "..." : "Cron health"}
        </button>
      </div>

      <h2 className="text-sm font-bold mt-6 mb-2">
        Whitelist / Exclude / Continue
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <button
          disabled={!!loading}
          onClick={() =>
            run("GET /api/reader/whitelist?page=1&page_size=1", async () => {
              const res = await fetch(
                "/api/v1/reader/whitelist?page=1&page_size=1"
              );
              const text = await res.text();
              return {
                status: res.status,
                body: tryParseJson(text).slice(0, 3000),
              };
            })
          }
          className={btnSurface}
        >
          {loading === "GET /api/reader/whitelist?page=1&page_size=1"
            ? "..."
            : "Whitelist (1)"}
        </button>
        <button
          disabled={!!loading}
          onClick={() =>
            run("GET /api/excluded-titles", async () => {
              const res = await fetch("/api/v1/excluded-titles");
              const text = await res.text();
              return {
                status: res.status,
                body: tryParseJson(text).slice(0, 3000),
              };
            })
          }
          className={btnSurface}
        >
          {loading === "GET /api/excluded-titles" ? "..." : "Excluded titles"}
        </button>
        <button
          disabled={!!loading}
          onClick={() =>
            run("GET /api/reader/continue-reading", async () => {
              const res = await fetch("/api/v1/reader/continue-reading", {
                cache: "no-store",
              });
              const text = await res.text();
              return {
                status: res.status,
                body: tryParseJson(text).slice(0, 3000),
              };
            })
          }
          className={btnSurface}
        >
          {loading === "GET /api/reader/continue-reading"
            ? "..."
            : "ContinueReading"}
        </button>
        <button
          disabled={!!loading}
          onClick={() =>
            run("GET /api/reader/dashboard", async () => {
              const res = await fetch("/api/v1/reader/dashboard");
              const text = await res.text();
              return {
                status: res.status,
                body: tryParseJson(text).slice(0, 3000),
              };
            })
          }
          className={btnSurface}
        >
          {loading === "GET /api/reader/dashboard"
            ? "..."
            : "Dashboard snapshot"}
        </button>
      </div>

      <div className="mt-2 text-xs text-text-muted">
        Semua tombol catch error mentah. `auth-check` pakai{" "}
        <code className="bg-surface px-1 py-0.5 rounded">
          AbortSignal.timeout(8000)
        </code>
        , login pakai 15s. Hasil di-log bawah dengan copy.
      </div>

      {/* Results */}
      <div className="mt-6 space-y-3">
        {results.length === 0 && (
          <div className="text-sm text-text-muted border border-dashed border-border rounded-lg p-4 text-center">
            Belum ada test. Klik salah satu tombol di atas.
          </div>
        )}
        {results.map((r, i) => (
          <div
            key={i}
            className="border border-border bg-surface rounded-lg overflow-hidden"
          >
            <div className="flex items-center justify-between px-3 py-2 bg-bg border-b border-border gap-2">
              <span className="text-sm font-medium truncate">{r.label}</span>
              <span className="text-xs flex gap-2 shrink-0 items-center">
                <span
                  className={`px-2 py-0.5 rounded font-mono ${String(r.status).startsWith("2") ? "bg-green-500/20 text-green-400" : String(r.status).startsWith("5") || r.status === "ERR" ? "bg-red-500/20 text-red-400" : "bg-yellow-500/20 text-yellow-400"}`}
                >
                  {r.status}
                </span>
                <span className="text-text-muted">{fmtMs(r.ms)}</span>
                <button
                  onClick={() => navigator.clipboard.writeText(r.body)}
                  className="px-2 py-0.5 rounded bg-surface border border-border hover:bg-surface-hover text-text-muted"
                >
                  copy
                </button>
              </span>
            </div>
            {r.headers && (
              <div className="px-3 py-2 border-b border-border">
                <div className="text-xs font-medium mb-1">headers</div>
                <pre className="text-xs font-mono whitespace-pre-wrap break-all text-text-muted">
                  {JSON.stringify(r.headers, null, 2).slice(0, 2000)}
                </pre>
              </div>
            )}
            <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-96 overflow-auto">
              {r.body || "(empty)"}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
