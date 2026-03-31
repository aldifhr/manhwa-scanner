export function normalizeSource(source = "") {
  const s = String(source).toLowerCase().trim();
  if (s === "mirror" || s === "shinigami_mirror") return "shinigami_mirror";
  if (s === "shinigami" || s === "project" || s === "shinigami_project") {
    return "shinigami_project";
  }
  return "ikiru";
}

export function sourceLabel(source = "") {
  const s = normalizeSource(source);
  if (s === "shinigami_project") return "Shinigami (Project)";
  if (s === "shinigami_mirror") return "Shinigami (Mirror)";
  return "Ikiru";
}

export function normalizeSourceUrl(url = "") {
  let normalized = String(url).toLowerCase().trim();
  
  // Ensure consistent trailing slash (optional, but let's follow the user's manual cleaning)
  if (!normalized.endsWith("/")) normalized += "/";
  
  const ikiruBase = (process.env.IKIRU_BASE_URL || "https://02.ikiru.wtf")
    .replace(/\/+$/, "").toLowerCase();
  const shigBase = (process.env.SHINIGAMI_BASE_URL || process.env.SECONDARY_PUBLIC_BASE || "https://a.shinigami.asia")
    .replace(/\/+$/, "").toLowerCase();

  // Normalize Shinigami domains
  if (/^https?:\/\/(?:[a-z0-9-]+\.)?(shngm\.id|shinigami\.asia|shinigami-id\.com|shinigami\.moe|shinigami\.ink)\b/i.test(normalized)) {
     return normalized.replace(/^https?:\/\/[^/]+/i, shigBase);
  }
  
  // Normalize Ikiru domains
  if (/^https?:\/\/(?:[a-z0-9-]+\.)?(ikiru\.wtf|komikcast\.com|komikcast\.site)\b/i.test(normalized)) {
     return normalized.replace(/^https?:\/\/[^/]+/i, ikiruBase);
  }

  return normalized;
}

export function inferSourceFromUrl(url = "") {
  const normalized = normalizeSourceUrl(url);
  if (!normalized) return null;
  
  const ikiruBase = (process.env.IKIRU_BASE_URL || "https://02.ikiru.wtf")
    .replace(/\/+$/, "").toLowerCase();
  const shigBase = (process.env.SHINIGAMI_BASE_URL || process.env.SECONDARY_PUBLIC_BASE || "https://a.shinigami.asia")
    .replace(/\/+$/, "").toLowerCase();

  if (normalized.startsWith(`${ikiruBase}/manga/`)) return "ikiru";
  if (normalized.startsWith(`${shigBase}/series/`)) return "shinigami_project";
  return null;
}
