/**
 * Sentry Edge Stub (Sentry disabled)
 */

export async function initSentry(): Promise<void> {
  // No-op
}

export function captureException(error: any, context?: any): void {
  console.error("[Sentry Edge Disabled] Error:", error?.message || error, context);
}

export function captureMessage(message: string, level: string = "info"): void {
  console.log(`[Sentry Edge Disabled] ${level}:`, message);
}

export function setUser(userId: string, extras?: any): void {
  // No-op
}

export function addBreadcrumb(message: string, category?: string, data?: any): void {
  // No-op
}

export function wrapWithSentry<T extends (...args: unknown[]) => unknown>(
  name: string,
  fn: T
): T {
  return fn;
}
