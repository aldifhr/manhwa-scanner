/** Normalize backend origin names → canonical frontend names.
 *  Handles both country codes (KR/JP/CN) and source slugs (manhwa/manga/manhua).
 *  Single source of truth — do NOT re-implement in components. */
export function normalizeOrigin(origin: string | null | undefined): string {
  const v = (origin || "").toUpperCase();
  if (v === "KR" || v === "MANHWA") return "korean";
  if (v === "JP" || v === "MANGA") return "japanese";
  if (v === "CN" || v === "MANHUA") return "chinese";
  return (origin || "").toLowerCase();
}

const ORIGIN_FLAG: Record<string, string> = {
  korean: "/kr.png",
  japanese: "/jp.png",
  chinese: "/cn.png",
  manhwa: "/kr.png",
  manga: "/jp.png",
  manhua: "/cn.png",
};

export function getOriginFlag(origin: string | null | undefined): string {
  if (!origin) return "";
  return ORIGIN_FLAG[normalizeOrigin(origin)] ?? "";
}

