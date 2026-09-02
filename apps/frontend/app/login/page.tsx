"use client";

import { useState, FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import {
  Eye,
  EyeSlash,
  WarningCircle,
  ArrowRight,
} from "@phosphor-icons/react";

/**
 * Only allow same-origin, path-only redirects. Rejects absolute URLs,
 * protocol-relative (//), scheme injections (javascript:, data:, vbscript:),
 * backslashes, and control chars. Anything suspicious falls back to "/".
 */
function sanitizeRedirect(raw: string | null): string {
  if (!raw) return "/";
  if (/[\x00-\x1f\\]/.test(raw)) return "/";
  if (/^(https?:)?\/\//i.test(raw)) return "/"; // absolute or protocol-relative
  if (/^(javascript|data|vbscript):/i.test(raw)) return "/"; // scheme injection
  if (!raw.startsWith("/")) return "/"; // must be a path, not a bare host
  return raw;
}

export default function LoginPage() {
  const searchParams = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const err = data.error;
        // Backend returns {error: {message}} OR {error: "string"}
        setError(
          (err && typeof err === "object" ? err.message : err) || "Login failed"
        );
        return;
      }

      const redirect = sanitizeRedirect(searchParams.get("redirect"));
      window.location.href = redirect;
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen bg-bg flex items-center justify-center px-4 overflow-hidden">
      {/* Ambient glow — radial accent from center, fades to bg */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 45%, rgba(129,140,248,0.06) 0%, transparent 70%)",
        }}
      />

      {/* Subtle dot grid — adds texture without weight */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        aria-hidden
        style={{
          backgroundImage:
            "radial-gradient(circle, var(--color-border) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />

      <div className="relative z-10 w-full max-w-95 animate-fade-in-up">
        {/* Brand mark */}
        <div className="flex flex-col items-center mb-8">
          <h1 className="text-2xl font-bold tracking-tight text-text">
            Manhwa<span className="text-accent">Scanner</span>
          </h1>
          <p className="text-text-muted text-sm mt-1.5 tracking-wide uppercase">
            dashboard
          </p>
        </div>

        {/* Login card */}
        <form
          onSubmit={handleSubmit}
          className="bg-surface border border-border rounded-xl p-6 space-y-5 shadow-lg shadow-black/20"
        >
          {/* Error message — hidden completely when no error to avoid empty space from space-y-5 */}
          {error && (
            <div
              className="flex items-start gap-2.5 rounded-lg px-3.5 py-2.5 text-sm bg-danger-dim border border-danger/20 text-danger"
              role="alert"
            >
              <WarningCircle
                weight="fill"
                size={16}
                className="mt-0.5 shrink-0"
              />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label
              htmlFor="password"
              className="block text-[13px] font-medium text-text-secondary mb-2"
            >
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-bg border border-border rounded-lg px-3.5 py-2.5 pr-10 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20 transition-all duration-150"
                placeholder="Enter password"
                autoComplete="current-password"
                autoFocus
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-text-muted hover:text-text-secondary transition-colors duration-150 cursor-pointer"
                tabIndex={-1}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? (
                  <EyeSlash size={16} weight="regular" />
                ) : (
                  <Eye size={16} weight="regular" />
                )}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || !password}
            className="w-full bg-accent hover:bg-accent-hover text-black text-sm font-medium rounded-lg px-4 py-2.5 transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer"
          >
            {loading ? (
              <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <>
                Sign in
                <ArrowRight weight="bold" size={14} />
              </>
            )}
          </button>
        </form>

        {/* Minimal footer */}
        <p className="text-center text-text-muted text-xs mt-8 tracking-wide">
          secured access only
        </p>
      </div>
    </div>
  );
}
