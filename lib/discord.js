import { getStatusColor } from "./scrapers/shared.js";
import { getRelativeTime } from "./dateUtils.js";
import { httpPatch, httpPost } from "./httpClient.js";
import { normalizeChapterIdentity, normalizeTitleKey } from "./domain.js";
import pLimit from "p-limit";
import { getLogger } from "./logger.js";
import {
  DISCORD_EPHEMERAL_FLAG,
  DISCORD_COMPONENT_TYPE,
  DISCORD_BUTTON_STYLE,
  DISCORD_EMBED_TITLE_LIMIT,
  DISCORD_EMBED_DESCRIPTION_LIMIT,
} from "./config.js";

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
  const channelId = typeof token === "object" ? token.channel_id : null;
  const userId = typeof token === "object" ? (token.member?.user?.id || token.user?.id) : null;
  const appId = typeof token === "object" && token.application_id ? token.application_id : APP_ID;

  if (!appId) {
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
      `https://discord.com/api/v10/webhooks/${appId}/${t}/messages/@original`,
      body,
      { headers: { "Content-Type": "application/json" }, timeout: 10000 },
      { retries: 3, baseDelayMs: 300, maxDelayMs: 4000 },
    );
  } catch (err) {
    if (err.response?.status === 404 && channelId) {
      logger.warn("[editInteractionResponse] 404 Unknown Webhook, falling back to channel message");
      try {
        const mention = userId ? `<@${userId}>\n` : "";
        const fallbackContent = mention + (body.content || "Interaction complete.");
        await httpPost(
          `https://discord.com/api/v10/channels/${channelId}/messages`,
          { content: fallbackContent },
          { headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" } },
        );
        return;
      } catch (fallbackErr) {
        logger.error({ err: fallbackErr.message }, "[editInteractionResponse] Channel fallback failed");
      }
    }

    logger.error({
      err: err.message,
      status: err.response?.status,
      appId: appId ? "set" : "missing",
      token: t ? "present" : "missing",
      tokenLength: t?.length,
    }, "[editInteractionResponse] Failed");
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
  const channelId = typeof token === "object" ? token.channel_id : null;
  const userId = typeof token === "object" ? (token.member?.user?.id || token.user?.id) : null;
  const appId = typeof token === "object" && token.application_id ? token.application_id : APP_ID;

  if (!appId) {
    throw new Error("DISCORD_APPLICATION_ID not configured");
  }

  if (!t) {
    throw new Error("Interaction token not provided");
  }

  const safeContent =
    content?.length > 2000 ? `${content.substring(0, 1997)}...` : content;

  try {
    await httpPatch(
      `https://discord.com/api/v10/webhooks/${appId}/${t}/messages/@original`,
      { content: safeContent || undefined, components, embeds },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 },
      { retries: 3, baseDelayMs: 300, maxDelayMs: 4000 },
    );
  } catch (err) {
    if (err.response?.status === 404 && channelId) {
      logger.warn("[editInteractionResponseWithComponents] 404 Unknown Webhook, falling back to channel message");
      try {
        const mention = userId ? `<@${userId}>\n` : "";
        const fallbackContent = mention + (safeContent || "");
        await httpPost(
          `https://discord.com/api/v10/channels/${channelId}/messages`,
          { content: fallbackContent || undefined, components, embeds },
          { headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" } },
        );
        return;
      } catch (fallbackErr) {
        logger.error({ err: fallbackErr.message }, "[editInteractionResponseWithComponents] Channel fallback failed");
      }
    }
    logger.error("[editInteractionResponseWithComponents] Failed:", err.message);
    throw err;
  }
}

/**
 * Send ephemeral follow-up message (only visible to the user)
 * This is better than editing the original message for button confirmations
 */
export async function sendEphemeralFollowUp(token, content) {
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
    await httpPost(
      `https://discord.com/api/v10/webhooks/${APP_ID}/${t}`,
      {
        content: safeContent,
        flags: DISCORD_EPHEMERAL_FLAG,
      },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 },
      { retries: 2, baseDelayMs: 300, maxDelayMs: 4000 },
    );
  } catch (err) {
    logger.error("[sendEphemeralFollowUp] Failed:", err.message);
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

function buildToastContent({ title, chapter, type }) {
  const plainTitle = String(title || "Untitled")
    .replace(/\s+/g, " ")
    .trim();

  if (type === "report") {
    return `**${plainTitle}**`;
  }

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
  redis = null,
  mentions = "",
) {
  const statusColor = getStatusColor(data.status);
  const source = sourceMeta(data.source);
  const sourceLabel = normalizeSourceLabel(data.source);
  const title = String(data.title || "Untitled").trim();
  const chapter = String(data.chapter || "Unknown").trim();

  const rating = data.rating ?? "N/A";
  const status = statusBar[data.status] ?? "Unknown";
  const safeMangaUrl = String(data.mangaUrl || data.url || "").trim();
  const safeChapterUrl = String(data.url || data.mangaUrl || "").trim();
  const eventTimestamp = new Date().toISOString();
  const truncatedTitle = title.length > DISCORD_EMBED_TITLE_LIMIT
    ? title.substring(0, DISCORD_EMBED_TITLE_LIMIT - 3) + "..."
    : title;

  const titleLine = safeMangaUrl
    ? `**[${truncatedTitle}](${safeMangaUrl})**`
    : `**${truncatedTitle}**`;
  const actionLine =
    safeChapterUrl && safeMangaUrl
      ? `[Read Chapter](${safeChapterUrl}) | [Series Page](${safeMangaUrl})`
      : safeChapterUrl
        ? `[Read Chapter](${safeChapterUrl})`
        : safeMangaUrl
          ? `[Series Page](${safeMangaUrl})`
          : null;
  const toastContent = buildToastContent({ title, chapter, type: data.type });
  const finalContent = mentions ? `${mentions}\n${toastContent}` : toastContent;

  // Title and chapter keys for dedupe
  const titleKey = normalizeTitleKey(title);
  const chapterKey = normalizeChapterIdentity(chapter);

  // Cross-run + cross-instance dedupe guard at Discord send edge.
  if (redis && typeof redis.set === "function") {
    if (titleKey && chapterKey) {
      const dedupeKey = `discord:dedupe:${channelId}:${titleKey}:${chapterKey}`;
      try {
        const claimed = await redis.set(dedupeKey, Date.now().toString(), {
          nx: true,
          ex: 120,
        });
        if (claimed !== "OK") {
          logger.info(
            { channelId, title, chapter },
            "Skipped duplicate Discord embed (Redis dedupe)",
          );
          return;
        }
      } catch (err) {
        logger.warn({ err: err.message }, "Discord dedupe guard failed, continuing send");
      }
    }
  }

  // L2 Cache Dedupe: Check Permanent Data (Supabase)
  // This triggers if Redis is wiped and allows us to avoid spamming the channel.
  // L2 Cache dedupe removed (Supabase no longer used)

  const unixTime = data.updatedTime ? Math.floor(new Date(data.updatedTime).getTime() / 1000) : null;
  const updatedString = unixTime && !Number.isNaN(unixTime)
    ? `<t:${unixTime}:R>`
    : "Unknown";

  const meta = data.metadata || {};
  const sysnopsisText = shortSynopsis(meta.synopsis);
  const genresText = Array.isArray(meta.genres) && meta.genres.length > 0
    ? meta.genres.slice(0, 5).join(", ")
    : null;

  const descriptionParts = [
    titleLine,
    "",
    ...(genresText ? [`**Genres**: \`${genresText}\``] : []),
    `**Status**: ${status} | **Source**: ${sourceLabel}`,
    `**Updated**: ${updatedString}`,
    "",
    ...(sysnopsisText ? [sysnopsisText, ""] : []),
    ...(actionLine ? [actionLine] : []),
  ];

  const truncatedDescription = descriptionParts.join("\n").length > DISCORD_EMBED_DESCRIPTION_LIMIT
    ? descriptionParts.join("\n").substring(0, DISCORD_EMBED_DESCRIPTION_LIMIT - 3) + "..."
    : descriptionParts.join("\n");

  const embeds = [
    {
      color: source.color || statusColor,
      title: undefined,
      url: undefined,
      description: truncatedDescription,
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
          value: ratingStars(meta.rating || data.rating || "N/A"),
          inline: true,
        },
      ],
      thumbnail: (meta.cover || data.cover)?.startsWith("http")
        ? { url: (meta.cover || data.cover) }
        : undefined,
      timestamp: eventTimestamp,
    },
  ];

  const components = [
    {
      type: DISCORD_COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: DISCORD_COMPONENT_TYPE.BUTTON,
          style: DISCORD_BUTTON_STYLE.SUCCESS,
          label: "🔖 Bookmark",
          custom_id: `follow_toggle:${title.slice(0, 70)}`,
        },
      ],
    },
  ];

  try {
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

    // Asynchronous background push into Supabase DB directly after a successful send.
    // If the send failed, it won't execute, which safely means it will be retried later.
    import("./supabase.js").then(({ markChapterSentPermanent }) => {
      markChapterSentPermanent({
        titleKey: titleKey,
        chapterKey: chapterKey,
        mangaTitle: title,
        chapterText: chapter,
        source: data.source || "unknown",
        channelId: channelId,
      }).catch(err => logger.warn({ err: err.message }, "Supabase persisting history failed"));
    });

    return { success: true, status: 200, channelId };
  } catch (err) {
    const status = err.response?.status;
    logger.error(
      { err: err.message, status, channelId },
      "[sendDiscordEmbed] Failed",
    );
    return { success: false, status, channelId, error: err.message };
  }
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
    const res = await httpPost(
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
    return { success: true, status: res?.status || 200, channelId };
  } catch (err) {
    const status = err.response?.status;
    logger.error(
      { err: err.message, status, channelId },
      "[sendDiscordText] Failed",
    );
    return { success: false, status, channelId, error: err.message };
  }
}

