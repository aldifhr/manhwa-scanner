import {
  verifyKey,
  InteractionType,
  InteractionResponseType,
} from "discord-interactions";
import { Redis } from "@upstash/redis";
import axios from "axios";
import * as cheerio from "cheerio";
import {
  formatTimeAgo,
  fetchDescription,
  scrapeMangaUpdates,
} from "../lib/scraper.js";

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const SITE_URL = "https://02.ikiru.wtf/";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.DISCORD_APPLICATION_ID;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export const config = {
  api: { bodyParser: false },
};

const STATUS_COLORS = {
  "Ongoing":   0x22c55e,
  "Completed": 0x3b82f6,
  "Hiatus":    0xf59e0b,
  "Unknown":   0x6b7280,
};

const statusBar = {
  "Ongoing":   "🟢 Ongoing",
  "Completed": "🔵 Completed",
  "Hiatus":    "🟡 Hiatus",
  "Unknown":   "⚪ Unknown",
};

const ratingStars = (rating) => {
  if (!rating || rating === "N/A") return "`No rating`";
  const num = parseFloat(rating);
  const filled = Math.round(num / 2);
  const display = Number.isInteger(num) ? num : num.toFixed(1);
  return "★".repeat(filled) + "☆".repeat(5 - filled) + ` \`${display}/10\``;
};

