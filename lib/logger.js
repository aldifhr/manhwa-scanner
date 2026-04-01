import pino from "pino";

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug");

const rootLogger = pino({
  level,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function getLogger(bindings = {}) {
  return rootLogger.child(bindings);
}

function buildReqMeta(req) {
  const method = req?.method ?? "UNKNOWN";
  const path = req?.url ?? "";
  const reqId =
    req?.headers?.["x-vercel-id"] ||
    req?.headers?.["x-request-id"] ||
    req?.headers?.["cf-ray"] ||
    null;
  const ip =
    req?.headers?.["x-forwarded-for"] ||
    req?.headers?.["x-real-ip"] ||
    null;
  return { method, path, reqId, ip };
}

export function logApiHit(name, req) {
  const meta = buildReqMeta(req);
  const logger = getLogger({ endpoint: name, ...meta });
  logger.info({ event: "request_start" }, "api request");
  return logger;
}

export function logApiOk(logger, extra = {}) {
  if (!logger) return;
  logger.info({ event: "request_ok", ...extra }, "api success");
}

export function logApiError(logger, err, extra = {}) {
  if (!logger) return;
  const statusCode = err?.response?.status ?? extra.statusCode ?? null;
  const errCode = extra.code || err?.code || (statusCode ? `http_${statusCode}` : null);
  const errType = extra.type || err?.name || "Error";
  logger.error(
    {
      event: "request_error",
      err: err?.message || String(err),
      errCode,
      errType,
      statusCode,
      ...extra,
    },
    "api error",
  );
}

export default rootLogger;
