"use client";
import { useDebouncedValue } from "@tanstack/react-pacer";

export function usePacerDebouncedValue<T>(value: T, wait = 300): T {
  const [debounced] = useDebouncedValue(value, { wait });
  return debounced;
}
