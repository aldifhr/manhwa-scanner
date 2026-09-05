"use client";
import { useDebounced } from "./useDebounced";

export function usePacerDebouncedValue<T>(value: T, wait = 300): T {
  return useDebounced(value, wait);
}
