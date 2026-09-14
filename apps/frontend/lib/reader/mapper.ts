// mapper — snake→camel, single place for BE↔FE field renames
export function mapWhitelist(r: unknown) {
  const x = r as Record<string, unknown>;
  return {
    ...x,
    titleKey: (x.title_key as string) ?? (x.titleKey as string),
    seriesUrl: (x.series_url as string) ?? (x.seriesUrl as string),
    canonicalTitleKey:
      (x.canonical_title_key as string) ?? (x.canonicalTitleKey as string),
  };
}
export function mapHistory(r: unknown) {
  return r as Record<string, unknown>;
}
export function mapRss(r: unknown) {
  const x = r as Record<string, unknown>;
  return {
    ...x,
    titleKey: (x.title_key as string) ?? (x.titleKey as string),
    chapterUrl: (x.chapter_url as string) ?? (x.chapterUrl as string),
    seriesUrl: (x.series_url as string) ?? (x.seriesUrl as string),
    isWhitelisted:
      (x.is_whitelisted as boolean) ?? (x.isWhitelisted as boolean),
  };
}
export function mapExcluded(r: unknown) {
  const x = r as Record<string, unknown>;
  return {
    ...x,
    titleKey:
      (x.title_key as string) ??
      (x.titleKey as string) ??
      (x.id as string) ??
      "",
  };
}
