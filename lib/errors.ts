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




