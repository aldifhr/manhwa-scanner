"use client";

import { ArrowUp } from "@phosphor-icons/react";
import { useScrollVisibility } from "@/lib/hooks/useScrollVisibility";

export default function BackToTop() {
  const visible = useScrollVisibility(300);

  const scrollToTop = () => window.scrollTo({ top: 0, behavior: "smooth" });

  return (
    <button
      onClick={scrollToTop}
      aria-label="Back to top"
      className={`
        fixed bottom-6 right-6 z-40 safe-bottom
        w-11 h-11 rounded-full
        bg-white/10 hover:bg-white/20
        text-white shadow-lg shadow-black/30 border border-white/10
        transition-all duration-300
        hover:scale-110
        flex items-center justify-center
        ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3 pointer-events-none"}
      `}
    >
      <ArrowUp size={20} weight="bold" />
    </button>
  );
}
