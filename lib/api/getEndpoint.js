import { isMonitorAuthorized } from "../auth.js";
import { resolvePositiveInt } from "../runtimeConfig.js";

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
