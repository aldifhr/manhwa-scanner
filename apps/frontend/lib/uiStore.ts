import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

type Feed = "all" | "nowl" | "wl";
type SortMode = "newest" | "title";
type ContentView = "all" | "fav";

interface UiState {
  feed: Feed;
  groupMode: boolean;
  sortMode: SortMode;
  contentView: ContentView;
  sourceFilter: string | null;
  countryFilter: string | null;
  typeFilter: string | null;
  searchQuery: string;
  setFeed: (f: Feed) => void;
  toggleGroupMode: () => void;
  setSortMode: (s: SortMode) => void;
  setContentView: (v: ContentView) => void;
  setSourceFilter: (s: string | null) => void;
  setCountryFilter: (c: string | null) => void;
  setTypeFilter: (t: string | null) => void;
  setSearchQuery: (q: string) => void;
  resetFilters: () => void;
}

/**
 * Global UI preferences for the All feed (shared across tabs in the future).
 * Persisted to localStorage so view/filter/sort choices survive reloads.
 * `createJSONStorage` is SSR-safe: on the server the getter throws and the
 * middleware falls back to in-memory (see zustand's createJSONStorage).
 */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      feed: "all",
      groupMode: false,
      sortMode: "newest",
      contentView: "all",
      sourceFilter: null,
      countryFilter: null,
      typeFilter: null,
      searchQuery: "",
      setFeed: (feed) => set({ feed }),
      toggleGroupMode: () => set((s) => ({ groupMode: !s.groupMode })),
      setSortMode: (sortMode) => set({ sortMode }),
      setContentView: (contentView) => set({ contentView }),
      setSourceFilter: (sourceFilter) => set({ sourceFilter }),
      setCountryFilter: (countryFilter) => set({ countryFilter }),
      setTypeFilter: (typeFilter) => set({ typeFilter }),
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      resetFilters: () =>
        set({
          sourceFilter: null,
          countryFilter: null,
          typeFilter: null,
          searchQuery: "",
        }),
    }),
    {
      name: "alltab-ui",
      storage: createJSONStorage(() =>
        typeof window !== "undefined"
          ? localStorage
          : (undefined as unknown as Storage)
      ),
      partialize: (s) => ({
        feed: s.feed,
        groupMode: s.groupMode,
        sortMode: s.sortMode,
        contentView: s.contentView,
        sourceFilter: s.sourceFilter,
        countryFilter: s.countryFilter,
        typeFilter: s.typeFilter,
        searchQuery: s.searchQuery,
      }),
    }
  )
);
