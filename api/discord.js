import {
  verifyKey,
  InteractionType,
  InteractionResponseType,
} from "discord-interactions";
import { Redis } from "@upstash/redis";
import axios from "axios";
import * as cheerio from "cheerio";
import { waitUntil } from "@vercel/functions";
import {
  formatTimeAgo,
  fetchDescription,
  scrapeMangaUpdates,
} from "../lib/scraper.js";

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const SITE_URL   = "https://02.ikiru.wtf/";
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const APP_ID     = process.env.DISCORD_APPLICATION_ID;

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export const config = {
  api: { bodyParser: false },
};

const CHAPTER_TTL = 60 * 60 * 24 * 3;

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const ratingStars = (rating) => {
  if (!rating || rating === "N/A") return "`No rating`";
  const num     = parseFloat(rating);
  const filled  = Math.round(num / 2);
  const display = Number.isInteger(num) ? num : num.toFixed(1);
  return "★".repeat(filled) + "☆".repeat(5 - filled) + ` \`${display}/10\``;
};

const shortSynopsis = (description) => {
  if (!description) return null;
  const sentences = description.split(". ");
  const short     = sentences.slice(0, 2).join(". ");
  return short.endsWith(".") ? short : short + ".";
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data",  (chunk) => chunks.push(chunk));
    req.on("end",   () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────
// REDIS HELPERS
// ─────────────────────────────────────────────────────────

async function loadWhitelist() {
  try {
    return (await redis.get("whitelist:manga")) || [];
  } catch {
    return [];
  }
}

async function saveWhitelist(list) {
  await redis.set("whitelist:manga", list);
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
  const keys   = await redis.keys("channel:*");
  const result = {};
  for (const key of keys) {
    result[key.replace("channel:", "")] = await redis.get(key);
  }
  return result;
}

// ─────────────────────────────────────────────────────────
// DISCORD HELPERS
// ─────────────────────────────────────────────────────────

async function editInteractionResponse(token, content) {
  try {
    await axios.patch(
      `https://discord.com/api/v10/webhooks/${APP_ID}/${token}/messages/@original`,
      { content },
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(`❌ editInteractionResponse failed: ${err.message}`);
  }
}

async function sendDiscordEmbed(data, channelId) {
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
        "Authorization": `Bot ${BOT_TOKEN}`,
        "Content-Type":  "application/json",
      },
    }
  );
}

