/** Central nav definition — single source for Navbar + mobile bottom nav
 * Svelte port: icons as string names (phosphor names), not React components.
 * Components map names to @phosphor-icons/svelte or lucide at render time.
 */
export const NAV = [
  { href: "/", label: "Home", icon: "House" },
  { href: "/recent", label: "Recent", icon: "Compass" },
  { href: "/whitelist", label: "Whitelist", icon: "Books" } as const,
  { href: "/exclude-list", label: "Exclude", icon: "EyeSlash" } as const,
  { href: "/dispatch-history", label: "History", icon: "Clock" } as const,
] as const;

export function isNavActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/whitelist") return pathname === "/whitelist";
  return pathname.startsWith(href);
}

