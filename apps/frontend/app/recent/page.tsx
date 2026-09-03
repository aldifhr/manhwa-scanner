"use client";

import AllTab from "@/components/home/AllTab";
import BackToTop from "@/components/BackToTop";
import { ContinueReadingStrip } from "@/components/ContinueReadingStrip";

export default function RecentPage() {
  return (
    <>
      <ContinueReadingStrip />
      <AllTab />
      <BackToTop />
    </>
  );
}
