/**
 * Shared API response helpers
 * Standardizes success and error responses across all API endpoints
 */

/**
 * Create standardized success response
 * @param {*} data - Response data
 * @returns {Object} Standardized success response object
 */
export function createSuccessResponse(data) {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create standardized error response
 * @param {string} code - Error code
 * @param {string} message - Error message
 * @param {*} [details=null] - Optional error details (only included in development)
 * @returns {Object} Standardized error response object
 */
export function createErrorResponse(code, message, details = null) {
  const response = {
    success: false,
    error: {
      code,
      message,
    },
    timestamp: new Date().toISOString(),
  };

  // Only include details in development mode
  if (details && process.env.NODE_ENV === "development") {
    response.error.details = details;
  }

  return response;
}

/**
 * Common error response presets
 */
export const ErrorPresets = {
  UNAUTHORIZED: () => createErrorResponse("UNAUTHORIZED", "Unauthorized"),
  METHOD_NOT_ALLOWED: (method) =>
    createErrorResponse("METHOD_NOT_ALLOWED", `Method ${method} not allowed`),
  INVALID_QUERY: (details) =>
    createErrorResponse("INVALID_QUERY", "Invalid query parameters", details),
  TITLE_REQUIRED: () =>
    createErrorResponse("TITLE_REQUIRED", "Title wajib diisi"),
  INVALID_URL: () =>
    createErrorResponse("INVALID_URL", "URL tidak valid"),
  NOT_FOUND: (resource = "Resource") =>
    createErrorResponse("NOT_FOUND", `${resource} tidak ditemukan`),
  VALIDATION_ERROR: (message, details) =>
    createErrorResponse("VALIDATION_ERROR", message, details),
  INTERNAL_ERROR: () =>
    createErrorResponse("INTERNAL_ERROR", "Internal server error"),
};

/**
 * Helper untuk method check
 * @param {string} method - HTTP method
 * @param {string[]} allowed - Allowed methods
 * @returns {boolean}
 */
export function isMethodAllowed(method, allowed = ["GET", "POST"]) {
  return allowed.includes(method);
}

/**
 * Create method not allowed response
 * @param {string} method - HTTP method yang tidak diizinkan
 * @returns {Object} Error response
 */
export function methodNotAllowedResponse(method) {
  return createErrorResponse(
    "METHOD_NOT_ALLOWED",
    `Method ${method} not allowed`,
  );
}
