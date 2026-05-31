import type { Request, Response } from "express";
import {
  clearDashboardLoginThrottle,
  createDashboardSessionToken,
  getClearSessionCookieHeader,
  getSessionCookieHeader,
  isDashboardPasswordConfigured,
  isDashboardSessionAuthorized,
  readDashboardLoginThrottle,
  registerDashboardLoginFailure,
  validateDashboardPassword,
} from "../lib/auth.js";
import { redis } from "../lib/redis.js";
import {
  createErrorResponse,
  createSuccessResponse,
} from "../lib/api/response.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger({ scope: "api:auth" });

const METHOD_MAP: Record<string, string> = { login: "POST", logout: "POST", status: "GET" };

async function readRawBody(req: Request) {
  const readable = req as unknown as NodeJS.ReadableStream;
  if (!req || !('readable' in req)) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const result = Buffer.concat(chunks).toString("utf8");

  const contentType = req.headers?.["content-type"] || "";
  if (!result && contentType.includes("application/json")) {
    logger.warn("Raw body empty despite application/json Content-Type (possibly consumed by middleware)");
  }

  return result;
}

async function readPassword(req: Request) {
  const body = req.body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      return String(parsed?.password ?? "");
    } catch {
      return "";
    }
  }

  if (body && typeof body === "object") {
    return String(body.password ?? "");
  }

  const raw = await readRawBody(req);
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return String(parsed?.password ?? "");
  } catch {
    return "";
  }
}

async function handleLogin(req: Request, res: Response) {
  try {
    const isConfigured = await isDashboardPasswordConfigured();
    if (!isConfigured) {
      return res.status(500).json(createErrorResponse("SERVER_ERROR", "DASHBOARD_PASSWORD belum diset di server"));
    }

    const throttle = await readDashboardLoginThrottle(redis, req);
    if (throttle.limited) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Retry-After", String(throttle.retryAfterSec));
      return res.status(429).json(createErrorResponse("RATE_LIMITED", `Terlalu banyak percobaan. Coba lagi dalam ${throttle.retryAfterSec} detik.`));
    }

    const password = (await readPassword(req)).trim();
    if (!password) {
      return res.status(400).json(createErrorResponse("INVALID_INPUT", "Password tidak boleh kosong"));
    }

    const isValid = await validateDashboardPassword(password);
    if (!isValid) {
      const failed = await registerDashboardLoginFailure(redis, req);
      res.setHeader("Cache-Control", "no-store");
      if (failed.limited) {
        res.setHeader("Retry-After", String(failed.retryAfterSec));
        return res.status(429).json(createErrorResponse("RATE_LIMITED", `Terlalu banyak percobaan. Coba lagi dalam ${failed.retryAfterSec} detik.`));
      }
      return res.status(401).json(createErrorResponse("UNAUTHORIZED", "Password salah"));
    }

    const token = await createDashboardSessionToken();
    if (!token) return res.status(500).json(createErrorResponse("SERVER_ERROR", "Session secret belum diset"));

    await clearDashboardLoginThrottle(redis, req);
    const cookie = await getSessionCookieHeader(req, token);
    res.setHeader("Set-Cookie", cookie);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(createSuccessResponse({ ok: true }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Login handler error");
    return res.status(500).json(createErrorResponse("INTERNAL_ERROR", message));
  }
}

async function handleLogout(req: Request, res: Response) {
  try {
    const wasAuthenticated = await isDashboardSessionAuthorized(req);
    const cookie = await getClearSessionCookieHeader(req);
    res.setHeader("Set-Cookie", cookie);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(createSuccessResponse({ ok: true, wasAuthenticated }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Logout handler error");
    return res.status(500).json(createErrorResponse("INTERNAL_ERROR", message));
  }
}

async function handleStatus(req: Request, res: Response) {
  try {
    const authenticated = await isDashboardSessionAuthorized(req);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(createSuccessResponse({ authenticated }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Status handler error");
    return res.status(500).json(createErrorResponse("INTERNAL_ERROR", message));
  }
}

export default async function handler(req: Request, res: Response) {
  const action = (req.query.action as string) || "status";
  const expectedMethod = METHOD_MAP[action];

  if (!expectedMethod) {
    return res.status(400).json(createErrorResponse("INVALID_ACTION", "Unknown action"));
  }

  if (req.method !== expectedMethod) {
    return res.status(405).json(createErrorResponse("METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  if (action === "login") return handleLogin(req, res);
  if (action === "logout") return handleLogout(req, res);
  if (action === "status") return handleStatus(req, res);

  return res.status(400).json(createErrorResponse("INVALID_ACTION", "Unknown action"));
}
