import { sourceLabel } from "../domain/source.js";
import { MARK_REASON_LABELS, normalizeMarkReason } from "../domain/whitelist.js";
import { loadWhitelist } from "../redis.js";

/**
 * Formats a title with its mark (e.g., "Lookism [Hiatus]")
 */
export function formatMarkedTitle(item) {
  const title = String(item?.title || "").trim();
  const reason = normalizeMarkReason(item?.mark || item?.sources?.[0]?.mark);
  if (!reason) return title;
  return `${title} [${MARK_REASON_LABELS[reason] || reason}]`;
}

/**
 * Builds a paginated Discord list response for the whitelist.
 */
export async function buildWhitelistListResponse(page = 1, pageSize = 10, { search = null, filter = null } = {}) {
  let whitelist = await loadWhitelist();

  // Apply Search
  if (search) {
    const term = search.toLowerCase();
    whitelist = whitelist.filter(item => item.title?.toLowerCase().includes(term));
  }

  // Apply Filter (Status)
  if (filter) {
    const f = filter.toLowerCase();
    whitelist = whitelist.filter(item => {
      return item.sources?.some(s => s.mark === f);
    });
  }

  const totalPage = Math.ceil(whitelist.length / pageSize) || 1;
  const safePage = Math.min(Math.max(1, page), totalPage);
  const start = (safePage - 1) * pageSize;
  const slice = whitelist.slice(start, start + pageSize);

  const content =
    whitelist.length === 0
      ? "Whitelist empty."
      : `Whitelist (${whitelist.length})${search ? ` | Search: "${search}"` : ""}${filter ? ` | Status: ${MARK_REASON_LABELS[filter] || filter}` : ""}\nPage ${safePage}/${totalPage}\n\n` +
        slice
          .map(
            (item, i) => {
              const sourceIcons = (item.sources || [])
                .map(s => `[${sourceLabel(s.source)}]`)
                .join(" ");
              return `${start + i + 1}. ${formatMarkedTitle(item)} ${sourceIcons}`;
            },
          )
          .join("\n");

  const searchParam = search ? `:${search.slice(0, 30)}` : "";
  const filterParam = filter ? `|${filter.slice(0, 20)}` : "";
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
                custom_id: `list:${safePage - 1}${searchParam}${filterParam}`,
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
                custom_id: `list:${safePage + 1}${searchParam}${filterParam}`,
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
