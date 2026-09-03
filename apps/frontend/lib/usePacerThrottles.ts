"use client";
import { useThrottledCallback } from "@tanstack/react-pacer";
import { useRateLimitedCallback } from "@tanstack/react-pacer";

export function usePacerThrottledScroll(fn: () => void, wait = 250) {
  return useThrottledCallback(fn, { wait });
}

export function usePacerRateLimitedWL(fn: (...args: any[]) => Promise<any>) {
  return useRateLimitedCallback(fn, { limit: 5, window: 10_000 } as any);
}