/**
 * Send embeds to multiple channels with concurrency control and deduplication
 * @param {Array<{data: Object, channelId: string, mentions?: string}>} items - Items to send
 * @param {Object} options - Options
 * @param {number} options.concurrency - Max concurrent sends (default: 5)
 * @param {boolean} options.deduplicate - Enable deduplication (default: true)
 * @param {Object} options.redis - Redis client for deduplication (optional)
 * @returns {Promise<{successful: number, failed: number, results: Array}>}
 */
export async function sendDiscordEmbedsBatch(items, options = {}) {
  if (!items || items.length === 0) {
    return { successful: 0, failed: 0, results: [] };
  }

  const concurrency = options.concurrency || 5;
  const deduplicate = options.deduplicate !== false;
  const redisClient = options.redis || null;
  const limit = pLimit(concurrency);

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
          redisClient,
          mentions,
        ).finally(() => {
          setTimeout(
            () => inFlightDiscordSends.delete(dedupeKey),
            DISCORD_DEDUP_TTL_MS,
          );
        });

        inFlightDiscordSends.set(dedupeKey, promise);
        const res = await promise;
        return {
          index,
          status: "sent",
          channelId,
          title,
          chapter,
          delivery: res,
        };
      } else {
        const res = await sendDiscordEmbed(data, channelId, redisClient, mentions);
        return {
          index,
          status: "sent",
          channelId,
          title,
          chapter,
          delivery: res,
        };
      }

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
