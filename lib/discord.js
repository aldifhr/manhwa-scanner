import axios from "axios";
import { formatTimeAgo, fetchDescription } from "./scraper.js";

const APP_ID = process.env.DISCORD_APPLICATION_ID;
export const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

export const STATUS_COLORS = {
  Ongoing: 0x22c55e,
  Completed: 0x3b82f6,
  Hiatus: 0xf59e0b,
  Unknown: 0x6b7280,
};

export const statusBar = {
  Ongoing: "🟢 Ongoing",
  Completed: "🔵 Completed",
  Hiatus: "🟡 Hiatus",
  Unknown: "⚪ Unknown",
};

/**
 * Render rating sebagai bintang 1–5.
 * Clamp antara 0–5 agar tidak overflow kalau data kotor.
 */
export const ratingStars = (rating) => {
  if (!rating || rating === "N/A") return "`No rating`";
  const num = parseFloat(rating);
  if (isNaN(num)) return "`No rating`";
  const filled = Math.min(5, Math.max(0, Math.round(num / 2)));
  const display = Number.isInteger(num) ? num : num.toFixed(1);
  return "★".repeat(filled) + "☆".repeat(5 - filled) + ` \`${display}/10\``;
};

/**
 * Potong synopsis maksimal 150 karakter, tidak terpotong di tengah kata.
 * Menghindari bug split ". " yang salah potong pada singkatan (Dr., Mr., dll).
 */
export const shortSynopsis = (description) => {
  if (!description) return null;
  if (description.length <= 150) return description;
  const cut = description.lastIndexOf(" ", 150);
  return description.substring(0, cut > 0 ? cut : 150) + "...";
};

// ─── INTERACTION HELPERS ──────────────────────────────────────────────────────

/**
 * Edit deferred interaction response (text only).
 * token bisa string langsung atau payload object { token }.
 * Rethrow error agar caller bisa handle.
 */
export async function editInteractionResponse(token, content) {
  const t = typeof token === "object" ? token.token : token;

  const safeContent =
    content?.length > 2000 ? content.substring(0, 1997) + "..." : content;

  try {
    await axios.patch(
      `https://discord.com/api/v10/webhooks/${APP_ID}/${t}/messages/@original`,
      { content: safeContent || undefined },
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(`[editInteractionResponse] Failed: ${err.message}`);
    if (err.response) {
      console.error(`Status: ${err.response.status}`);
      console.error(`Body: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

/**
 * Edit deferred interaction response dengan components dan/atau embeds.
 * token bisa string langsung atau payload object { token }.
 * Rethrow error agar caller bisa handle.
 */
export async function editInteractionResponseWithComponents(
  token,
  content,
  components,
  embeds = [],
) {
  const t = typeof token === "object" ? token.token : token;

  try {
    await axios.patch(
      `https://discord.com/api/v10/webhooks/${APP_ID}/${t}/messages/@original`,
      { content: content || undefined, components, embeds },
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(
      `[editInteractionResponseWithComponents] Failed: ${err.message}`,
    );
    if (err.response) {
      console.error(`Status: ${err.response.status}`);
      console.error(`Body: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

// ─── EMBED SENDER ─────────────────────────────────────────────────────────────

/**
 * Kirim embed notifikasi chapter baru ke channel Discord.
 * redis opsional — dipakai untuk cache description agar tidak re-fetch.
 */
export async function sendDiscordEmbed(data, channelId, redis = null) {
  const color = STATUS_COLORS[data.status] ?? STATUS_COLORS.Unknown;

  const embeds = [
    {
      color,
      author: {
        name: "⚡ CHAPTER BARU",
        icon_url:
          "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png",
        url: "https://02.ikiru.wtf",
      },
      title: data.title,
      url: data.mangaUrl,
      description: [
        `📖 ${data.chapter}  ·  ⭐ ${data.rating ?? "?"}  ·  ${statusBar[data.status] ?? "⚪ Unknown"}  ·  ${data.updatedTime ? formatTimeAgo(data.updatedTime) : "Unknown"}`,
        ``,
        `**[→ Baca Sekarang](${data.url})**`,
      ].join("\n"),
      thumbnail: data.cover?.startsWith("http")
        ? { url: data.cover }
        : undefined,
      footer: {
        text: "ikiru.wtf  •  Manga Tracker",
        icon_url:
          "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png",
      },
      timestamp: new Date().toISOString(),
    },
  ];

  try {
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
  } catch (err) {
    console.error(
      `[sendDiscordEmbed] Failed for channel ${channelId}:`,
      err.message,
    );
    if (err.response) {
      console.error(`Status: ${err.response.status}`);
      console.error(`Body: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}
