/**
 * Adaptive rate limiter for controlling HTTP request timing based on response times.
 * Extracted from types.ts to keep type definitions separate from business logic.
 */
export class AdaptiveRateLimiter {
  private responseTimeHistory: number[] = [];
  private maxHistorySize = 10;
  private currentBaseDelayMs = 350;

  recordResponseTime(durationMs: number) {
    this.responseTimeHistory.push(durationMs);
    if (this.responseTimeHistory.length > this.maxHistorySize) {
      this.responseTimeHistory.shift();
    }

    const avg =
      this.responseTimeHistory.reduce((a, b) => a + b, 0) /
      this.responseTimeHistory.length;

    if (avg > 2000) {
      this.currentBaseDelayMs = Math.min(this.currentBaseDelayMs * 1.2, 1000);
    } else if (avg < 500) {
      this.currentBaseDelayMs = Math.max(this.currentBaseDelayMs * 0.9, 200);
    }
  }

  getDelay(): number {
    return Math.round(this.currentBaseDelayMs);
  }

  reset() {
    this.responseTimeHistory.length = 0;
    this.currentBaseDelayMs = 350;
  }
}
