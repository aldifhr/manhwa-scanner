import { loadWhitelist, saveWhitelist } from "../redis.js";
import {
  normalizeSource,
  normalizeSourceUrl,
  sourceLabel,
} from "../domain/source.js";

function hasSameWhitelistIdentity(item, title, normalizedUrl, normalizedSource) {
  return (
    normalizeSource(item.source) === normalizedSource &&
    (item.title?.toLowerCase() === title.toLowerCase() ||
      (normalizedUrl && normalizeSourceUrl(item.url || "") === normalizedUrl))
  );
}

export async function addWhitelistEntry({ title, url = null, source = "ikiru" }) {
  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) throw new Error("Title required");

  const normalizedSource = normalizeSource(source);
  const normalizedUrl = url ? normalizeSourceUrl(url) : null;
  const whitelist = await loadWhitelist();

  const exists = whitelist.some((item) =>
    hasSameWhitelistIdentity(item, normalizedTitle, normalizedUrl, normalizedSource),
  );

  if (exists) {
    return {
      status: "exists",
      whitelist,
      source: normalizedSource,
      title: normalizedTitle,
    };
  }

  whitelist.push({
    title: normalizedTitle,
    url: url ?? null,
    source: normalizedSource,
  });
  await saveWhitelist(whitelist);

  return {
    status: "added",
    whitelist,
    source: normalizedSource,
    title: normalizedTitle,
  };
}

export async function removeWhitelistEntryByTitle(title) {
  const normalizedTitle = String(title || "").trim().toLowerCase();
  if (!normalizedTitle) throw new Error("Title required");

  const items = await loadWhitelist();
  const filtered = items.filter(
    (item) => String(item.title || "").trim().toLowerCase() !== normalizedTitle,
  );

  if (filtered.length === items.length) {
    return { status: "not_found", items };
  }

  await saveWhitelist(filtered);
  return { status: "removed", items: filtered };
}

export async function buildWhitelistListResponse(page = 1, pageSize = 10) {
  const whitelist = await loadWhitelist();
  const totalPage = Math.ceil(whitelist.length / pageSize) || 1;
  const safePage = Math.min(Math.max(1, page), totalPage);
  const start = (safePage - 1) * pageSize;
  const slice = whitelist.slice(start, start + pageSize);

  const content =
    whitelist.length === 0
      ? "Whitelist empty."
      : `Whitelist (${whitelist.length})\nPage ${safePage}/${totalPage}\n\n` +
        slice
          .map(
            (item, i) =>
              `${start + i + 1}. [${sourceLabel(item.source)}] ${item.title}`,
          )
          .join("\n");

  const components =
    whitelist.length === 0
      ? []
      : [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 1,
                label: "Prev",
                custom_id: `list:${safePage - 1}`,
                disabled: safePage <= 1,
              },
              {
                type: 2,
                style: 2,
                label: `Page ${safePage}`,
                custom_id: "noop",
                disabled: true,
              },
              {
                type: 2,
                style: 1,
                label: "Next",
                custom_id: `list:${safePage + 1}`,
                disabled: safePage >= totalPage,
              },
            ],
          },
        ];

  return { content, components, items: whitelist };
}

export function buildAddSuccessMessage({ title, source, total }) {
  return `Added **${title}** from **${sourceLabel(source)}**.\nTotal: **${total}**`;
}

export function buildAddExistsMessage({ title, source }) {
  return `**${title}** already exists in **${sourceLabel(source)}**.`;
}
