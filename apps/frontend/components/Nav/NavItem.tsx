"use client";
import Link from "next/link";
import type { ComponentType } from "react";
import type { IconProps } from "@phosphor-icons/react";

export function NavItem({
  href,
  label,
  icon: Icon,
  active,
  variant = "desktop",
  onPrefetch,
  onClick,
}: {
  href: string;
  label: string;
  icon: ComponentType<IconProps>;
  active: boolean;
  variant?: "desktop" | "mobile" | "bottom";
  onPrefetch?: (href: string) => void;
  onClick?: () => void;
}) {
  if (variant === "bottom") {
    return (
      <Link
        href={href}
        onClick={onClick}
        onMouseEnter={() => onPrefetch?.(href)}
        className={`flex flex-col items-center justify-center gap-1 flex-1 py-2 rounded-lg transition-colors ${active ? "text-white" : "text-white/50"}`}
        aria-current={active ? "page" : undefined}
      >
        <Icon size={22} weight={active ? "fill" : "regular"} />
        <span className="text-[10px] font-medium">{label}</span>
      </Link>
    );
  }
  if (variant === "mobile") {
    return (
      <Link
        href={href}
        onClick={onClick}
        onMouseEnter={() => onPrefetch?.(href)}
        className={`flex items-center gap-3 px-4 py-3 rounded-lg text-base font-medium transition-colors ${active ? "bg-white/10 text-white" : "text-white/60 hover:text-white hover:bg-white/5"}`}
        aria-current={active ? "page" : undefined}
      >
        <Icon size={20} weight={active ? "fill" : "regular"} />
        {label}
      </Link>
    );
  }
  return (
    <Link
      href={href}
      onClick={onClick}
      onMouseEnter={() => onPrefetch?.(href)}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${active ? "bg-white/10 text-white" : "text-white/60 hover:text-white hover:bg-white/5"}`}
      aria-current={active ? "page" : undefined}
    >
      <Icon size={16} weight={active ? "fill" : "regular"} />
      {label}
    </Link>
  );
}
