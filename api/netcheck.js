import axios from "axios";
import { loggers, logApiError, logApiHit, logApiOk } from "../lib/logger.js";
import {
  createErrorResponse,
  createSuccessResponse,
} from "../lib/api/response.js";
import { isMonitorAuthorized } from "../lib/auth.js";

const logger = loggers.cron;

const DEFAULT_TIMEOUT_MS = Math.max(
  1500,
  Number(process.env.NETCHECK_TIMEOUT_MS) || 5000,
);

const TARGETS = [
  {
    key: "shinigami_api",
    url: "https://api.shngm.io/v1/manga/list?type=project&page=1&page_size=1",
  },
  {
    key: "ikiru_latest",
    url: "https://02.ikiru.wtf/latest-update/",
  },
];

async function checkTarget(target, timeoutMs) {
  const start = Date.now();
  const out = {
    key: target.key,
    url: target.url,
    ok: false,
    method: null,
    status: null,
    latencyMs: null,
    error: null,
  };

  const requestConfig = {
    timeout: timeoutMs,
    maxRedirects: 3,
    validateStatus: () => true,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "*/*",
    },
  };

  try {
    const headRes = await axios.head(target.url, requestConfig);
    out.ok = headRes.status >= 200 && headRes.status < 500;
    out.method = "HEAD";
    out.status = headRes.status;
    out.latencyMs = Date.now() - start;
    return out;
  } catch (headErr) {
    try {
      const getRes = await axios.get(target.url, requestConfig);
      out.ok = getRes.status >= 200 && getRes.status < 500;
      out.method = "GET";
      out.status = getRes.status;
      out.latencyMs = Date.now() - start;
      return out;
    } catch (getErr) {
      const err = getErr || headErr;
      out.ok = false;
      out.method = "GET";
      out.status = err?.response?.status ?? null;
      out.latencyMs = Date.now() - start;
      out.error = err?.message || "request_failed";
      return out;
    }
  }
}

export default async function handler(req, res) {
  const reqLogger = logApiHit(logger, req);

  if (req.method !== "GET") {
    return res
      .status(405)
      .json(createErrorResponse("METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  if (!isMonitorAuthorized(req)) {
    return res.status(401).json(createErrorResponse("UNAUTHORIZED", "Unauthorized"));
  }

  const startedAt = Date.now();

  try {
    const checks = await Promise.all(
      TARGETS.map((target) => checkTarget(target, DEFAULT_TIMEOUT_MS)),
    );
    const allOk = checks.every((c) => c.ok);
    const response = createSuccessResponse({
      env: process.env.NODE_ENV || "unknown",
      timeoutMs: DEFAULT_TIMEOUT_MS,
      allOk,
      totalLatencyMs: Date.now() - startedAt,
      checks,
    });

    logApiOk(reqLogger, {
      status: 200,
      allOk,
      totalLatencyMs: response.data.totalLatencyMs,
    });
    return res.status(200).json(response);
  } catch (err) {
    logger.error({ err: err.message }, "netcheck failed");
    logApiError(reqLogger, err, { status: 500 });
    return res
      .status(500)
      .json(createErrorResponse("NETCHECK_FAILED", "Netcheck failed"));
  }
}

