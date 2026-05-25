/**
 * Custom Error Classes for consistent error handling and reporting
 */

export interface AppErrorOptions {
  code?: string;
  statusCode?: number;
  isPublic?: boolean;
  details?: any;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isPublic: boolean;
  public readonly details: any;

  /**
   * @param message - User-facing or log-friendly message
   * @param options
   */
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code || "INTERNAL_ERROR";
    this.statusCode = options.statusCode || 500;
    this.isPublic = options.isPublic ?? false;
    this.details = options.details || null;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * 400 Bad Request - Validasi input pengguna
 */
export class ValidationError extends AppError {
  constructor(message: string, details: any = null) {
    super(message, {
      code: "VALIDATION_ERROR",
      statusCode: 400,
      isPublic: true,
      details,
    });
  }
}

/**
 * 502/503/504 - External Service Failure (Discord, Scrapers, Redis)
 */
export class ExternalError extends AppError {
  /**
   * @param source - Source of failure (e.g., 'discord', 'shinigami')
   * @param message - Original error message
   * @param options
   */
  constructor(
    source: string,
    message: string,
    options: AppErrorOptions = {},
  ) {
    const displayMessage = options.isPublic
      ? `Gagal terhubung ke ${source}: ${message}`
      : `External service error (${source})`;

    super(displayMessage, {
      code: `EXTERNAL_${source.toUpperCase()}_ERROR`,
      statusCode: options.statusCode || 502,
      isPublic: options.isPublic ?? false,
      details: {
        source,
        originalMessage: message,
        ...options.details,
      },
    });
  }
}


