import axios from "axios";
import { formatTimeAgo } from "./scraper.js";

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

export const ratingStars = (rating) => {
  if (!rating || rating === "N/A") return "`No rating`";
  const num = parseFloat(rating);
  if (Number.isNaN(num)) return "`No rating`";
  const filled = Math.min(5, Math.max(0, Math.round(num / 2)));
  const display = Number.isInteger(num) ? num : num.toFixed(1);
  return "*".repeat(filled) + "-".repeat(5 - filled) + ` \`${display}/10\``;
};

export const shortSynopsis = (description) => {
  if (!description) return null;
  if (description.length <= 150) return description;
  const cut = description.lastIndexOf(" ", 150);
  return description.substring(0, cut > 0 ? cut : 150) + "...";
};

export async function editInteractionResponse(token, content) {
  const t = typeof token === "object" ? token.token : token;
  const safeContent =
    content?.length > 2000 ? `${content.substring(0, 1997)}...` : content;

  await axios.patch(
    `https://discord.com/api/v10/webhooks/${APP_ID}/${t}/messages/@original`,
    { content: safeContent || undefined },
    { headers: { "Content-Type": "application/json" } },
  );
}

export async function editInteractionResponseWithComponents(
  token,
  content,
  components,
  embeds = [],
) {
  const t = typeof token === "object" ? token.token : token;

  await axios.patch(
    `https://discord.com/api/v10/webhooks/${APP_ID}/${t}/messages/@original`,
    { content: content || undefined, components, embeds },
    { headers: { "Content-Type": "application/json" } },
  );
}

function normalizeSourceLabel(source) {
  const s = String(source || "").toLowerCase();
  if (s === "shinigami_mirror") return "Shinigami (Mirror)";
  if (s === "shinigami_project" || s === "shinigami") return "Shinigami (Project)";
  return "Ikiru";
}

export async function sendDiscordEmbed(data, channelId, redis = null) {
  const color = STATUS_COLORS[data.status] ?? STATUS_COLORS.Unknown;
  const sourceLabel = normalizeSourceLabel(data.source);

  const embeds = [
    {
      color,
      author: {
        name: "NEW CHAPTER",
        icon_url:
          "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png",
        url: "https://02.ikiru.wtf",
      },
      title: data.title,
      url: data.mangaUrl,
      description: [
        `Source: ${sourceLabel}`,
        `Chapter: ${data.chapter}`,
        `Rating: ${data.rating ?? "?"} | Status: ${statusBar[data.status] ?? "Unknown"}`,
        `Updated: ${data.updatedTime ? formatTimeAgo(data.updatedTime) : "Unknown"}`,
        "",
        `**[Read Now](${data.url})**`,
      ].join("\n"),
      thumbnail: data.cover?.startsWith("http") ? { url: data.cover } : undefined,
      footer: {
        text: `Manga Tracker | source: ${sourceLabel}`,
        icon_url:
          "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png",
      },
      timestamp: new Date().toISOString(),
    },
  ];

  await axios.post(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    { embeds },
    {
      headers: {
        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
  );
}
