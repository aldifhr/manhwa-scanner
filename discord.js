import dotenv from "dotenv";

dotenv.config();

if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_APPLICATION_ID) {
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
    name:        "remove",
    description: "Remove manga from whitelist (by title or number)",
    options: [{
      name:        "query",
      description: "Manga title or number from /list",
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
      type:        4,
      required:    false,
      min_value:   1,
    }],
  },
  {
    name:        "clear",
    description: "Clear semua whitelist (owner only)",
  },
  {
    name:        "status",
    description: "Show bot status dan notification channel",
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
  name: "add",
  description: "Tambah manga ke whitelist",
  options: [
    {
      name: "source",
      description: "Pilih source manga",
      type: 3,
      required: true,
      choices: [
        { name: "Ikiru", value: "ikiru" },
        { name: "Shinigami", value: "shinigami_project" },
      ],
    },
    {
      name: "title",
      description: "Manga title to add",
      type: 3,
      required: true,
    },
  ],
},
];

async function registerCommands() {
  try {
    console.log("📝 Registering Discord slash commands...\n");

    const response = await fetch(
      `https://discord.com/api/v10/applications/${process.env.DISCORD_APPLICATION_ID}/commands`,
      {
        method:  "PUT",
        headers: {
          "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`,
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
