/**
 * Sentry Stub (Sentry disabled)
 */

export function initSentry(): void {
  // Sentry disabled
}

export function captureException(error: Error, context?: Record<string, unknown>): void {
  console.error("[Error captured]:", error.message, context);
}

export function captureMessage(message: string, level: "info" | "warning" | "error" = "info"): void {
  console.log(`[Message captured ${level}]:`, message);
}

export function setUser(userId: string, extras: Record<string, unknown> = {}): void {
  // No-op
}

export function addBreadcrumb(message: string, category?: string, data?: Record<string, unknown>): void {
  // No-op
}

export function wrapWithSentry<T extends (...args: unknown[]) => unknown>(
  name: string,
  fn: T
): T {
  return fn;
}
