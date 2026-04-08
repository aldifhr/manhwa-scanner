import { getStatusColor } from "./scrapers/shared.js";
import { getRelativeTime } from "./dateUtils.js";
import { httpPatch, httpPost } from "./httpClient.js";
import pLimit from "p-limit";
import { getLogger } from "./logger.js";

const logger = getLogger({ scope: "discord" });

const APP_ID = process.env.DISCORD_APPLICATION_ID;
export const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

export const statusBar = {
  Ongoing: "Ongoing",
  Completed: "Completed",
  Hiatus: "Hiatus",
  Unknown: "Unknown",
};

const ICON_BELL = "\u{1F514}";
const STAR_FILLED = "\u2B50";
const STAR_EMPTY = "\u2606";

const SOURCE_META = {
  ikiru: {
    label: "Ikiru",
    badge: "IKIRU",
    color: 0x22c55e,
    siteUrl: process.env.IKIRU_BASE_URL || "https://02.ikiru.wtf/",
  },
  shinigami_project: {
    label: "Shinigami (Project)",
    badge: "SHINIGAMI",
    color: 0xef4444,
    siteUrl:
      process.env.SHINIGAMI_BASE_URL ||
      process.env.SECONDARY_PUBLIC_BASE ||
      "https://a.shinigami.asia/",
  },
  shinigami_mirror: {
    label: "Shinigami (Mirror)",
    badge: "SHINIGAMI MIRROR",
    color: 0xf59e0b,
    siteUrl:
      process.env.SHINIGAMI_BASE_URL ||
      process.env.SECONDARY_PUBLIC_BASE ||
      "https://a.shinigami.asia/",
  },
};

export const ratingStars = (rating) => {
  if (!rating || rating === "N/A") return "`No rating`";
  const num = parseFloat(rating);
  if (Number.isNaN(num)) return "`No rating`";
  const filled = Math.min(5, Math.max(0, Math.round(num / 2)));
  const display = Number.isInteger(num) ? num : num.toFixed(1);
  return `${
    STAR_FILLED.repeat(filled) + STAR_EMPTY.repeat(5 - filled)
  } \`${display}/10\``;
};

export const shortSynopsis = (description) => {
  if (!description) return null;
  if (description.length <= 220) return description;
  const cut = description.lastIndexOf(" ", 220);
  return `${description.substring(0, cut > 0 ? cut : 220)}...`;
};

export async function editInteractionResponse(token, content) {
  const t = typeof token === "object" ? token.token : token;

  if (!APP_ID) {
    throw new Error("DISCORD_APPLICATION_ID not configured");
  }

  if (!t) {
    throw new Error("Interaction token not provided");
  }

  let body = {};
  if (typeof content === "string") {
    const safeContent =
      content.length > 2000 ? `${content.substring(0, 1997)}...` : content;
    body = { content: safeContent || undefined };
  } else if (content && typeof content === "object") {
    body = { ...content };
    if (body.content && body.content.length > 2000) {
      body.content = `${body.content.substring(0, 1997)}...`;
    }
  }

  try {
    await httpPatch(
      `https://discord.com/api/v10/webhooks/${APP_ID}/${t}/messages/@original`,
      body,
      { headers: { "Content-Type": "application/json" }, timeout: 10000 },
      { retries: 3, baseDelayMs: 300, maxDelayMs: 4000 },
    );
  } catch (err) {
    logger.error("[editInteractionResponse] Failed:", err.message);
    throw err;
  }
}

export async function editInteractionResponseWithComponents(
  token,
  content,
  components,
  embeds = [],
) {
  const t = typeof token === "object" ? token.token : token;

  if (!APP_ID) {
    throw new Error("DISCORD_APPLICATION_ID not configured");
  }

  if (!t) {
    throw new Error("Interaction token not provided");
  }

  const safeContent =
    content?.length > 2000 ? `${content.substring(0, 1997)}...` : content;

  try {
    await httpPatch(
      `https://discord.com/api/v10/webhooks/${APP_ID}/${t}/messages/@original`,
      { content: safeContent || undefined, components, embeds },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 },
      { retries: 3, baseDelayMs: 300, maxDelayMs: 4000 },
    );
  } catch (err) {
    logger.error("[editInteractionResponseWithComponents] Failed:", err.message);
    throw err;
  }
}

