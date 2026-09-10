import {
  House,
  Compass,
  Books,
  EyeSlash,
  Clock,
  ChartBar,
  CheckCircle,
} from "@phosphor-icons/react";

/** Central nav definition — single source for Navbar + mobile bottom nav */
export const NAV = [
  { href: "/", label: "Home", icon: House },
  { href: "/recent", label: "Recent", icon: Compass },
  { href: "/whitelist", label: "Whitelist", icon: Books } as const,
  { href: "/exclude-list", label: "Exclude", icon: EyeSlash } as const,
  { href: "/completed", label: "Completed", icon: CheckCircle } as const,
  { href: "/dispatch-history", label: "History", icon: Clock } as const,
] as const;

/** Sidebar / nav active-state helper (single source of truth).
 *
 * `/whitelist` must be EXACT so its child route `/whitelist/chapters`
 * doesn't light up BOTH the "Whitelist" and "Chapters" items. All other
 * nav items match by prefix.
 */
export function isNavActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/whitelist") return pathname === "/whitelist";
  return pathname.startsWith(href);
}
