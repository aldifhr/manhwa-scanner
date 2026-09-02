"use client";
import { withCsrf } from "@/lib/csrf";

export function useAuth() {
  const logout = async () => {
    await fetch("/api/auth/logout", withCsrf({ method: "POST" }));
    window.location.href = "/login";
  };
  return { logout };
}
