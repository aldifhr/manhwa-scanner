/**
 * Shared API response and request helpers
 * Standardizes success/error responses and authorized GET preparation
 */

import { isMonitorAuthorized } from "../auth.js";
import { resolvePositiveInt } from "../config.js";

export function createSuccessResponse(data) {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

export function createErrorResponse(code, message, details = null) {
  const response = {
    success: false,
    error: {
      code,
      message,
    },
    timestamp: new Date().toISOString(),
  };

  if (details && process.env.NODE_ENV === "development") {
    response.error.details = details;
  }

  return response;
}

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

export function isMethodAllowed(method, allowed = ["GET", "POST"]) {
  return allowed.includes(method);
}

export function methodNotAllowedResponse(method) {
  return createErrorResponse(
    "METHOD_NOT_ALLOWED",
    `Method ${method} not allowed`,
  );
}

export function prepareAuthorizedGet(req, res, {
  defaultCacheTtl = 60,
  maxAgeCap = 30,
  rawCacheTtl = null,
} = {}) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return null;
  }

  if (!isMonitorAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  const cacheTtl = resolvePositiveInt(rawCacheTtl ?? defaultCacheTtl, defaultCacheTtl);
  res.setHeader(
    "Cache-Control",
    `private, max-age=${Math.min(cacheTtl, maxAgeCap)}, stale-while-revalidate=${cacheTtl}`,
  );
  return { cacheTtl };
}
