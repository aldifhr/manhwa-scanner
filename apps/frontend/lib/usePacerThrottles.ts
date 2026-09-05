"use client";
import { useCallback, useRef } from "react";

export function usePacerThrottledScroll(fn: () => void, wait = 250) {
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(() => {
    const now = Date.now();
    const remaining = wait - (now - last.current);
    if (remaining <= 0) {
      if (timer.current) clearTimeout(timer.current);
      last.current = now;
      fn();
    } else if (!timer.current) {
      timer.current = setTimeout(() => {
        last.current = Date.now();
        timer.current = null;
        fn();
      }, remaining);
    }
  }, [fn, wait]);
}

export function usePacerRateLimitedWL<T extends unknown[]>(
  fn: (...args: T) => unknown
) {
  const calls = useRef<number[]>([]);
  return useCallback(
    async (...args: T) => {
      const now = Date.now();
      calls.current = calls.current.filter((t) => now - t < 10_000);
      if (calls.current.length >= 5) return;
      calls.current.push(now);
      return fn(...args);
    },
    [fn]
  );
}