// ─────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────

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
    const body    = rawBody.toString();

    const isValid = await verifyKey(body, signature, timestamp, PUBLIC_KEY);
    if (!isValid) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const payload = JSON.parse(body);

    if (payload.type === 1) {
      return res.json({ type: 1 });
    }

    const { type, data: interactionData } = payload;

    if (type === InteractionType.APPLICATION_COMMAND) {
      const { name, options } = interactionData;

      // ───────────────────────────────────────
      // /ping
      // ───────────────────────────────────────
      if (name === "ping") {
        const start = Date.now();

        let redisStatus = "✅ Online";
        try {
          await redis.ping();
        } catch {
          redisStatus = "❌ Offline";
        }

        const latency = Date.now() - start;

        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content:
              `🏓 **Pong!**\n\n` +
              `⚡ Latency  : \`${latency}ms\`\n` +
              `🗄️ Redis    : ${redisStatus}\n` +
              `🤖 Bot      : \`Online\``,
          },
        });
      }

      // ───────────────────────────────────────
      // /list
      // ───────────────────────────────────────
      if (name === "list") {
        res.json({ type: 5 });

        waitUntil((async () => {
          try {
            const whitelist = await loadWhitelist();
            const content = whitelist.length === 0
              ? "📋 Whitelist kosong!"
              : `📋 **Whitelisted Manga (${whitelist.length}):**\n\n${whitelist.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;
            await editInteractionResponse(payload.token, content);
          } catch (err) {
            await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
          }
        })());
        return;
      }

      // ───────────────────────────────────────
      // /add <title>
      // ───────────────────────────────────────
      if (name === "add") {
        const title = options?.[0]?.value;
        if (!title) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ Please provide a manga title!" },
          });
        }

        res.json({ type: 5 });

        waitUntil((async () => {
          try {
            const whitelist = await loadWhitelist();
            if (whitelist.some((t) => t.toLowerCase() === title.toLowerCase())) {
              await editInteractionResponse(payload.token, `⚠️ **"${title}"** sudah ada di whitelist!`);
              return;
            }
            whitelist.push(title);
            await saveWhitelist(whitelist);
            await editInteractionResponse(payload.token,
              `✅ **"${title}"** ditambahkan ke whitelist!\n🔔 Notifikasi otomatis saat chapter baru rilis!`
            );
          } catch (err) {
            await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
          }
        })());
        return;
      }

      // ───────────────────────────────────────
      // /remove <title>
      // ───────────────────────────────────────
      if (name === "remove") {
        const title = options?.[0]?.value;
        if (!title) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ Please provide a manga title!" },
          });
        }

        res.json({ type: 5 });

        waitUntil((async () => {
          try {
            const whitelist = await loadWhitelist();
            const index = whitelist.findIndex((t) => t.toLowerCase() === title.toLowerCase());
            if (index === -1) {
              await editInteractionResponse(payload.token, `⚠️ **"${title}"** tidak ada di whitelist!`);
              return;
            }
            whitelist.splice(index, 1);
            await saveWhitelist(whitelist);
            await editInteractionResponse(payload.token,
              `✅ Removed **"${title}"** dari whitelist!\n📋 Total: **${whitelist.length}** manga`
            );
          } catch (err) {
            await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
          }
        })());
        return;
      }

      // ───────────────────────────────────────
      // /clear
      // ───────────────────────────────────────
      if (name === "clear") {
        res.json({ type: 5 });

        waitUntil((async () => {
          try {
            const whitelist = await loadWhitelist();
            const count = whitelist.length;
            await saveWhitelist([]);
            await editInteractionResponse(payload.token,
              `🗑️ **Whitelist cleared!**\nRemoved **${count}** manga dari whitelist.`
            );
          } catch (err) {
            await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
          }
        })());
        return;
      }

      // ───────────────────────────────────────
      // /status
      // ───────────────────────────────────────
      if (name === "status") {
        res.json({ type: 5 });

        waitUntil((async () => {
          try {
            const whitelist = await loadWhitelist();
            await editInteractionResponse(payload.token,
              `📊 **Bot Status**\n\n` +
              `📋 Whitelisted : **${whitelist.length}** manga\n` +
              `⏱️ Check interval : Every 5 minutes\n` +
              `🗑️ Chapter cache TTL : **3 hari**\n` +
              `🔔 Notifications : Discord`
            );
          } catch (err) {
            await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
          }
        })());
        return;
      }

      // ───────────────────────────────────────
      // /check
      // ───────────────────────────────────────
      if (name === "check") {
        res.json({ type: 5 });

        waitUntil((async () => {
          try {
            const whitelist = await loadWhitelist();
            if (whitelist.length === 0) {
              await editInteractionResponse(payload.token,
                "⚠️ Whitelist kosong! Tambahkan manga dulu dengan `/add`"
              );
              return;
            }

            const allResults = await scrapeMangaUpdates(redis);
            const matched    = allResults.filter((item) =>
              whitelist.some((title) =>
                item.title.toLowerCase().includes(title.toLowerCase()) ||
                title.toLowerCase().includes(item.title.toLowerCase())
              )
            );

            if (matched.length === 0) {
              await editInteractionResponse(payload.token, "📭 Tidak ada chapter baru saat ini.");
              return;
            }

            const guildChannels = await getAllGuildChannels();
            if (Object.keys(guildChannels).length === 0) {
              await editInteractionResponse(payload.token,
                "⚠️ Belum ada notification channel. Gunakan `/setchannel #channel` dulu."
              );
              return;
            }

            let sentCount    = 0;
            let skippedCount = 0;

            for (const item of matched) {
              const key         = `chapter:${item.url}`;
              const alreadySent = await redis.get(key);

              if (alreadySent) {
                skippedCount++;
                continue;
              }

              for (const [guildId, channelId] of Object.entries(guildChannels)) {
                try {
                  await sendDiscordEmbed(item, channelId);
                } catch (err) {
                  console.error(`❌ [check] Failed guild ${guildId}: ${err.message}`);
                }
              }

              await redis.set(key, Date.now().toString(), { ex: CHAPTER_TTL });
              sentCount++;
            }

            if (sentCount > 0) {
              await editInteractionResponse(payload.token,
                `✅ Selesai! Ditemukan **${sentCount}** chapter baru — notifikasi dikirim!\n` +
                `⏭️ Skipped: **${skippedCount}** (sudah pernah dikirim)`
              );
            } else {
              await editInteractionResponse(payload.token,
                `📭 Semua chapter sudah pernah dikirim (**${skippedCount}** skipped).\n` +
                `Notifikasi otomatis saat chapter berikutnya rilis!`
              );
            }
          } catch (err) {
            console.error(`❌ [check] Fatal: ${err.message}`);
            await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
          }
        })());
        return;
      }

      // ───────────────────────────────────────
      // /info <title>
      // ───────────────────────────────────────
      if (name === "info") {
        const title = options?.[0]?.value;
        if (!title) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ Please provide a manga title!" },
          });
        }

        res.json({ type: 5 });

        waitUntil((async () => {
          try {
            const searchResponse = await axios.post(
              "https://02.ikiru.wtf/wp-admin/admin-ajax.php?nonce=eecc652792&action=search",
              new URLSearchParams({ query: title }),
              {
                headers: {
                  "User-Agent":   "Mozilla/5.0",
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                timeout: 10000,
              }
            );

            const $search  = cheerio.load(searchResponse.data);
            let mangaUrl   = null;
            let mangaTitle = null;

            $search("a").each((i, el) => {
              const foundTitle = $search(el).find("h3, .title, h2").text().trim();
              if (foundTitle && foundTitle.toLowerCase().includes(title.toLowerCase())) {
                mangaUrl   = $search(el).attr("href");
                mangaTitle = foundTitle;
                return false;
              }
            });

            if (!mangaUrl) {
              await editInteractionResponse(payload.token, `🔍 Manga **"${title}"** tidak ditemukan.`);
              return;
            }

            const fullUrl        = mangaUrl.startsWith("http") ? mangaUrl : `https://02.ikiru.wtf${mangaUrl}`;
            const detailResponse = await axios.get(fullUrl, {
              headers: { "User-Agent": "Mozilla/5.0" },
              timeout: 10000,
            });

            const $detail     = cheerio.load(detailResponse.data);
            const description =
              $detail('meta[name="description"]').attr("content") ||
              $detail(".description, .summary, [class*='description']").first().text().trim() ||
              "No synopsis available";
            const rating   = $detail(".numscore").first().text().trim() || "N/A";
            const status   = $detail("p.font-normal.text-xs, .status")
              .filter((_, el) => ["Ongoing", "Completed", "Hiatus", "Dropped"].includes($detail(el).text().trim()))
              .first()
              .text()
              .trim() || "Unknown";
            const chapters  = $detail("a[href*='chapter']").length || "Unknown";
            const shortDesc = description.length > 200 ? description.substring(0, 197) + "..." : description;

            await editInteractionResponse(payload.token,
              `📖 **[${mangaTitle}](${fullUrl})**\n\n` +
              `⭐ **Rating:** ${rating}/10\n` +
              `📊 **Status:** ${status}\n` +
              `📚 **Chapters:** ${chapters}\n\n` +
              `📝 **Synopsis:**\n${shortDesc}\n\n` +
              `💡 Use \`/add "${mangaTitle}"\` to add to whitelist`
            );
          } catch (err) {
            await editInteractionResponse(payload.token, `❌ Error getting manga info: ${err.message}`);
          }
        })());
        return;
      }

      // ───────────────────────────────────────
      // /recent
      // ───────────────────────────────────────
      if (name === "recent") {
        res.json({ type: 5 });

        waitUntil((async () => {
          try {
            const response = await axios.get(SITE_URL, {
              headers: { "User-Agent": "Mozilla/5.0" },
              timeout: 10000,
            });
            const $       = cheerio.load(response.data);
            const results = [];
            let inSection = false;

            $("*").each((i, el) => {
              const tagName = el.tagName?.toLowerCase();
              const text    = $(el).text().trim();

              if (tagName === "h1" && (text === "Project Updates" || text === "Latest Updates")) {
                inSection = true;
              }
              if (inSection && tagName === "h1" && text !== "Project Updates" && text !== "Latest Updates" && text.includes("Updates")) {
                inSection = false;
              }
              if (inSection && tagName === "a") {
                const card        = $(el);
                const chapterText = card.find("p").text().trim();
                if (chapterText.includes("Chapter")) {
                  const parent = card.parent();
                  let t        = parent.find("h1").text().trim() || card.find("h3").text().trim();
                  const updatedTime = card.find("time").attr("datetime");
                  if (t && chapterText) {
                    results.push({ title: t, chapter: chapterText, updatedTime });
                  }
                }
              }
            });

            if (results.length === 0) {
              await editInteractionResponse(payload.token, "🕐 No recent chapters found.");
              return;
            }

            const list = results
              .slice(0, 5)
              .map((r) => `• **${r.title}** — ${r.chapter}`)
              .join("\n");

            await editInteractionResponse(payload.token, `🕐 **5 Latest Chapters:**\n\n${list}`);
          } catch (err) {
            await editInteractionResponse(payload.token, `❌ Error fetching recent chapters: ${err.message}`);
          }
        })());
        return;
      }

      // ───────────────────────────────────────
      // /setchannel <channel>
      // ───────────────────────────────────────
      if (name === "setchannel") {
        const guildId   = payload.guild_id;
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

        res.json({ type: 5 });

        waitUntil((async () => {
          try {
            await setNotificationChannel(guildId, channelId);
            await editInteractionResponse(payload.token,
              `✅ **Notification channel set!**\nManga updates akan dikirim ke <#${channelId}>`
            );
          } catch (err) {
            await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
          }
        })());
        return;
      }

      // ───────────────────────────────────────
      // /getchannel
      // ───────────────────────────────────────
      if (name === "getchannel") {
        const guildId = payload.guild_id;
        if (!guildId) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "❌ This command only works in servers!" },
          });
        }

        res.json({ type: 5 });

        waitUntil((async () => {
          try {
            const channelId = await getNotificationChannel(guildId);
            if (!channelId) {
              await editInteractionResponse(payload.token,
                "⚠️ Belum ada notification channel. Gunakan `/setchannel #channel`"
              );
              return;
            }
            await editInteractionResponse(payload.token, `📢 **Current notification channel:** <#${channelId}>`);
          } catch (err) {
            await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
          }
        })());
        return;
      }

      // ───────────────────────────────────────
      // /popular [period]
      // ───────────────────────────────────────
      if (name === "popular") {
        res.json({ type: 5 });

        waitUntil((async () => {
          try {
            const period     = options?.[0]?.value || "daily";
            const periodText = period === "daily" ? "Today" : period === "weekly" ? "This Week" : "This Month";
            const response   = await axios.get(SITE_URL, {
              headers: { "User-Agent": "Mozilla/5.0" },
              timeout: 10000,
            });
            const $       = cheerio.load(response.data);
            const results = [];

            $(`[data-trending-chart="${period}"] li`).each((i, el) => {
              const link  = $(el).find("a").attr("href");
              const title = $(el).find("h3").text().trim();
              if (title && link) {
                results.push({
                  rank:  i + 1,
                  title,
                  url:   link.startsWith("http") ? link : `https://02.ikiru.wtf${link}`,
                });
              }
            });

            if (results.length === 0) {
              await editInteractionResponse(payload.token, `🔥 No popular manga found for **${periodText}**.`);
              return;
            }

            const list = results
              .map((r) => {
                const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : `#${r.rank}`;
                return `${medal} **[${r.title}](${r.url})**`;
              })
              .join("\n");

            await editInteractionResponse(payload.token, `🔥 **Popular Manga — ${periodText}:**\n\n${list}`);
          } catch (err) {
            await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
          }
        })());
        return;
      }

      // ───────────────────────────────────────
      // /topseries
      // ───────────────────────────────────────
      if (name === "topseries") {
        res.json({ type: 5 });

        waitUntil((async () => {
          try {
            const response = await axios.get(SITE_URL, {
              headers: { "User-Agent": "Mozilla/5.0" },
              timeout: 10000,
            });
            const $       = cheerio.load(response.data);
            const results = [];

            $('section:has(h2:contains("Top Series")) a[href*="/manga/"]').each((i, el) => {
              const link   = $(el).attr("href");
              const title  = $(el).find(".font-bold").text().trim();
              const rank   = $(el).find(".index-name").text().trim();
              const genres = [];
              $(el).find(".rounded-full span").each((_, g) => genres.push($(g).text().trim()));

              if (title && link) {
                results.push({
                  rank:   parseInt(rank) || i + 1,
                  title,
                  url:    link.startsWith("http") ? link : `https://02.ikiru.wtf${link}`,
                  genres,
                });
              }
            });

            if (results.length === 0) {
              await editInteractionResponse(payload.token, "⭐ No top series found.");
              return;
            }

            const list = results
              .slice(0, 10)
              .map((r) => {
                const medal     = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : `#${r.rank}`;
                const genreText = r.genres.length > 0 ? `*${r.genres.slice(0, 3).join(", ")}*` : "";
                return `${medal} **[${r.title}](${r.url})** ${genreText}`;
              })
              .join("\n");

            await editInteractionResponse(payload.token, `⭐ **Top Series:**\n\n${list}`);
          } catch (err) {
            await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
          }
        })());
        return;
      }
    }

    return res.status(400).json({ error: "Unknown interaction type" });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: err.message });
  }
}
