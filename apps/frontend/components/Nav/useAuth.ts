"use client";
import { withCsrf } from "@/lib/csrf";

function clearClientCookies() {
  // Fallback client-side clear — ensures UI flips even if Set-Cookie from
  // server is ignored (e.g., Secure mismatch on http localhost).
  try {
    const opts = "path=/; Max-Age=0; SameSite=Lax";
    document.cookie = `ikiru_csrf_token=; ${opts}`;
    document.cookie = `ikiru_dashboard_session=; ${opts}`;
    // legacy domain variants — no-op on localhost but harmless
    document.cookie = `ikiru_csrf_token=; ${opts}; domain=.aldifhr.fun`;
    document.cookie = `ikiru_dashboard_session=; ${opts}; domain=.aldifhr.fun`;
  } catch {}
}

export function useAuth() {
  const logout = async () => {
    try {
      await fetch("/api/v1/auth/logout", withCsrf({ method: "POST", credentials: "include" as RequestCredentials }));
    } catch {}
    try { localStorage.removeItem("alltab-ui"); } catch {}
    clearClientCookies();
    window.location.replace("/login");
    setTimeout(() => { if (window.location.pathname !== "/login") window.location.href = "/login"; }, 500);
  };
  return { logout };
}
