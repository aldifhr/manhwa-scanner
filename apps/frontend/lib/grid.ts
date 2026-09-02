export const GRID_CLASS =
  "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3";

export function gridClass(cols: 6 | 4 = 6): string {
  if (cols === 4) return "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3";
  return GRID_CLASS;
}
