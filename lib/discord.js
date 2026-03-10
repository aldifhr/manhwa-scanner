import { formatTimeAgo } from "./scraper.js";
import { httpPatch, httpPost } from "./httpClient.js";

const APP_ID = process.env.DISCORD_APPLICATION_ID;
export const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

export const STATUS_COLORS = {
  Ongoing: 0x22c55e,
  Completed: 0x3b82f6,
  Hiatus: 0xf59e0b,
  Unknown: 0x6b7280,
};

export const statusBar = {
  Ongoing: "Ongoing",
  Completed: "Completed",
  Hiatus: "Hiatus",
  Unknown: "Unknown",
};

const ICON_BELL = "\u{1F514}";
const STAR_FILLED = "\u2605";
const STAR_EMPTY = "\u2606";

const SOURCE_META = {
  ikiru: {
    label: "Ikiru",
    badge: "IKIRU",
    color: 0x22c55e,
    siteUrl: "https://02.ikiru.wtf/",
  },
  shinigami_project: {
    label: "Shinigami (Project)",
    badge: "SHINIGAMI",
    color: 0xef4444,
    siteUrl: "https://a.shinigami.asia/",
  },
  shinigami_mirror: {
    label: "Shinigami (Mirror)",
    badge: "SHINIGAMI MIRROR",
    color: 0xf59e0b,
    siteUrl: "https://a.shinigami.asia/",
  },
};

export const ratingStars = (rating) => {
  if (!rating || rating === "N/A") return "`No rating`";
  const num = parseFloat(rating);
  if (Number.isNaN(num)) return "`No rating`";
  const filled = Math.min(5, Math.max(0, Math.round(num / 2)));
  const display = Number.isInteger(num) ? num : num.toFixed(1);
  return STAR_FILLED.repeat(filled) + STAR_EMPTY.repeat(5 - filled) + ` \`${display}/10\``;
};

export const shortSynopsis = (description) => {
  if (!description) return null;
  if (description.length <= 220) return description;
  const cut = description.lastIndexOf(" ", 220);
  return description.substring(0, cut > 0 ? cut : 220) + "...";
};

export async function editInteractionResponse(token, content) {
  const t = typeof token === "object" ? token.token : token;
  const safeContent =
    content?.length > 2000 ? `${content.substring(0, 1997)}...` : content;

  await httpPatch(
    `https://discord.com/api/v10/webhooks/${APP_ID}/${t}/messages/@original`,
    { content: safeContent || undefined },
    { headers: { "Content-Type": "application/json" }, timeout: 10000 },
    { retries: 3, baseDelayMs: 300, maxDelayMs: 4000 },
  );
}

export async function editInteractionResponseWithComponents(
  token,
  content,
  components,
  embeds = [],
) {
  const t = typeof token === "object" ? token.token : token;

  await httpPatch(
    `https://discord.com/api/v10/webhooks/${APP_ID}/${t}/messages/@original`,
    { content: content || undefined, components, embeds },
    { headers: { "Content-Type": "application/json" }, timeout: 10000 },
    { retries: 3, baseDelayMs: 300, maxDelayMs: 4000 },
  );
}

function normalizeSourceLabel(source) {
  const s = String(source || "").toLowerCase();
  if (s === "shinigami_mirror") return "Shinigami (Mirror)";
  if (s === "shinigami_project" || s === "shinigami") return "Shinigami (Project)";
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

function sourceMiniBadge(source) {
  const s = String(source || "").toLowerCase().trim();
  if (s === "shinigami_mirror" || s === "mirror") return "Mirror";
  if (s === "shinigami_project" || s === "shinigami" || s === "project") {
    return "Project";
  }
  return "Ikiru";
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

function buildToastContent({ sourceLabel, title, chapter }) {
  const plainTitle = String(title || "Untitled").replace(/\s+/g, " ").trim();
  const plainChapter = String(chapter || "New chapter").replace(/\s+/g, " ").trim();
  const line = `${ICON_BELL} [${sourceLabel}] ${plainTitle} - ${plainChapter}`;
  return line.length > 180 ? `${line.slice(0, 177)}...` : line;
}

export async function sendDiscordEmbed(data, channelId, redis = null) {
  void redis;
  const statusColor = STATUS_COLORS[data.status] ?? STATUS_COLORS.Unknown;
  const source = sourceMeta(data.source);
  const sourceLabel = normalizeSourceLabel(data.source);
  const title = String(data.title || "Untitled").trim();
  const chapter = String(data.chapter || "Unknown").trim();
  const updatedRelative = data.updatedTime ? formatTimeAgo(data.updatedTime) : "Unknown";
  const updatedAbsolute = formatAbsoluteWib(data.updatedTime);
  const rating = data.rating ?? "N/A";
  const status = statusBar[data.status] ?? "Unknown";
  const safeMangaUrl = String(data.mangaUrl || data.url || "").trim();
  const safeChapterUrl = String(data.url || data.mangaUrl || "").trim();
  const miniBadge = sourceMiniBadge(data.source);
  const eventTimestamp = new Date().toISOString();
  const titleLine = safeMangaUrl
    ? `**[${title}](${safeMangaUrl})** \`${miniBadge}\``
    : `**${title}** \`${miniBadge}\``;
  const actionLine =
    safeChapterUrl && safeMangaUrl
      ? `[Read Chapter](${safeChapterUrl}) | [Series Page](${safeMangaUrl})`
      : safeChapterUrl
        ? `[Read Chapter](${safeChapterUrl})`
        : safeMangaUrl
          ? `[Series Page](${safeMangaUrl})`
          : null;
  const toastContent = buildToastContent({
    sourceLabel,
    title,
    chapter,
  });

  const embeds = [
    {
      color: source.color || statusColor,
      author: {
        name: `CHAPTER UPDATE | ${source.badge}`,
        url: source.siteUrl,
      },
      title: undefined,
      url: undefined,
      description: [
        titleLine,
        "",
        `**${chapter}**`,
        `Status : \`${status}\``,
        `Updated: \`${updatedRelative}\`${updatedAbsolute ? ` (\`${updatedAbsolute} WIB\`)` : ""}`,
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
      thumbnail: data.cover?.startsWith("http") ? { url: data.cover } : undefined,
      timestamp: eventTimestamp,
    },
  ];

  await httpPost(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    { content: toastContent, embeds },
    {
      headers: {
        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    },
    { retries: 3, baseDelayMs: 350, maxDelayMs: 5000 },
  );
}




