"use client";
import { withCsrf } from "@/lib/csrf";

export function useAuth() {
  const logout = async () => {
    console.log("[logout] clicked", { cookie: document.cookie.slice(0, 200) });
    try {
      const res = await fetch("/api/v1/auth/logout", withCsrf({ method: "POST", credentials: "include" as RequestCredentials }));
      console.log("[logout] response", { status: res.status, ok: res.ok });
      const body = await res.text().catch(() => "");
      console.log("[logout] body", body.slice(0, 200));
    } catch (e) {
      console.error("[logout] fetch error", e);
    }
    try { localStorage.removeItem("alltab-ui"); } catch {}
    console.log("[logout] redirect to /login");
    window.location.href = "/login";
  };
  return { logout };
}
