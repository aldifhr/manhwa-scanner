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
  const normalized = String(url).replace(/\/+$/, "").toLowerCase().trim();
  return normalized
    .replace(/^https?:\/\/(?:www\.)?shngm\.id\b/, "https://a.shinigami.asia")
    .replace(
      /^https?:\/\/(?:www\.)?shinigami\.asia\b/,
      "https://a.shinigami.asia",
    );
}
