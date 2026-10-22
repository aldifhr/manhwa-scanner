"use client";

import { usePathname } from "next/navigation";
import Navbar from "@/components/Navbar";
import Announcement from "@/components/Announcement";
import { CommandPalette } from "@/components/CommandPalette";

export default function RouteChrome() {
  const pathname = usePathname();
  if (pathname === "/") return null;
  return (
    <>
      <Announcement />
      <Navbar />
      <CommandPalette />
    </>
  );
}
