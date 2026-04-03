import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const { 
  DISCORD_TOKEN, 
  DISCORD_BOT_TOKEN, 
  DISCORD_APP_ID, 
  DISCORD_APPLICATION_ID 
} = process.env;

const token = DISCORD_BOT_TOKEN || DISCORD_TOKEN;
const appId = DISCORD_APPLICATION_ID || DISCORD_APP_ID;

if (!token || !appId) {
  console.error("Error: DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID are required in .env");
  process.exit(1);
}

const url = `https://discord.com/api/v10/applications/${appId}/commands`;

const commands = [
  {
    name: "ping",
    description: "Cek apakah bot sedang aktif",
  },
  {
    name: "status",
    description: "Lihat status whitelist saat ini",
    options: [
      {
        type: 4, // INTEGER
        name: "page",
        description: "Halaman ke-berapa",
        required: false,
      },
      {
        type: 3, // STRING
        name: "search",
        description: "Cari judul tertentu",
        required: false,
      },
      {
        type: 3, // STRING
        name: "filter",
        description: "Filter berdasarkan status (hiatus, end_season, end)",
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
    name: "add",
    description: "Tambah manga ke whitelist",
    options: [
      {
        type: 3, // STRING
        name: "query",
        description: "Judul manga atau URL (Ikiru/Shinigami)",
        required: true,
      },
    ],
  },
  {
    name: "remove",
    description: "Hapus manga dari whitelist",
    options: [
      {
        type: 3, // STRING
        name: "query",
        description: "Judul, URL, atau nomor urut di whitelist",
        required: true,
      },
    ],
  },
  {
    name: "search",
    description: "Cari manga di whitelist",
    options: [
      {
        type: 3, // STRING
        name: "query",
        description: "Judul atau URL",
        required: true,
      },
    ],
  },
  {
    name: "mark",
    description: "Tandai status manga (Hiatus/End)",
    options: [
      {
        type: 3, // STRING
        name: "item",
        description: "Judul manga atau nomor urut",
        required: true,
      },
      {
        type: 3, // STRING
        name: "reason",
        description: "Status baru",
        required: true,
        choices: [
          { name: "Hiatus", value: "hiatus" },
          { name: "End Season", value: "end_season" },
          { name: "End", value: "end" },
          { name: "Selesai/Clear", value: "clear" },
        ],
      },
    ],
  },
  {
    name: "check",
    description: "Cek chapter terbaru dari whitelist secara manual",
  },
  {
    name: "setchannel",
    description: "Set channel ini sebagai tempat notifikasi",
  },
  {
    name: "clear",
    description: "Hapus semua isi whitelist (Owner only)",
  },
  {
    name: "resync24h",
    description: "Sync ulang chapter yang rilis dalam 24 jam terakhir",
    options: [
      {
        type: 4, // INTEGER
        name: "max_send",
        description: "Maksimal chapter yang dikirim (default 100)",
        required: false,
      },
      {
        type: 5, // BOOLEAN
        name: "dry_run",
        description: "Cek jumlah yang akan dikirim tanpa benar-benar mengirim",
        required: false,
      },
    ],
  },
  {
    name: "health",
    description: "Cek status kesehatan scraper/situs sumber",
  },
  {
    name: "myprogress",
    description: "Lihat history chapter yang sudah kamu baca/notifikasi",
  },
  {
    name: "readclear",
    description: "Hapus history progress pribadimu",
  },
  {
    name: "permission",
    description: "Kelola izin akses command /add (Admin only)",
    options: [
      {
        type: 3,
        name: "action",
        description: "Tambah atau hapus izin",
        required: true,
        choices: [
          { name: "Add User", value: "add" },
          { name: "Remove User", value: "remove" },
          { name: "List Allowed", value: "list" }
        ]
      },
      {
        type: 6, // USER
        name: "user",
        description: "User yang ingin dikelola",
        required: false
      }
    ]
  },
  {
    name: "pref",
    description: "Atur preferensi notifikasi (ping/tag)",
    options: [
      {
        type: 1, // SUB_COMMAND
        name: "ping",
        description: "Pengaturan notifikasi tag",
        options: [
          {
            type: 3, // STRING
            name: "mode",
            description: "Pilih mode notifikasi",
            required: false,
            choices: [
              { name: "🔔 Semua Update (Tag All)", value: "all" },
              { name: "⭐ Hanya Follow (Tag Follows)", value: "follows" },
              { name: "🔕 Nonaktif (No Tag)", value: "none" }
            ]
          }
        ]
      }
    ]
  }
];

async function sync() {
  try {
    console.log(`🚀 Starting sync of ${commands.length} commands...`);
    const response = await axios.put(url, commands, {
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
    });
    console.log("Γ£ö Successfully synced commands!");
    console.log(response.data.map(c => `/${c.name}`).join(", "));
  } catch (err) {
    console.error("Γ£û Sync failed:", err.response?.data || err.message);
  }
}

sync();
