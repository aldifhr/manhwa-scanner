"use client";
import { useState, FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import {
  Eye,
  EyeSlash,
  WarningCircle,
  ArrowRight,
  Shield,
  User,
} from "@phosphor-icons/react";

function sanitizeRedirect(raw: string | null): string {
  if (!raw) return "/";
  if (/[\x00-\x1f\\]/.test(raw)) return "/";
  if (/^(https?:)?\/\//i.test(raw)) return "/";
  if (/^(javascript|data|vbscript):/i.test(raw)) return "/";
  if (!raw.startsWith("/")) return "/";
  return raw;
}

export default function LoginPage() {
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<"member" | "admin">("member");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const body: Record<string, string> = { password };
      if (mode === "member") {
        if (!email.trim()) {
          setError("Email wajib untuk member");
          setLoading(false);
          return;
        }
        body.email = email.trim().toLowerCase();
      }
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const err = data.error;
        setError(
          (err && typeof err === "object" ? err.message : err) || "Login failed"
        );
        return;
      }
      window.location.href = sanitizeRedirect(searchParams.get("redirect"));
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen bg-bg flex items-center justify-center px-4 overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 45%, rgba(129,140,248,0.06) 0%, transparent 70%)",
        }}
      />
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
        <div className="flex flex-col items-center mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-text">
            Manhwa<span className="text-accent">Scanner</span>
          </h1>
          <p className="text-text-muted text-sm mt-1.5 tracking-wide uppercase">
            dashboard
          </p>
        </div>

        <div className="flex p-1 rounded-xl bg-bg border border-border mb-4">
          <button
            type="button"
            onClick={() => {
              setMode("member");
              setError("");
            }}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors ${mode === "member" ? "bg-surface border border-border text-text shadow-sm" : "text-text-muted hover:text-text"}`}
          >
            <User size={14} /> Member
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("admin");
              setError("");
            }}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors ${mode === "admin" ? "bg-surface border border-border text-text shadow-sm" : "text-text-muted hover:text-text"}`}
          >
            <Shield size={14} /> Admin
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-surface border border-border rounded-xl p-6 space-y-5 shadow-lg shadow-black/20"
        >
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
          {mode === "member" && (
            <div>
              <label className="block text-[13px] font-medium text-text-secondary mb-2">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                required={mode === "member"}
                autoComplete="email"
                autoFocus={mode === "member"}
                className="w-full bg-bg border border-border rounded-lg px-3.5 py-2.5 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
              />
            </div>
          )}
          {mode === "admin" && (
            <p className="text-xs text-text-muted bg-bg border border-border rounded-lg px-3 py-2">
              Login admin pakai <b>MONITOR_AUTH_TOKEN</b> — tanpa email.
            </p>
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
                placeholder={
                  mode === "admin" ? "Admin password" : "Member password"
                }
                autoComplete="current-password"
                autoFocus={mode === "admin"}
                required
                className="w-full bg-bg border border-border rounded-lg px-3.5 py-2.5 pr-10 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-text-muted hover:text-text"
                tabIndex={-1}
                aria-label={showPassword ? "Hide" : "Show"}
              >
                {showPassword ? <EyeSlash size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <button
            type="submit"
            disabled={loading || !password || (mode === "member" && !email)}
            className="w-full bg-accent hover:bg-accent-hover text-black text-sm font-medium rounded-lg px-4 py-2.5 flex items-center justify-center gap-2 disabled:opacity-40"
          >
            {loading ? (
              <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <>
                {mode === "admin" ? "Sign in as Admin" : "Sign in as Member"}{" "}
                <ArrowRight weight="bold" size={14} />
              </>
            )}
          </button>
        </form>
        {mode === "member" && (
          <p className="text-center text-xs text-text-muted mt-4">
            Belum punya akun?{" "}
            <a href="/register" className="text-accent hover:underline">
              Register member
            </a>
          </p>
        )}
        <p className="text-center text-text-muted text-xs mt-2 tracking-wide">
          secured access only
        </p>
      </div>
    </div>
  );
}
