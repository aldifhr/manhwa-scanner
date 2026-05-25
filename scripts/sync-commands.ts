import axios from "axios";
import "dotenv/config";

const {
  DISCORD_TOKEN,
  DISCORD_BOT_TOKEN,
  DISCORD_APP_ID,
  DISCORD_APPLICATION_ID,
} = process.env;

const token = DISCORD_BOT_TOKEN || DISCORD_TOKEN;
const appId = DISCORD_APPLICATION_ID || DISCORD_APP_ID;

if (!token || !appId) {
  console.error(
    "Error: DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID are required in .env",
  );
  process.exit(1);
}

const url = `https://discord.com/api/v10/applications/${appId}/commands`;

const commands = [
  {
    name: "status",
    description: "Lihat status whitelist saat ini",
  },
  {
    name: "add",
    description: "Tambah manga ke whitelist",
    options: [
      {
        type: 1, // SUB_COMMAND
        name: "url",
        description: "Tambah manga dari URL (auto-detect source: Ikiru/Shinigami)",
        options: [
          {
            type: 3, // STRING
            name: "link",
            description: "Paste URL manga (contoh: https://ikiru.wtf/manga/xxx atau https://e.shinigami.asia/series/xxx)",
            required: true,
          },
        ],
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
    name: "setchannel",
    description: "Set channel untuk notifikasi manga",
    options: [
      {
        type: 7, // CHANNEL
        name: "channel",
        description: "Pilih channel untuk notifikasi",
        required: true,
        channel_types: [0], // 0 = text channel only
      },
    ],
  },
  {
    name: "follow",
    description: "Lihat atau kelola manga yang kamu ikuti untuk notifikasi",
    options: [
      {
        type: 1, // SUB_COMMAND
        name: "list",
        description: "Lihat daftar manga yang kamu ikuti",
        options: [
          {
            type: 4, // INTEGER
            name: "page",
            description: "Halaman ke-berapa",
            required: false,
          },
        ],
      },
      {
        type: 1, // SUB_COMMAND
        name: "unfollow",
        description: "Berhenti mengikuti update manga",
        options: [
          {
            type: 3, // STRING
            name: "title",
            description: "Judul manga yang ingin di-unfollow",
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: "sync",
    description: "Sync manual untuk cek chapter baru (admin only)",
  },
  {
    name: "list",
    description: "Lihat daftar seluruh manga di whitelist",
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
        description: "Cari manga di whitelist",
        required: false,
      },
    ],
  },
  {
    name: "permission",
    description: "Kelola izin /add manga",
    options: [
      {
        type: 1, // SUB_COMMAND
        name: "add",
        description: "Beri izin ke user untuk menambah manga",
        options: [
          {
            type: 6, // USER
            name: "user",
            description: "Pilih user yang ingin diberi izin",
            required: true,
          },
        ],
      },
      {
        type: 1, // SUB_COMMAND
        name: "remove",
        description: "Hapus izin user untuk menambah manga",
        options: [
          {
            type: 6, // USER
            name: "user",
            description: "Pilih user yang ingin dihapus izinnya",
            required: true,
          },
        ],
      },
      {
        type: 1, // SUB_COMMAND
        name: "list",
        description: "Lihat daftar user yang diizinkan /add",
      },
    ],
  },
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
    console.log("✅ Successfully synced commands!");
    console.log(response.data.map((c: any) => `/${c.name}`).join(", "));
  } catch (err: any) {
    console.error("❌ Sync failed:", err.response?.data || err.message);
  }
}

sync();
