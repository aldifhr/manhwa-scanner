import axios from "axios";
import dotenv from "dotenv";
import { 
  formatTimeAgo, 
  fetchDescription, 
  scrapeMangaUpdates, 
} from "./lib/scraper.js";
import { Redis } from "@upstash/redis";

dotenv.config();

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
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
  const sentences = description.split('. ');
  const short = sentences.slice(0, 2).join('. ');
  return short.endsWith('.') ? short : short + '.';
};

async function sendDiscordNotification(data) {
  const description = await fetchDescription(data.mangaUrl);
  const color = STATUS_COLORS[data.status] || STATUS_COLORS["Unknown"];
  const synopsis = shortSynopsis(description);

  const embeds = [
    // Embed 1: cover image + author bar
    {
      color,
      author: {
        name: "⚡  Chapter Baru Tersedia — ikiru.wtf",
        icon_url: "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png",
        url: "https://02.ikiru.wtf",
      },
      image: data.cover?.startsWith("http") ? { url: data.cover } : undefined,
    },
    // Embed 2: info utama
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

  await axios.post(WEBHOOK, { embeds });
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

  let sent = 0;
  let failed = 0;

  for (const [i, data] of results.entries()) {
    console.log(`\n   [${i + 1}/${results.length}] 📖 ${data.title}`);
    log.item(`Chapter : ${data.chapter}`);
    log.item(`Status  : ${data.status}`);
    log.item(`Rating  : ${data.rating || "N/A"}`);
    log.item(`Updated : ${data.updatedTime ? formatTimeAgo(data.updatedTime) : "Unknown"}`);
    log.item(`URL     : ${data.url}`);

    try {
      await sendDiscordNotification(data);
      log.success("Discord notification sent!");
      sent++;
    } catch (err) {
      log.error(`Failed to send: ${err.message}`);
      failed++;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.title("📊 SUMMARY");
  log.item(`Total scraped  : ${allResults.length} chapters`);
  log.item(`Whitelist match: ${results.length} chapters`);
  log.success(`Sent           : ${sent} notifications`);
  if (failed > 0) log.error(`Failed         : ${failed} notifications`);
  log.item(`Duration       : ${elapsed}s`);
  console.log("");
}

main().catch(err => {
  log.error(`FATAL: ${err.message}`);
  process.exit(1);
});