function normalizeSourceLabel(source) {
  const s = String(source || "").toLowerCase();
  if (
    s === "shinigami_mirror" ||
    s === "shinigami_project" ||
    s === "shinigami"
  ) {
    return "Shinigami";
  }
  return "Ikiru";
}

function sourceMeta(source) {
  const s = String(source || "").toLowerCase();
  if (s === "shinigami_mirror") return SOURCE_META.shinigami_mirror;
  if (s === "shinigami_project" || s === "shinigami") {
    return SOURCE_META.shinigami_project;
  }
  return SOURCE_META.ikiru;
}

function formatAbsoluteWib(datetime) {
  if (!datetime) return null;
  const d = new Date(datetime);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta",
    hour12: false,
  }).format(d);
}

function buildToastContent({ title, chapter }) {
  const plainTitle = String(title || "Untitled")
    .replace(/\s+/g, " ")
    .trim();
  const rawChapter = String(chapter || "Unknown")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedChapter = /^chapter\b/i.test(rawChapter)
    ? rawChapter.replace(/^chapter\b\.?\s*/i, "Chapter ")
    : /^ch\b/i.test(rawChapter)
      ? rawChapter.replace(/^ch\b\.?\s*/i, "Chapter ")
      : `Chapter ${rawChapter}`;
  const line = `${ICON_BELL} New Chapter: **${plainTitle}** • **${normalizedChapter}**`;
  return line.length > 180 ? `${line.slice(0, 177)}...` : line;
}

export async function sendDiscordEmbed(
  data,
  channelId,
  _redis = null, // Unused but required for signature compatibility
  mentions = "",
) {
  const statusColor = getStatusColor(data.status);
  const source = sourceMeta(data.source);
  const sourceLabel = normalizeSourceLabel(data.source);
  const title = String(data.title || "Untitled").trim();
  const chapter = String(data.chapter || "Unknown").trim();
  const updatedRelative = data.updatedTime
    ? getRelativeTime(data.updatedTime)
    : "Unknown";
  const updatedAbsolute = formatAbsoluteWib(data.updatedTime);
  const rating = data.rating ?? "N/A";
  const status = statusBar[data.status] ?? "Unknown";
  const safeMangaUrl = String(data.mangaUrl || data.url || "").trim();
  const safeChapterUrl = String(data.url || data.mangaUrl || "").trim();
  const eventTimestamp = new Date().toISOString();
  const titleLine = safeMangaUrl
    ? `**[${title}](${safeMangaUrl})**`
    : `**${title}**`;
  const actionLine =
    safeChapterUrl && safeMangaUrl
      ? `[Read Chapter](${safeChapterUrl}) | [Series Page](${safeMangaUrl})`
      : safeChapterUrl
        ? `[Read Chapter](${safeChapterUrl})`
        : safeMangaUrl
          ? `[Series Page](${safeMangaUrl})`
          : null;
  const toastContent = buildToastContent({ title, chapter });
  const finalContent = mentions ? `${mentions}\n${toastContent}` : toastContent;

  const embeds = [
    {
      color: source.color || statusColor,
      title: undefined,
      url: undefined,
      description: [
        titleLine,
        "",
        `Status: ${status}`,
        `Source: ${sourceLabel}`,
        `Updated: ${updatedRelative}${updatedAbsolute ? ` (${updatedAbsolute} WIB)` : ""}`,
        ...(actionLine ? ["", actionLine] : []),
      ]
        .filter(Boolean)
        .join("\n"),
      fields: [
        {
          name: "Source",
          value: `\`${sourceLabel}\``,
          inline: true,
        },
        {
          name: "Status",
          value: `\`${status}\``,
          inline: true,
        },
        {
          name: "Rating",
          value: ratingStars(rating),
          inline: true,
        },
      ],
      thumbnail: data.cover?.startsWith("http")
        ? { url: data.cover }
        : undefined,
      timestamp: eventTimestamp,
    },
  ];

  const components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3, // Green
          label: "🔖 Bookmark",
          custom_id: `follow_toggle:${title.slice(0, 70)}`,
        },
      ],
    },
  ];

  await httpPost(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    { content: finalContent, embeds, components },
    {
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    },
    { retries: 3, baseDelayMs: 350, maxDelayMs: 5000 },
  );
}

