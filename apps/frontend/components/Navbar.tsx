"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOut } from "@phosphor-icons/react";
import { isNavActive, NAV } from "@/lib/nav";
import { NavItem } from "@/components/Nav/NavItem";
import { useAuth } from "@/components/Nav/useAuth";
import { usePrefetch } from "@/components/Nav/usePrefetch";
import NavbarStatus from "@/components/NavbarStatus";

export default function Navbar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { logout } = useAuth();
  const prefetch = usePrefetch();

  return (
    <nav className="sticky top-0 z-50 bg-black/95 backdrop-blur-md border-b border-white/10 safe-area-top">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center h-14 sm:h-16 gap-4 sm:gap-8">
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <span className="text-white font-bold text-lg tracking-tight">
              ManhwaScan
            </span>
          </Link>

          <div className="hidden md:flex items-center gap-1 ml-4">
            {NAV.map(({ href, label, icon }) => (
              <NavItem
                key={href}
                href={href}
                label={label}
                icon={icon}
                active={isNavActive(href, pathname)}
                onPrefetch={prefetch}
              />
            ))}
          </div>

          <div className="flex-1" />

          <NavbarStatus />

          <button
            onClick={logout}
            title="Logout"
            aria-label="Logout"
            className="hidden md:flex items-center justify-center p-2 rounded-lg text-white/60 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <SignOut size={18} />
          </button>

          <button
            onClick={() => setMobileOpen((v) => !v)}
            className="md:hidden p-3 rounded-lg text-white/60 hover:text-white hover:bg-white/5 transition-colors"
            aria-label="Menu"
          >
            {mobileOpen ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path
                  d="M18 6L6 18M6 6l12 12"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path
                  d="M4 6h16M4 12h16M4 18h16"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        </div>

        {/* Mobile hamburger menu */}
        {mobileOpen && (
          <div className="md:hidden pb-4 space-y-1 border-t border-white/10 pt-2">
            {NAV.map(({ href, label, icon }) => (
              <NavItem
                key={href}
                href={href}
                label={label}
                icon={icon}
                active={isNavActive(href, pathname)}
                variant="mobile"
                onPrefetch={prefetch}
                onClick={() => setMobileOpen(false)}
              />
            ))}
            <NavbarStatus variant="mobile" />
            <button
              onClick={logout}
              className="flex items-center gap-3 w-full px-4 py-3 rounded-lg text-base font-medium text-white/60 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <SignOut size={20} />
              Logout
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
