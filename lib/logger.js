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

export default rootLogger;
