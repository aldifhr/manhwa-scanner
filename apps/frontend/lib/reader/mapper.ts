// mapper — snake→camel, single place for BE↔FE field renames
export function mapWhitelist(r: Record<string, unknown>) {
  return {
    ...r,
    titleKey: (r.title_key as string) ?? (r.titleKey as string),
    seriesUrl: (r.series_url as string) ?? (r.seriesUrl as string),
    canonicalTitleKey: (r.canonical_title_key as string) ?? (r.canonicalTitleKey as string),
  };
}
export function mapHistory(r: Record<string, unknown>) {
  return r;
}
export function mapRss(r: Record<string, unknown>) {
  return {
    ...r,
    titleKey: (r.title_key as string) ?? (r.titleKey as string),
    chapterUrl: (r.chapter_url as string) ?? (r.chapterUrl as string),
    seriesUrl: (r.series_url as string) ?? (r.seriesUrl as string),
    isWhitelisted: (r.is_whitelisted as boolean) ?? (r.isWhitelisted as boolean),
  };
}
export function mapExcluded(r: Record<string, unknown>) {
  return {
    ...r,
    titleKey: (r.title_key as string) ?? (r.titleKey as string) ?? (r.id as string) ?? "",
  };
}
