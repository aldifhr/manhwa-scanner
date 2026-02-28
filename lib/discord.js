import axios from "axios";
import { formatTimeAgo, fetchDescription } from "./scraper.js";

const APP_ID   = process.env.DISCORD_APPLICATION_ID;
export const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

export const STATUS_COLORS = {
  "Ongoing":   0x22c55e,
  "Completed": 0x3b82f6,
  "Hiatus":    0xf59e0b,
  "Unknown":   0x6b7280,
};

export const statusBar = {
  "Ongoing":   "🟢 Ongoing",
  "Completed": "🔵 Completed",
  "Hiatus":    "🟡 Hiatus",
  "Unknown":   "⚪ Unknown",
};

export const ratingStars = (rating) => {
  if (!rating || rating === "N/A") return "`No rating`";
  const num     = parseFloat(rating);
  const filled  = Math.round(num / 2);
  const display = Number.isInteger(num) ? num : num.toFixed(1);
  return "★".repeat(filled) + "☆".repeat(5 - filled) + ` \`${display}/10\``;
};

export const shortSynopsis = (description) => {
  if (!description) return null;
  const sentences = description.split(". ");
  const short     = sentences.slice(0, 2).join(". ");
  return short.endsWith(".") ? short : short + ".";
};

export async function editInteractionResponse(token, content) {
  try {
    const safeContent = content.length > 2000
      ? content.substring(0, 1997) + "..."
      : content;

    await axios.patch(
      `https://discord.com/api/v10/webhooks/${APP_ID}/${token}/messages/@original`,
      { content: safeContent },
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(`❌ editInteractionResponse failed: ${err.message}`);
    if (err.response) {
      console.error(`Status: ${err.response.status}`);
      console.error(`Body: ${JSON.stringify(err.response.data)}`);
    }
  }
}

export async function editInteractionResponseWithComponents(token, content, components, embeds = []) {
  try {
    await axios.patch(
      `https://discord.com/api/v10/webhooks/${APP_ID}/${token}/messages/@original`,
      { content: content || undefined, components, embeds },
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(`❌ editWithComponents failed: ${err.message}`);
    if (err.response) {
      console.error(`Status: ${err.response.status}`);
      console.error(`Body: ${JSON.stringify(err.response.data)}`);
    }
  }
}


// ← BARU: untuk edit pesan existing (pagination button handler)
export async function editWithComponents(payload, content, components, embeds = []) {
  try {
    await axios.patch(
      `https://discord.com/api/v10/webhooks/${APP_ID}/${payload.token}/messages/@original`,
      { content: content || undefined, components, embeds },
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(`❌ editWithComponents failed: ${err.message}`);
    if (err.response) {
      console.error(`Status: ${err.response.status}`);
      console.error(`Body: ${JSON.stringify(err.response.data)}`);
    }
  }
}

export async function sendDiscordEmbed(data, channelId) {
  const description = data.description || (await fetchDescription(data.mangaUrl));
  const synopsis    = shortSynopsis(description);
  const color       = STATUS_COLORS[data.status] || STATUS_COLORS["Unknown"];

  const embeds = [
    {
      color,
      author: {
        name:     "⚡  Chapter Baru Tersedia — ikiru.wtf",
        icon_url: "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png",
        url:      "https://02.ikiru.wtf",
      },
      image: data.cover?.startsWith("http") ? { url: data.cover } : undefined,
    },
    {
      color,
      title:       data.title,
      url:         data.mangaUrl,
      description: [
        `**📖 ${data.chapter}**`,
        ``,
        synopsis ? `> ${synopsis}` : null,
        ``,
        `**[→ Baca Sekarang](${data.url})**`,
      ].filter(Boolean).join("\n"),
      fields: [
        { name: "⭐ Rating",  value: ratingStars(data.rating),                                                  inline: true },
        { name: "📊 Status",  value: `\`${statusBar[data.status] || "⚪ Unknown"}\``,                           inline: true },
        { name: "🕐 Updated", value: data.updatedTime ? `\`${formatTimeAgo(data.updatedTime)}\`` : "`Unknown`", inline: true },
      ],
      footer: {
        text:     "ikiru.wtf  •  Manga Tracker",
        icon_url: "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png",
      },
      timestamp: new Date().toISOString(),
    },
  ];

  await axios.post(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    { embeds },
    {
      headers: {
        "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        "Content-Type":  "application/json",
      },
    }
  );
}