// In-flight request tracking for Discord deduplication
const inFlightDiscordSends = new Map();
const DISCORD_DEDUP_TTL_MS = 30000; // 30 seconds

function getDiscordDedupeKey(channelId, title, chapter) {
  return `${channelId}:${title}:${chapter}`;
}

export async function sendDiscordText(channelId, content) {
  if (!channelId || !content) return;

  try {
    await httpPost(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      { content },
      {
        headers: {
          Authorization: `Bot ${BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 8000,
      },
      { retries: 2, baseDelayMs: 300, maxDelayMs: 3000 },
    );
  } catch (err) {
    logger.error(`[sendDiscordText] Failed to send to ${channelId}:`, err.message);
    throw err; // Re-throw for caller to handle
  }
}

/**
 * Send embeds to multiple channels with concurrency control and deduplication
 * @param {Array<{data: Object, channelId: string, mentions?: string}>} items - Items to send
 * @param {Object} options - Options
 * @param {number} options.concurrency - Max concurrent sends (default: 5)
 * @param {boolean} options.deduplicate - Enable deduplication (default: true)
 * @returns {Promise<{successful: number, failed: number, results: Array}>}
 */
export async function sendDiscordEmbedsBatch(items, options = {}) {
  if (!items || items.length === 0) {
    return { successful: 0, failed: 0, results: [] };
  }

  const concurrency = options.concurrency || 5;
  const deduplicate = options.deduplicate !== false;
  const limit = pLimit(concurrency);

  // Track in-flight requests for deduplication
  const pendingSends = new Map();

  const sendTasks = items.map((item, index) =>
    limit(async () => {
      const { data, channelId, mentions = "" } = item;
      const title = String(data?.title || "").trim();
      const chapter = String(data?.chapter || "").trim();

      // Deduplication check
      if (deduplicate) {
        const dedupeKey = getDiscordDedupeKey(channelId, title, chapter);

        // Check if already in-flight
        if (inFlightDiscordSends.has(dedupeKey)) {
          return {
            index,
            status: "deduplicated",
            channelId,
            title,
            chapter,
          };
        }

        // Mark as in-flight
        const promise = sendDiscordEmbed(
          data,
          channelId,
          mentions,
        ).finally(() => {
          setTimeout(
            () => inFlightDiscordSends.delete(dedupeKey),
            DISCORD_DEDUP_TTL_MS,
          );
        });

        inFlightDiscordSends.set(dedupeKey, promise);
        await promise;
      } else {
        await sendDiscordEmbed(data, channelId, mentions);
      }

      return {
        index,
        status: "sent",
        channelId,
        title,
        chapter,
      };
    }).catch((err) => ({
      index,
      status: "failed",
      channelId: item.channelId,
      title: String(item.data?.title || ""),
      chapter: String(item.data?.chapter || ""),
      error: err?.message || "Unknown error",
    })),
  );

  const results = await Promise.all(sendTasks);

  const successful = results.filter((r) => r.status === "sent").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const deduplicated = results.filter(
    (r) => r.status === "deduplicated",
  ).length;

  return {
    successful,
    failed,
    deduplicated,
    total: items.length,
    results,
  };
}

/**
 * Send to multiple channels efficiently with batching
 * @param {Object} data - Chapter data
 * @param {Array<string>} channelIds - Channel IDs to send to
 * @param {string} mentions - Mentions string
 * @param {Object} options - Options
 * @returns {Promise<{successful: number, failed: number}>}
 */
export async function sendToChannels(
  data,
  channelIds,
  mentions = "",
  options = {},
) {
  if (!channelIds || channelIds.length === 0) {
    return { successful: 0, failed: 0 };
  }

  const items = channelIds.map((channelId) => ({
    data,
    channelId,
    mentions,
  }));

  const result = await sendDiscordEmbedsBatch(items, options);

  return {
    successful: result.successful,
    failed: result.failed,
  };
}