const shortSynopsis = (description) => {
  if (!description) return null;
  const sentences = description.split(". ");
  const short = sentences.slice(0, 2).join(". ");
  return short.endsWith(".") ? short : short + ".";
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function loadWhitelist() {
  try {
    return (await redis.get("whitelist:manga")) || [];
  } catch {
    return [];
  }
}

async function saveWhitelist(manga) {
  await redis.set("whitelist:manga", manga);
}

async function getNotificationChannel(guildId) {
  try {
    return await redis.get(`channel:${guildId}`);
  } catch {
    return null;
  }
}

async function setNotificationChannel(guildId, channelId) {
  await redis.set(`channel:${guildId}`, channelId);
}

async function getAllGuildChannels() {
  const guildKeys = await redis.keys("channel:*");
  const guildChannels = {};
  for (const key of guildKeys) {
    guildChannels[key.replace("channel:", "")] = await redis.get(key);
  }
  return guildChannels;
}

async function editInteractionResponse(token, content) {
  await axios.patch(
    `https://discord.com/api/v10/webhooks/${APP_ID}/${token}/messages/@original`,
    { content },
    { headers: { "Content-Type": "application/json" } }
  );
}

async function sendDiscord(data, channelId) {
  // ✅ Fetch description di sini supaya konsisten
  const description = data.description || (await fetchDescription(data.mangaUrl));
  const synopsis = shortSynopsis(description);
  const color = STATUS_COLORS[data.status] || STATUS_COLORS["Unknown"];

  const embeds = [
    {
      color,
      author: {
        name: "⚡  Chapter Baru Tersedia — ikiru.wtf",
        icon_url: "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png",
        url: "https://02.ikiru.wtf",
      },
      image: data.cover?.startsWith("http") ? { url: data.cover } : undefined,
    },
    {
      color,
      title: data.title,
      url: data.mangaUrl,
      description: [
        `**📖 ${data.chapter}**`,
        ``,
        synopsis ? `> ${synopsis}` : null,
        ``,
        `**[→ Baca Sekarang](${data.url})**`,
      ].filter(Boolean).join("\n"),
      fields: [
        {
          name: "⭐ Rating",
          value: ratingStars(data.rating),
          inline: true,
        },
        {
          name: "📊 Status",
          value: `\`${statusBar[data.status] || "⚪ Unknown"}\``,
          inline: true,
        },
        {
          name: "🕐 Updated",
          value: data.updatedTime ? `\`${formatTimeAgo(data.updatedTime)}\`` : "`Unknown`",
          inline: true,
        },
      ],
      footer: {
        text: "ikiru.wtf  •  Manga Tracker",
        icon_url: "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png",
      },
      timestamp: new Date().toISOString(),
    },
  ];

  if (channelId && DISCORD_BOT_TOKEN) {
    await axios.post(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      { embeds },
      {
        headers: {
          "Authorization": `Bot ${DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  }
}

// ✅ Flow /add:
// 1. Tambah ke whitelist
// 2. Scrape manga terbaru
// 3. Kalau ada chapter baru → kirim notif ke semua channel
// 4. Edit response slash command dengan hasilnya
async function checkAndNotify(title, token) {
  try {
    console.log(`🔍 [checkAndNotify] Started for: "${title}"`);

    const allResults = await scrapeMangaUpdates(redis);
    console.log(`📦 [checkAndNotify] Scraped ${allResults.length} items`);

    const matched = allResults.filter(item =>
      item.title.toLowerCase().includes(title.toLowerCase()) ||
      title.toLowerCase().includes(item.title.toLowerCase())
    );
    console.log(`🎯 [checkAndNotify] Matched ${matched.length} items for "${title}"`);

    // Tidak ada chapter baru
    if (matched.length === 0) {
      await editInteractionResponse(
        token,
        `✅ **"${title}"** ditambahkan ke whitelist!\n📭 Belum ada chapter baru saat ini. Notifikasi otomatis saat chapter baru rilis!`
      );
      return;
    }

    const guildChannels = await getAllGuildChannels();
    console.log(`📢 [checkAndNotify] Guild channels: ${JSON.stringify(guildChannels)}`);

    if (Object.keys(guildChannels).length === 0) {
      await editInteractionResponse(
        token,
        `✅ **"${title}"** ditambahkan ke whitelist!\n⚠️ Belum ada channel notifikasi yang diset. Gunakan \`/setchannel #channel\` dulu.`
      );
      return;
    }

    let sentCount = 0;

    for (const item of matched) {
      const key = `chapter:${item.url}`;
      const alreadySent = await redis.get(key);

      if (alreadySent) {
        console.log(`⏭️ [checkAndNotify] Skipped (already sent): ${item.title} - ${item.chapter}`);
        continue;
      }

      console.log(`📤 [checkAndNotify] Sending: "${item.title}" - ${item.chapter}`);

      for (const [guildId, channelId] of Object.entries(guildChannels)) {
        try {
          await sendDiscord(item, channelId);
          console.log(`✅ [checkAndNotify] Sent to guild ${guildId}, channel ${channelId}`);
        } catch (err) {
          console.error(`❌ [checkAndNotify] Failed to send to guild ${guildId}: ${err.message}`);
        }
      }

      // Mark sebagai sudah dikirim supaya cron tidak duplikat
      await redis.set(key, "sent");
      sentCount++;
    }

    console.log(`📊 [checkAndNotify] Total sent: ${sentCount}`);

    await editInteractionResponse(
      token,
      sentCount > 0
        ? `✅ **"${title}"** ditambahkan ke whitelist!\n📬 Ditemukan **${sentCount}** chapter baru — notifikasi dikirim ke semua channel!`
        : `✅ **"${title}"** ditambahkan ke whitelist!\n📭 Chapter baru sudah pernah dikirim sebelumnya. Notifikasi otomatis saat chapter berikutnya rilis!`
    );

    console.log(`✅ [checkAndNotify] Finished for: "${title}"`);
  } catch (err) {
    console.error(`❌ [checkAndNotify] Error: ${err.message}`);
    console.error(err.stack);
    try {
      await editInteractionResponse(
        token,
        `✅ **"${title}"** ditambahkan ke whitelist!\n⚠️ Gagal cek chapter: ${err.message}`
      );
    } catch (editErr) {
      console.error(`❌ [checkAndNotify] Failed to edit response: ${editErr.message}`);
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];

    if (!PUBLIC_KEY) {
      return res.status(401).json({ error: "Public key not configured" });
    }

    const rawBody = await getRawBody(req);
    const body = rawBody.toString();

    const isValid = await verifyKey(body, signature, timestamp, PUBLIC_KEY);
    if (!isValid) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const payload = JSON.parse(body);

    // Discord ping verification
    if (payload.type === 1) {
      return res.json({ type: 1 });
    }

    const { type, data: interactionData } = payload;

    if (type === InteractionType.APPLICATION_COMMAND) {
      const { name, options } = interactionData;

      // ─────────────────────────────────────────
      // /add <title>
      // ─────────────────────────────────────────
      if (name === "add") {
        const title = options?.[0]?.value;
        if (!title) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ Please provide a manga title!" },
          });
        }

        const whitelist = await loadWhitelist();
        if (whitelist.some(t => t.toLowerCase() === title.toLowerCase())) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `⚠️ **"${title}"** sudah ada di whitelist!` },
          });
        }

        whitelist.push(title);
        await saveWhitelist(whitelist);

        // Kirim deferred response dulu (type 5) supaya tidak timeout
        res.json({ type: 5 });

        // Scrape + notify di background
        checkAndNotify(title, payload.token);
        return;
      }

      // ─────────────────────────────────────────
      // /remove <title>
      // ─────────────────────────────────────────
      if (name === "remove") {
        const title = options?.[0]?.value;
        if (!title) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ Please provide a manga title!" },
          });
        }

        const whitelist = await loadWhitelist();
        const index = whitelist.findIndex(t => t.toLowerCase() === title.toLowerCase());

        if (index === -1) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `⚠️ **"${title}"** tidak ada di whitelist!` },
          });
        }

        whitelist.splice(index, 1);
        await saveWhitelist(whitelist);

        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `✅ Removed **"${title}"** dari whitelist!\n📋 Total: **${whitelist.length}** manga`,
          },
        });
      }

      // ─────────────────────────────────────────
      // /list
      // ─────────────────────────────────────────
      if (name === "list") {
        const whitelist = await loadWhitelist();
        if (whitelist.length === 0) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "📋 Whitelist kosong!" },
          });
        }

        const list = whitelist.map((t, i) => `${i + 1}. ${t}`).join("\n");
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `📋 **Whitelisted Manga (${whitelist.length}):**\n\n${list}`,
          },
        });
      }

      // ─────────────────────────────────────────
      // /clear
      // ─────────────────────────────────────────
      if (name === "clear") {
        const whitelist = await loadWhitelist();
        const count = whitelist.length;
        await saveWhitelist([]);
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `🗑️ **Whitelist cleared!**\nRemoved **${count}** manga dari whitelist.`,
          },
        });
      }

      // ─────────────────────────────────────────
      // /status
      // ─────────────────────────────────────────
      if (name === "status") {
        const whitelist = await loadWhitelist();
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `📊 **Bot Status**\n\n📋 Whitelisted: **${whitelist.length}** manga\n⏱️ Check interval: Every 5 minutes\n🔔 Notifications: Discord`,
          },
        });
      }

      // ─────────────────────────────────────────
      // /info <title>
      // ─────────────────────────────────────────
      if (name === "info") {
        const title = options?.[0]?.value;
        if (!title) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ Please provide a manga title!" },
          });
        }

        try {
          const searchResponse = await axios.post(
            "https://02.ikiru.wtf/wp-admin/admin-ajax.php?nonce=eecc652792&action=search",
            new URLSearchParams({ query: title }),
            {
              headers: {
                "User-Agent": "Mozilla/5.0",
                "Content-Type": "application/x-www-form-urlencoded",
              },
              timeout: 10000,
            }
          );

          const $search = cheerio.load(searchResponse.data);
          let mangaUrl = null;
          let mangaTitle = null;

          $search("a").each((i, el) => {
            const foundTitle = $search(el).find("h3, .title, h2").text().trim();
            if (foundTitle && foundTitle.toLowerCase().includes(title.toLowerCase())) {
              mangaUrl = $search(el).attr("href");
              mangaTitle = foundTitle;
              return false;
            }
          });

          if (!mangaUrl) {
            return res.json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { content: `🔍 Manga **"${title}"** tidak ditemukan.` },
            });
          }

          const fullUrl = mangaUrl.startsWith("http") ? mangaUrl : `https://02.ikiru.wtf${mangaUrl}`;
          const detailResponse = await axios.get(fullUrl, {
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 10000,
          });

          const $detail = cheerio.load(detailResponse.data);
          const description =
            $detail('meta[name="description"]').attr("content") ||
            $detail(".description, .summary, [class*='description']").first().text().trim() ||
            "No synopsis available";
          const rating = $detail(".numscore").first().text().trim() || "N/A";
          const status = $detail("p.font-normal.text-xs, .status")
            .filter((_, el) => {
              const t = $detail(el).text().trim();
              return ["Ongoing", "Completed", "Hiatus", "Dropped"].includes(t);
            })
            .first()
            .text()
            .trim() || "Unknown";
          const chapters = $detail("a[href*='chapter']").length || "Unknown";
          const shortDesc = description.length > 200 ? description.substring(0, 197) + "..." : description;

          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content:
                `📖 **[${mangaTitle}](${fullUrl})**\n\n` +
                `⭐ **Rating:** ${rating}/10\n` +
                `📊 **Status:** ${status}\n` +
                `📚 **Chapters:** ${chapters}\n\n` +
                `📝 **Synopsis:**\n${shortDesc}\n\n` +
                `💡 Use \`/add "${mangaTitle}"\` to add to whitelist`,
            },
          });
        } catch (err) {
          console.error("Info error:", err);
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `❌ Error getting manga info: ${err.message}` },
          });
        }
      }

      // ─────────────────────────────────────────
      // /recent
      // ─────────────────────────────────────────
      if (name === "recent") {
        try {
          const response = await axios.get(SITE_URL, {
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 10000,
          });
          const $ = cheerio.load(response.data);
          const results = [];
          let inSection = false;

          $("*").each((i, el) => {
            const tagName = el.tagName?.toLowerCase();
            const text = $(el).text().trim();

            if (tagName === "h1" && (text === "Project Updates" || text === "Latest Updates")) {
              inSection = true;
            }
            if (inSection && tagName === "h1" && text !== "Project Updates" && text !== "Latest Updates" && text.includes("Updates")) {
              inSection = false;
            }
            if (inSection && tagName === "a") {
              const card = $(el);
              const chapterText = card.find("p").text().trim();
              if (chapterText.includes("Chapter")) {
                const parent = card.parent();
                let title = parent.find("h1").text().trim();
                if (!title) title = card.find("h3").text().trim();
                const updatedTime = card.find("time").attr("datetime");
                if (title && chapterText) {
                  results.push({ title, chapter: chapterText, updatedTime });
                }
              }
            }
          });

          if (results.length === 0) {
            return res.json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { content: "🕐 No recent chapters found." },
            });
          }

          const recent = results.slice(0, 5);
          const list = recent.map(r => `• **${r.title}** — ${r.chapter}`).join("\n");
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `🕐 **5 Latest Chapters:**\n\n${list}` },
          });
        } catch (err) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `❌ Error fetching recent chapters: ${err.message}` },
          });
        }
      }

      // ─────────────────────────────────────────
      // /setchannel <channel>
      // ─────────────────────────────────────────
      if (name === "setchannel") {
        const guildId = payload.guild_id;
        const channelId = options?.[0]?.value;

        if (!guildId) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ This command only works in servers!" },
          });
        }
        if (!channelId) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ Please provide a channel!" },
          });
        }

        await setNotificationChannel(guildId, channelId);
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `✅ **Notification channel set!**\nManga updates akan dikirim ke <#${channelId}>`,
          },
        });
      }

      // ─────────────────────────────────────────
      // /getchannel
      // ─────────────────────────────────────────
      if (name === "getchannel") {
        const guildId = payload.guild_id;
        if (!guildId) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ This command only works in servers!" },
          });
        }

        const channelId = await getNotificationChannel(guildId);
        if (!channelId) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "⚠️ Belum ada notification channel. Gunakan `/setchannel #channel`" },
          });
        }

        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `📢 **Current notification channel:** <#${channelId}>` },
        });
      }

      // ─────────────────────────────────────────
      // /popular [period]
      // ─────────────────────────────────────────
      if (name === "popular") {
        try {
          const period = options?.[0]?.value || "daily";
          const periodText = period === "daily" ? "Today" : period === "weekly" ? "This Week" : "This Month";
          const response = await axios.get(SITE_URL, {
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 10000,
          });
          const $ = cheerio.load(response.data);
          const results = [];

          $(`[data-trending-chart="${period}"] li`).each((i, el) => {
            const link = $(el).find("a").attr("href");
            const title = $(el).find("h3").text().trim();
            if (title && link) {
              results.push({
                rank: i + 1,
                title,
                url: link.startsWith("http") ? link : `https://02.ikiru.wtf${link}`,
              });
            }
          });

          if (results.length === 0) {
            return res.json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { content: `🔥 No popular manga found for **${periodText}**.` },
            });
          }

          const list = results.map(r => {
            const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : `#${r.rank}`;
            return `${medal} **[${r.title}](${r.url})**`;
          }).join("\n");

          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `🔥 **Popular Manga — ${periodText}:**\n\n${list}` },
          });
        } catch (err) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `❌ Error: ${err.message}` },
          });
        }
      }

      // ─────────────────────────────────────────
      // /topseries
      // ─────────────────────────────────────────
      if (name === "topseries") {
        try {
          const response = await axios.get(SITE_URL, {
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 10000,
          });
          const $ = cheerio.load(response.data);
          const results = [];

          $('section:has(h2:contains("Top Series")) a[href*="/manga/"]').each((i, el) => {
            const link = $(el).attr("href");
            const title = $(el).find(".font-bold").text().trim();
            const rank = $(el).find(".index-name").text().trim();
            const genres = [];
            $(el).find(".rounded-full span").each((_, genreEl) => genres.push($(genreEl).text().trim()));

            if (title && link) {
              results.push({
                rank: parseInt(rank) || i + 1,
                title,
                url: link.startsWith("http") ? link : `https://02.ikiru.wtf${link}`,
                genres,
              });
            }
          });

          if (results.length === 0) {
            return res.json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { content: "⭐ No top series found." },
            });
          }

          const list = results.slice(0, 10).map(r => {
            const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : `#${r.rank}`;
            const genreText = r.genres.length > 0 ? `*${r.genres.slice(0, 3).join(", ")}*` : "";
            return `${medal} **[${r.title}](${r.url})** ${genreText}`;
          }).join("\n");

          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `⭐ **Top Series:**\n\n${list}` },
          });
        } catch (err) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `❌ Error: ${err.message}` },
          });
        }
      }
    }

    return res.status(400).json({ error: "Unknown interaction type" });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: err.message });
  }
}
