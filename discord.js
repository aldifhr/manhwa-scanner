import dotenv from "dotenv";

dotenv.config();

const MANAGE_GUILD_PERMISSION = "32";

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
    default_member_permissions: MANAGE_GUILD_PERMISSION,
  },
  {
    name:        "remove",
    description: "Remove manga from whitelist (by title or number)",
    default_member_permissions: MANAGE_GUILD_PERMISSION,
    options: [{
      name:        "query",
      description: "Manga title or number from /list",
      type:        3,
      required:    true,
    }],
  },
  {
    name: "list",
    description: "Lihat daftar manga di whitelist (search & filter available)",
    options: [
      {
        name: "page",
        description: "Halaman ke berapa (default: 1)",
        type: 4,
        required: false,
        min_value: 1,
      },
      {
        name: "search",
        description: "Cari judul manga (misal: Lookism)",
        type: 3,
        required: false,
      },
      {
        name: "status",
        description: "Filter berdasarkan status manga",
        type: 3,
        required: false,
        choices: [
          { name: "Hiatus", value: "hiatus" },
          { name: "End Season", value: "end_season" },
          { name: "End", value: "end" },
        ],
      },
    ],
  },
  {
    name: "myprogress",
    description: "Lihat history baca / progress manga kamu",
  },
  {
    name:        "mark",
    description: "Kasih mark status ke manga di whitelist",
    default_member_permissions: MANAGE_GUILD_PERMISSION,
    options: [{
      name:        "query",
      description: "Judul manga atau nomor dari /list",
      type:        3,
      required:    true,
    }, {
      name:        "reason",
      description: "Status mark yang mau dipasang",
      type:        3,
      required:    true,
      choices: [
        { name: "Hiatus", value: "hiatus" },
        { name: "End Season", value: "end_season" },
        { name: "End", value: "end" },
        { name: "Clear", value: "clear" },
      ],
    }],
  },
  {
    name:        "clear",
    description: "Clear semua whitelist (owner only)",
    default_member_permissions: "0",
  },
  {
    name:        "status",
    description: "Show bot status dan notification channel",
    default_member_permissions: MANAGE_GUILD_PERMISSION,
  },
  {
    name:        "setchannel",
    description: "Set notification channel untuk manga updates",
    default_member_permissions: MANAGE_GUILD_PERMISSION,
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
      name: "title",
      description: "Judul manga untuk dicari (isi salah satu: title atau url)",
      type: 3,
      required: false,
      autocomplete: true,
    },
    {
      name: "url",
      description: "URL langsung halaman series (Ikiru / Shinigami) — lebih akurat dari pencarian",
      type: 3,
      required: false,
    },
  ],
},
{
  name: "resync24h",
  description: "Scan ulang update <24 jam dan kirim yang kelewat (owner only)",
  default_member_permissions: "0",
  options: [
    {
      name: "dry_run",
      description: "Hanya simulasi hitung, tanpa kirim notifikasi",
      type: 5,
      required: false,
    },
    {
      name: "max_send",
      description: "Batas maksimal chapter yang dikirim (default: 30)",
      type: 4,
      required: false,
      min_value: 1,
      max_value: 200,
    },
  ],
},
  {
    name: "health",
    description: "Lihat kesehatan & statistik bot",
    default_member_permissions: MANAGE_GUILD_PERMISSION,
  },
  {
    name: "permission",
    description: "Kelola akses /add untuk user tertentu (owner only)",
    default_member_permissions: "0",
    options: [
      {
        name: "add",
        description: "Berikan akses /add ke seorang user",
        type: 1,
        options: [{
          name: "user_id",
          description: "Discord User ID yang ingin diberi akses",
          type: 3,
          required: true,
        }],
      },
      {
        name: "remove",
        description: "Cabut akses /add dari seorang user",
        type: 1,
        options: [{
          name: "user_id",
          description: "Discord User ID yang ingin dicabut aksesnya",
          type: 3,
          required: true,
        }],
      },
      {
        name: "list",
        description: "Lihat semua user yang punya akses /add dinamis",
        type: 1,
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
