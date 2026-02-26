import dotenv from "dotenv";

dotenv.config();

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID    = process.env.DISCORD_APPLICATION_ID;

if (!BOT_TOKEN || !APP_ID) {
  console.error("❌ Please set DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID in .env");
  process.exit(1);
}

const commands = [
  {
    name:        "ping",
    description: "Cek status bot dan Redis",
  },
  {
    name:        "check",
    description: "Cek chapter baru sekarang tanpa nunggu cron",
  },
  {
    name:        "checksingle",
    description: "Cek chapter baru untuk 1 manga spesifik (respect cache)",
    options: [{
      name:        "title",
      description: "Manga title to check",
      type:        3,
      required:    true,
    }],
  },
  {
    name:        "forcescrape",
    description: "Force scrape 1 manga dan kirim notif (ignore cache)",
    options: [{
      name:        "title",
      description: "Manga title to force scrape",
      type:        3,
      required:    true,
    }],
  },
  {
    name:        "add",
    description: "Add manga to whitelist",
    options: [{
      name:        "title",
      description: "Manga title to add",
      type:        3,
      required:    true,
    }],
  },
  {
    name:        "remove",
    description: "Remove manga from whitelist",
    options: [{
      name:        "title",
      description: "Manga title to remove",
      type:        3,
      required:    true,
    }],
  },
  {
    name:        "list",
    description: "List all whitelisted manga (20 per halaman)",
    options: [{
      name:        "page",
      description: "Halaman ke berapa (default: 1)",
      type:        4, // INTEGER
      required:    false,
      min_value:   1,
    }],
  },
  {
    name:        "search",
    description: "Cari manga di whitelist berdasarkan keyword",
    options: [{
      name:        "keyword",
      description: "Keyword pencarian",
      type:        3,
      required:    true,
    }],
  },
  {
    name:        "clear",
    description: "Clear semua whitelist (owner only)",
  },
  {
    name:        "status",
    description: "Show bot status",
  },
  {
    name:        "info",
    description: "Search and get manga details dari ikiru.wtf",
    options: [{
      name:        "title",
      description: "Manga title to search",
      type:        3,
      required:    true,
    }],
  },
  {
    name:        "recent",
    description: "Show 5 latest chapters",
  },
  {
    name:        "setchannel",
    description: "Set notification channel untuk manga updates",
    options: [{
      name:         "channel",
      description:  "Channel to send notifications",
      type:         7,
      required:     true,
      channel_types: [0],
    }],
  },
  {
    name:        "getchannel",
    description: "Get current notification channel",
  },
  {
    name:        "popular",
    description: "Show popular manga",
    options: [{
      name:        "period",
      description: "Time period",
      type:        3,
      required:    false,
      choices: [
        { name: "Today",   value: "daily"   },
        { name: "Weekly",  value: "weekly"  },
        { name: "Monthly", value: "monthly" },
      ],
    }],
  },
  {
    name:        "topseries",
    description: "Show top series of all time",
  },
];

async function registerCommands() {
  try {
    console.log("📝 Registering Discord slash commands...\n");

    const response = await fetch(
      `https://discord.com/api/v10/applications/${APP_ID}/commands`,
      {
        method:  "PUT",
        headers: {
          "Authorization": `Bot ${BOT_TOKEN}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify(commands),
      }
    );

    if (response.ok) {
      const data = await response.json();
      console.log("✅ Commands registered successfully!");
      console.log(`\n📋 Registered ${data.length} commands:`);
      data.forEach((cmd) => {
        console.log(`  /${cmd.name} — ${cmd.description}`);
      });
    } else {
      const error = await response.text();
      console.error("❌ Failed to register commands:", error);
    }
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

registerCommands();
