/**
 * Type-safe error handling utilities
 * Replace all `any` types with proper type guards
 */

/**
 * Type guard to check if value is an Error
 */
export function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * Type guard to check if value has a message property
 */
export function hasMessage(value: unknown): value is { message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
  );
}

/**
 * Type guard to check if value has a code property
 */
export function hasCode(value: unknown): value is { code: string | number } {
  const obj = value as { code: unknown };
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    (typeof obj.code === "string" || typeof obj.code === "number")
  );
}

/**
 * Safely extract error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (isError(error)) {
    return error.message;
  }
  
  if (hasMessage(error)) {
    return error.message;
  }
  
  if (typeof error === "string") {
    return error;
  }
  
  return String(error);
}

/**
 * Safely extract error code from unknown error
 */
export function getErrorCode(error: unknown): string | number | undefined {
  if (hasCode(error)) {
    return error.code;
  }
  
  return undefined;
}

/**
 * Convert unknown error to Error instance
 */
export function toError(error: unknown): Error {
  if (isError(error)) {
    return error;
  }
  
  const message = getErrorMessage(error);
  const err = new Error(message);
  
  // Preserve stack trace if available
  if (typeof error === "object" && error !== null && "stack" in error) {
    err.stack = String((error as { stack: unknown }).stack);
  }
  
  return err;
}

/**
 * Type-safe JSON parse
 */
export function safeJsonParse<T = unknown>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * Type guard for objects
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Type guard for arrays
 */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Type guard for strings
 */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Type guard for numbers
 */
export function isNumber(value: unknown): value is number {
  return typeof value === "number" && !isNaN(value);
}

/**
 * Type guard for booleans
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Safely get property from object
 */
export function getProperty<T = unknown>(
  obj: unknown,
  key: string,
  defaultValue?: T
): T | undefined {
  if (!isObject(obj)) {
    return defaultValue;
  }
  
  const value = obj[key];
  return value !== undefined ? (value as T) : defaultValue;
}

/**
 * Type-safe async error handler
 */
export async function tryCatch<T>(
  fn: () => Promise<T>,
  onError?: (error: Error) => T | Promise<T>
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    const err = toError(error);
    if (onError) {
      return await onError(err);
    }
    return undefined;
  }
}

/**
 * Type-safe sync error handler
 */
export function tryCatchSync<T>(
  fn: () => T,
  onError?: (error: Error) => T
): T | undefined {
  try {
    return fn();
  } catch (error) {
    const err = toError(error);
    if (onError) {
      return onError(err);
    }
    return undefined;
  }
}
