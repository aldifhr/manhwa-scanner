/**
 * Shared API response and request helpers
 * Standardizes success/error responses and authorized GET preparation
 */

import { isMonitorAuthorized } from "../auth.js";
import { resolvePositiveInt } from "../config.js";
import { AppError } from "../errors.js";

export function createSuccessResponse<T>(data: T) {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

export function createErrorResponse(codeOrError: any, message?: string, details: any = null) {
  let responseCode = codeOrError;
  let responseMessage = message;
  let responseDetails = details;


  if (codeOrError instanceof Error) {
    const isAppError = codeOrError instanceof AppError;
    responseCode = isAppError ? codeOrError.code : "INTERNAL_ERROR";
    responseMessage = isAppError && codeOrError.isPublic
      ? codeOrError.message
      : (message || "Internal server error");


    if (process.env.NODE_ENV !== "production") {
      responseDetails = {
        ...(isAppError ? codeOrError.details : {}),
        stack: codeOrError.stack,
        originalMessage: codeOrError.message,
      };
    } else if (isAppError && codeOrError.details) {
      responseDetails = codeOrError.details;
    }
  }

  const response: any = {
    success: false,
    error: {
      code: responseCode,
      message: responseMessage,
    },
    timestamp: new Date().toISOString(),
  };

  if (responseDetails) {
    response.error.details = responseDetails;
  }

  return response;
}

import type { PrepareAuthorizedGetOptions } from "../types.js";
export type { PrepareAuthorizedGetOptions } from "../types.js";

export async function prepareAuthorizedGet(req: any, res: any, {
  defaultCacheTtl = 60,
  maxAgeCap = 30,
  rawCacheTtl = null,
}: PrepareAuthorizedGetOptions = {}) {
  if (req.method !== "GET") {
    res.status(405).json(createErrorResponse("METHOD_NOT_ALLOWED", "Method not allowed"));
    return null;
  }

  if (!await isMonitorAuthorized(req)) {
    res.status(401).json(createErrorResponse("UNAUTHORIZED", "Unauthorized"));
    return null;
  }

  const cacheTtl = resolvePositiveInt(rawCacheTtl ?? defaultCacheTtl, defaultCacheTtl);
  res.setHeader(
    "Cache-Control",
    `private, max-age=${Math.min(cacheTtl, maxAgeCap)}, stale-while-revalidate=${cacheTtl}`,
  );
  return { cacheTtl };
}

/**
 * Creates a standard Web Response (Edge compatible)
 */
export function createEdgeResponse(data: any, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}
