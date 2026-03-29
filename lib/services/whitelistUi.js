import { sourceLabel } from "../domain/source.js";
import { MARK_REASON_LABELS, normalizeMarkReason } from "../domain/whitelist.js";
import { loadWhitelist, redis } from "../redis.js";
import { normalizeTitleKey } from "../domain/manga.js";

/**
 * Formats a relative time string (e.g., "2 jam yang lalu") and hibernation state
 */
function formatRelativeIndo(isoString) {
  if (!isoString) return { text: null, isHibernating: false };
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  const isHibernating = diffDay >= 14;

  let text;
  if (diffDay > 0) text = `${diffDay} hari yang lalu`;
  else if (diffHour > 0) text = `${diffHour} jam yang lalu`;
  else if (diffMin > 0) text = `${diffMin} menit yang lalu`;
  else text = "Baru saja";

  return { text, isHibernating };
}

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

  // Fetch last update times from Redis
  const updateKeys = slice.map(item => `manga:last_update:${normalizeTitleKey(item.title)}`);
  let updateTimes = [];
  if (updateKeys.length > 0) {
    try {
      updateTimes = await redis.mget(...updateKeys);
    } catch (err) {
      console.warn("[buildWhitelistListResponse] Redis mget failed:", err.message);
    }
  }

  const lines = slice.map((item, i) => {
    const sourceIcons = (item.sources || [])
      .map(s => `[${sourceLabel(s.source)}]`)
      .join(" ");
    
    const ut = updateTimes[i];
    const { text, isHibernating } = formatRelativeIndo(ut);
    const timeLabel = text ? ` _(Update: ${text})_` : "";
    const hibernationIcon = isHibernating ? " 💤" : "";
    
    return `${start + i + 1}. **${formatMarkedTitle(item)}**${hibernationIcon} ${sourceIcons}${timeLabel}`;
  });


  const content =
    whitelist.length === 0
      ? "Whitelist kosong."
      : `📚 **Daftar Whitelist (${whitelist.length})**${search ? ` | Cari: "${search}"` : ""}${filter ? ` | Status: ${MARK_REASON_LABELS[filter] || filter}` : ""}\n*Halaman ${safePage}/${totalPage}*\n\n` +
        lines.join("\n");

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
                label: "Sebelumnya",
                custom_id: `list:${safePage - 1}${searchParam}${filterParam}`,
                disabled: safePage <= 1,
              },
              {
                type: 2,
                style: 2,
                label: `Hal ${safePage}`,
                custom_id: "noop",
                disabled: true,
              },
              {
                type: 2,
                style: 1,
                label: "Berikutnya",
                custom_id: `list:${safePage + 1}${searchParam}${filterParam}`,
                disabled: safePage >= totalPage,
              },
            ],
          },
        ];

  return { content, components, items: whitelist };
}

export function buildAddSuccessMessage({ title, source, total }) {
  return `Berhasil menambah **${title}** dari **${sourceLabel(source)}**.\nTotal Whitelist: **${total}**`;
}

export function buildAddExistsMessage({ title, source }) {
  return `**${title}** sudah ada di whitelist (**${sourceLabel(source)}**).`;
}

