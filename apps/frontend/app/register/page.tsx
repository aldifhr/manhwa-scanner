"use client";
import { useState, FormEvent } from "react";
import Link from "next/link";
import {
  Eye,
  EyeSlash,
  WarningCircle,
  ArrowRight,
} from "@phosphor-icons/react";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Password tidak sama");
      return;
    }
    if (password.length < 6) {
      setError("Password min 6 char");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data.error as string) || "Register gagal");
        return;
      }
      window.location.href = "/";
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <div className="w-full max-w-95">
        <div className="flex flex-col items-center mb-8">
          <h1 className="text-2xl font-bold tracking-tight text-text">
            Manhwa<span className="text-accent">Scanner</span>
          </h1>
          <p className="text-text-muted text-sm mt-1.5">member register</p>
        </div>
        <form
          onSubmit={handleSubmit}
          className="bg-surface border border-border rounded-xl p-6 space-y-5 shadow-lg"
        >
          {error && (
            <div
              className="flex gap-2 rounded-lg px-3.5 py-2.5 text-sm bg-danger-dim border border-danger/20 text-danger"
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
            <label className="block text-[13px] font-medium text-text-secondary mb-2">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@email.com"
              required
              className="w-full bg-bg border border-border rounded-lg px-3.5 py-2.5 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
            />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-2">
              Password
            </label>
            <div className="relative">
              <input
                type={show ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="min 6 char"
                required
                className="w-full bg-bg border border-border rounded-lg px-3.5 py-2.5 pr-10 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
              />
              <button
                type="button"
                onClick={() => setShow(!show)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text"
              >
                {show ? <EyeSlash size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-2">
              Confirm
            </label>
            <input
              type={show ? "text" : "password"}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="ulang password"
              required
              className="w-full bg-bg border border-border rounded-lg px-3.5 py-2.5 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !email || !password}
            className="w-full bg-accent hover:bg-accent-hover text-black text-sm font-medium rounded-lg px-4 py-2.5 flex items-center justify-center gap-2 disabled:opacity-40"
          >
            {loading ? (
              <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <>
                Register <ArrowRight weight="bold" size={14} />
              </>
            )}
          </button>
          <p className="text-center text-xs text-text-muted">
            Sudah punya akun?{" "}
            <Link href="/login" className="text-accent hover:underline">
              Login
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
