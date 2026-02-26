import axios from "axios";
import dotenv from "dotenv";
import {
  formatTimeAgo,
  fetchDescription,
  scrapeMangaUpdates,
} from "./lib/scraper.js";
import { Redis } from "@upstash/redis";

dotenv.config();

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const log = {
  info:    (msg) => console.log(`\x1b[36mℹ️  ${msg}\x1b[0m`),
  success: (msg) => console.log(`\x1b[32m✅ ${msg}\x1b[0m`),
  warn:    (msg) => console.log(`\x1b[33m⚠️  ${msg}\x1b[0m`),
  error:   (msg) => console.log(`\x1b[31m❌ ${msg}\x1b[0m`),
  title:   (msg) => console.log(`\x1b[35m\n${"─".repeat(50)}\n   ${msg}\n${"─".repeat(50)}\x1b[0m`),
  item:    (msg) => console.log(`\x1b[37m   ${msg}\x1b[0m`),
};

const statusBar = {
  "Ongoing":   "🟢 Ongoing",
  "Completed": "🔵 Completed",
  "Hiatus":    "🟡 Hiatus",
  "Unknown":   "⚪ Unknown",
};

const STATUS_COLORS = {
  "Ongoing":   0x22c55e,
  "Completed": 0x3b82f6,
  "Hiatus":    0xf59e0b,
  "Unknown":   0x6b7280,
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

async function sendDiscordNotification(data) {
  const description = await fetchDescription(data.mangaUrl);
  const color = STATUS_COLORS[data.status] || STATUS_COLORS["Unknown"];
  const synopsis = shortSynopsis(description);

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

  const keys = await redis.keys("channel:*");
  if (keys.length === 0) {
    log.warn("Tidak ada channel terdaftar di Redis!");
    return;
  }

  for (const key of keys) {
    const channelId = await redis.get(key);
    log.item(`Sending to channel ${channelId}...`);
    await axios.post(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      { embeds },
      {
        headers: {
          "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  }
}

async function main() {
  const startTime = Date.now();

  log.title("🤖 IKIRU MANGA BOT — TEST RUN");
  console.log(`   📅 ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB\n`);

  log.info("Connecting to Redis...");
  const whitelist = await redis.get("whitelist:manga") || [];

  if (whitelist.length === 0) {
    log.warn("Whitelist is EMPTY — semua manga akan dikirim!");
  } else {
    log.success(`Whitelist loaded: ${whitelist.length} manga`);
    whitelist.forEach((title, i) => log.item(`${i + 1}. ${title}`));
  }

  console.log("");
  log.info("Scraping https://02.ikiru.wtf/ ...");
  const allResults = await scrapeMangaUpdates();
  log.success(`Scraped ${allResults.length} fresh chapters (last 24h)`);

  let results = allResults;
  if (whitelist.length > 0) {
    results = allResults.filter(item =>
      whitelist.some(title =>
        item.title.toLowerCase().includes(title.toLowerCase()) ||
        title.toLowerCase().includes(item.title.toLowerCase())
      )
    );
    log.info(`After whitelist filter: ${results.length} / ${allResults.length} chapters match`);
  }

  if (results.length === 0) {
    console.log("");
    log.warn("Tidak ada chapter baru yang cocok dengan whitelist.");
    log.item("Cek apakah judul di whitelist sudah sesuai dengan judul di website.");
    console.log("");
    return;
  }

  log.title(`📨 SENDING ${results.length} NOTIFICATION(S)`);

  let sentCount = 0;

  // ✅ FIX: gunakan `results`, bukan `matched` (matched tidak ada di main)
  for (const item of results) {
    const key = `chapter:${item.url}`;
    log.item(`${item.title} - ${item.chapter}`);

    try {
      log.info(`Sending notification for "${item.title}"...`);
      await sendDiscordNotification(item);
      await redis.set(key, "sent");
      log.success(`Sent: ${item.title}`);
      sentCount++;
    } catch (err) {
      log.error(`Failed: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.title("📊 SUMMARY");
  log.item(`Matched  : ${results.length} chapters`);
  log.success(`Sent     : ${sentCount} notifications`);
  log.item(`Duration : ${elapsed}s`);
}

async function testAdd(title) {
  const startTime = Date.now();

  log.title(`🧪 TEST /add "${title}"`);

  log.info("Loading whitelist from Redis...");
  const whitelist = await redis.get("whitelist:manga") || [];

  if (whitelist.some(t => t.toLowerCase() === title.toLowerCase())) {
    log.warn(`"${title}" sudah ada di whitelist!`);
  } else {
    whitelist.push(title);
    await redis.set("whitelist:manga", whitelist);
    log.success(`"${title}" ditambahkan ke whitelist!`);
  }

  log.info("Clearing cache...");
  await redis.del("cache:updates");

  log.info("Scraping manga updates...");
  const allResults = await scrapeMangaUpdates(redis);
  log.success(`Scraped ${allResults.length} items (last 24h)`);

  log.title("🔍 RAW RESULTS");
  allResults.forEach((item, i) => {
    log.item(`${i + 1}. ${item.title} | ${item.chapter} | ${item.updatedTime}`);
  });

  const matched = allResults.filter(item =>
    item.title.toLowerCase().includes(title.toLowerCase()) ||
    title.toLowerCase().includes(item.title.toLowerCase())
  );
  log.info(`\nMatched ${matched.length} items untuk "${title}"`);

  if (matched.length === 0) {
    log.warn("Tidak ada chapter baru saat ini. Notifikasi otomatis saat chapter baru rilis!");
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log.item(`Duration: ${elapsed}s`);
    return;
  }

  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0; // ✅ FIX: deklarasikan variabel failed

  for (const item of matched) {
    const key = `chapter:${item.url}`;
    const exists = await redis.get(key);
    log.item(`${item.title} - ${item.chapter} | exists: ${!!exists}`);

    if (!exists) {
      try {
        log.info(`Sending notification for "${item.title}"...`);
        await sendDiscordNotification(item);
        await redis.set(key, "sent");
        log.success(`Sent: ${item.title}`);
        sentCount++;
      } catch (err) {
        log.error(`Failed: ${err.message}`);
        failedCount++; // ✅ FIX
      }
    } else {
      log.warn(`Skipped (already sent): ${item.title}`);
      skippedCount++;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.title("📊 SUMMARY");
  log.item(`Matched  : ${matched.length} chapters`);
  log.success(`Sent     : ${sentCount} notifications`);
  if (skippedCount > 0) log.warn(`Skipped  : ${skippedCount} (already sent)`);
  if (failedCount > 0) log.error(`Failed   : ${failedCount} items`);
  log.item(`Duration : ${elapsed}s`);
}

// Entry point
const args = process.argv.slice(2);
if (args.length > 0) {
  testAdd(args[0]).catch(err => {
    log.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
} else {
  main().catch(err => {
    log.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
