"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOut, X } from "@phosphor-icons/react";
import { motion, AnimatePresence } from "framer-motion";
import { isNavActive, NAV } from "@/lib/nav";
import { NavItem } from "@/components/Nav/NavItem";
import { useAuth } from "@/components/Nav/useAuth";
import { usePrefetch } from "@/components/Nav/usePrefetch";
import NavbarStatus from "@/components/NavbarStatus";
import { getRole } from "@/lib/auth";

export default function Navbar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { logout } = useAuth();
  const prefetch = usePrefetch();
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    const m = document.cookie.match(
      /(?:^|;\s*)ikiru_dashboard_session=([^;]*)/
    );
    setIsAdmin(m ? getRole(m[1]) === "admin" : false);
  }, [pathname]);

  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <nav className="sticky top-0 z-50 bg-black/95 backdrop-blur-md border-b border-white/10 safe-area-top">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center h-14 sm:h-16 gap-4 sm:gap-8">
            <Link
              href="/"
              className="flex items-center gap-2 shrink-0"
              onClick={() => setOpen(false)}
            >
              <span className="text-white font-bold text-lg tracking-tight">
                ManhwaScan
              </span>
            </Link>

            <div className="hidden md:flex items-center gap-1 ml-4">
              {NAV.filter((n) => !(n as any).adminOnly || isAdmin).map(
                ({ href, label, icon }) => (
                  <NavItem
                    key={href}
                    href={href}
                    label={label}
                    icon={icon}
                    active={isNavActive(href, pathname)}
                    onPrefetch={prefetch}
                  />
                )
              )}
            </div>

            <div className="flex-1" />
            <NavbarStatus />
            <div
              className="hidden md:block w-px h-6 bg-white/10 mx-2"
              aria-hidden
            />
            <button
              onClick={logout}
              title="Logout"
              aria-label="Logout"
              className="hidden md:flex items-center justify-center p-2 ml-1 rounded-lg text-white/60 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <SignOut size={18} />
            </button>

            <button
              onClick={() => setOpen(true)}
              className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-lg bg-white/5 border border-white/10 text-white hover:bg-white/10 transition-colors"
              aria-label="Open menu"
              aria-expanded={open}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden
              >
                <path
                  d="M4 7h16M4 12h16M4 17h16"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </nav>

      {/* Mobile drawer */}
      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-[60] md:hidden">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setOpen(false)}
              aria-hidden
            />
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 28, stiffness: 320 }}
              className="absolute right-0 top-0 h-full w-[82%] max-w-[320px] bg-zinc-950 border-l border-white/10 flex flex-col shadow-2xl"
            >
              <div className="flex items-center justify-between h-14 px-4 border-b border-white/10 shrink-0">
                <span className="font-bold text-white">Menu</span>
                <button
                  onClick={() => setOpen(false)}
                  aria-label="Close menu"
                  className="w-9 h-9 inline-flex items-center justify-center rounded-lg bg-white/5 border border-white/10 text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto py-3 px-2 space-y-1">
                {NAV.filter((n) => !(n as any).adminOnly || isAdmin).map(
                  ({ href, label, icon }) => (
                    <NavItem
                      key={href}
                      href={href}
                      label={label}
                      icon={icon}
                      active={isNavActive(href, pathname)}
                      variant="mobile"
                      onPrefetch={prefetch}
                      onClick={() => setOpen(false)}
                    />
                  )
                )}
              </div>

              <div className="p-3 border-t border-white/10 space-y-3 bg-black/20">
                <NavbarStatus variant="mobile" />
                <button
                  onClick={() => {
                    setOpen(false);
                    logout();
                  }}
                  className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 hover:text-red-300 font-medium transition-colors"
                >
                  <SignOut size={18} /> Logout
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
