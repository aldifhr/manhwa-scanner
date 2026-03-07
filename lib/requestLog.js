export function logApiHit(name, req) {
  const method = req?.method ?? "UNKNOWN";
  const path = req?.url ?? "";
  console.log(`[api:${name}] ${method} ${path}`);
}

