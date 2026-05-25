/**
 * Standardized Error Handling System
 * Provides consistent error types, handling, and logging across the codebase
 */

import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "errors" });

/**
 * Base error class with additional context
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly context?: Record<string, unknown>;
  public readonly timestamp: string;

  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    isOperational: boolean = true,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.context = context;
    this.timestamp = new Date().toISOString();

    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      context: this.context,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }
}

/**
 * Retryable errors - operations that can be retried
 */
export class RetryableError extends AppError {
  public readonly retryAfterMs?: number;

  constructor(
    message: string,
    code: string = "RETRYABLE_ERROR",
    retryAfterMs?: number,
    context?: Record<string, unknown>
  ) {
    super(message, code, 503, true, context);
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Fatal errors - operations that should not be retried
 */
export class FatalError extends AppError {
  constructor(
    message: string,
    code: string = "FATAL_ERROR",
    context?: Record<string, unknown>
  ) {
    super(message, code, 500, false, context);
  }
}

/**
 * Validation errors
 */
export class ValidationError extends AppError {
  constructor(
    message: string,
    code: string = "VALIDATION_ERROR",
    context?: Record<string, unknown>
  ) {
    super(message, code, 400, true, context);
  }
}

/**
 * Timeout errors
 */
export class TimeoutError extends RetryableError {
  constructor(
    message: string = "Operation timed out",
    timeoutMs?: number,
    context?: Record<string, unknown>
  ) {
    super(message, "TIMEOUT", timeoutMs, { ...context, timeoutMs });
  }
}

/**
 * Rate limit errors
 */
export class RateLimitError extends RetryableError {
  constructor(
    message: string = "Rate limit exceeded",
    retryAfterMs?: number,
    context?: Record<string, unknown>
  ) {
    super(message, "RATE_LIMIT", retryAfterMs, context);
  }
}

/**
 * External service errors (API, scraping, etc)
 */
export class ExternalServiceError extends RetryableError {
  public readonly service: string;

  constructor(
    service: string,
    message: string,
    code: string = "EXTERNAL_SERVICE_ERROR",
    context?: Record<string, unknown>
  ) {
    super(message, code, undefined, { ...context, service });
    this.service = service;
  }
}

/**
 * Redis errors
 */
export class RedisError extends RetryableError {
  constructor(
    message: string,
    code: string = "REDIS_ERROR",
    context?: Record<string, unknown>
  ) {
    super(message, code, 1000, context);
  }
}

/**
 * Discord API errors
 */
export class DiscordError extends RetryableError {
  public readonly discordCode?: number;

  constructor(
    message: string,
    discordCode?: number,
    retryAfterMs?: number,
    context?: Record<string, unknown>
  ) {
    super(message, "DISCORD_ERROR", retryAfterMs, { ...context, discordCode });
    this.discordCode = discordCode;
  }
}

/**
 * Error handler options
 */
export interface ErrorHandlerOptions {
  logError?: boolean;
  rethrow?: boolean;
  fallbackValue?: unknown;
  context?: Record<string, unknown>;
  onError?: (error: AppError) => void | Promise<void>;
}

/**
 * Standardized error handler
 */
export async function handleError<T = void>(
  error: unknown,
  options: ErrorHandlerOptions = {}
): Promise<T | undefined> {
  const {
    logError = true,
    rethrow = false,
    fallbackValue,
    context = {},
    onError,
  } = options;

  // Convert to AppError if needed
  let appError: AppError;
  if (error instanceof AppError) {
    appError = error;
  } else if (error instanceof Error) {
    appError = new AppError(
      error.message,
      "UNKNOWN_ERROR",
      500,
      true,
      { ...context, originalError: error.name }
    );
    appError.stack = error.stack;
  } else {
    appError = new AppError(
      String(error),
      "UNKNOWN_ERROR",
      500,
      true,
      context
    );
  }

  // Log error
  if (logError) {
    const logData = {
      code: appError.code,
      message: appError.message,
      statusCode: appError.statusCode,
      isOperational: appError.isOperational,
      context: appError.context,
      stack: appError.stack,
    };

    if (appError.isOperational) {
      logger.warn(logData, `Operational error: ${appError.message}`);
    } else {
      logger.error(logData, `Fatal error: ${appError.message}`);
    }
  }

  // Call custom error handler
  if (onError) {
    try {
      await onError(appError);
    } catch (handlerErr) {
      logger.error(
        { err: handlerErr instanceof Error ? handlerErr.message : String(handlerErr) },
        "Error handler failed"
      );
    }
  }

  // Rethrow or return fallback
  if (rethrow) {
    throw appError;
  }

  return fallbackValue as T;
}

/**
 * Wrap async function with error handling
 */
export function withErrorHandling<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options: ErrorHandlerOptions = {}
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    try {
      return await fn(...args);
    } catch (error) {
      const handled = await handleError<TReturn>(error, options);
      if (handled !== undefined) {
        return handled;
      }
      throw error;
    }
  };
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof RetryableError) {
    return true;
  }

  if (error instanceof AppError) {
    return error.isOperational;
  }

  // Check for common retryable error patterns
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("timeout") ||
      message.includes("econnreset") ||
      message.includes("enotfound") ||
      message.includes("rate limit") ||
      message.includes("503") ||
      message.includes("502")
    );
  }

  return false;
}

/**
 * Extract retry delay from error
 */
export function getRetryDelay(error: unknown): number | undefined {
  if (error instanceof RetryableError) {
    return error.retryAfterMs;
  }

  return undefined;
}

/**
 * Create error from HTTP response
 */
export function createHttpError(
  statusCode: number,
  message: string,
  context?: Record<string, unknown>
): AppError {
  if (statusCode === 429) {
    return new RateLimitError(message, undefined, context);
  }

  if (statusCode === 408 || statusCode === 504) {
    return new TimeoutError(message, undefined, context);
  }

  if (statusCode >= 500) {
    return new RetryableError(message, `HTTP_${statusCode}`, undefined, context);
  }

  if (statusCode >= 400) {
    return new ValidationError(message, `HTTP_${statusCode}`, context);
  }

  return new AppError(message, `HTTP_${statusCode}`, statusCode, true, context);
}

/**
 * Safe error message extraction
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }

  return "Unknown error";
}

/**
 * Safe error code extraction
 */
export function getErrorCode(error: unknown): string {
  if (error instanceof AppError) {
    return error.code;
  }

  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code: unknown }).code);
  }

  return "UNKNOWN_ERROR";
}
