export interface ContinueReadingEntry {
  title: string;
  titleKey: string;
  cover: string | null;
  source: string;
  lastChapter: string;
  chapterUrl: string;
  seriesUrl: string;
  origin: string;
  updatedAt: string;
}
export const MAX_ENTRIES = 20;
export function buildEntryFromChapter(_ch: any): ContinueReadingEntry | null { return null; }
export async function fetchRemote(): Promise<Record<string, ContinueReadingEntry>> { return {}; }
export async function pushRemote(_c: any): Promise<void> {}
// svelte stub — real hook port pending (Task 4)
export function useContinueReading() {
  return { entries: new Map<string, ContinueReadingEntry>(), trackReading: (_: any)=>{}, trackChapter: (_: any)=>{}, removeReading: (_: any)=>{}, clearAll: ()=>{} };
}
