import dotenv from "dotenv";

dotenv.config();

const MANAGE_GUILD_PERMISSION = "32"; // Manage Guild

if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_APPLICATION_ID) {
  console.error("❌ Please set DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID in .env");
  process.exit(1);
}

const commands = [
  {
    name: "status",
    description: "Dashboard status: Laporan kesehatan, statistik, dan manajemen izin",
    default_member_permissions: MANAGE_GUILD_PERMISSION,
    options: [
      {
        name: "report",
        description: "Tampilkan laporan status bot lengkap",
        type: 1,
      },
      {
        name: "perm_add",
        description: "Berikan izin akses /add ke user tertentu (Owner Only)",
        type: 1,
        options: [
          {
            name: "user_id",
            description: "ID User yang ingin diberikan akses",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "perm_remove",
        description: "Cabut izin akses /add dari user tertentu (Owner Only)",
        type: 1,
        options: [
          {
            name: "user_id",
            description: "ID User yang ingin dicabut aksesnya",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "perm_list",
        description: "Lihat daftar user yang memiliki akses khusus /add",
        type: 1,
      },
    ],
  },
  {
    name: "sync",
    description: "Sinkronisasi manual whitelist dengan sumber manga",
    default_member_permissions: MANAGE_GUILD_PERMISSION,
    options: [
      {
        name: "mode",
        description: "Pilih mode sinkronisasi (Quick: cek rilis baru, Deep: resync metadata)",
        type: 3,
        required: true,
        choices: [
          { name: "Quick Check", value: "quick" },
          { name: "Deep Resync (Owner Only)", value: "deep" },
        ],
      },
      {
        name: "dry_run",
        description: "Simulasi sinkronisasi tanpa mengirim notifikasi (hanya mode Deep)",
        type: 5,
        required: false,
      },
      {
        name: "max_send",
        description: "Batas maksimal chapter yang dikirim (hanya mode Deep, default: 30)",
        type: 4,
        required: false,
        min_value: 1,
        max_value: 200,
      },
    ],
  },
  {
    name: "add",
    description: "Tambah manga ke whitelist",
    options: [
      {
        name: "title",
        description: "Judul manga untuk dicari",
        type: 3,
        required: false,
        autocomplete: true,
      },
      {
        name: "url",
        description: "URL langsung halaman series (Ikiru/Shinigami)",
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: "remove",
    description: "Hapus manga dari whitelist",
    default_member_permissions: MANAGE_GUILD_PERMISSION,
    options: [
      {
        name: "query",
        description: "Judul, nomor manga, atau ketik 'all' untuk hapus semua (Owner Only)",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "list",
    description: "Lihat daftar manga di whitelist",
    options: [
      {
        name: "page",
        description: "Halaman (default: 1)",
        type: 4,
        required: false,
        min_value: 1,
      },
      {
        name: "search",
        description: "Cari judul manga tertentu",
        type: 3,
        required: false,
      },
      {
        name: "status",
        description: "Filter berdasarkan status",
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
    description: "Lihat atau kelola history baca manga kamu",
    options: [
      {
        name: "list",
        description: "Tampilkan progres baca kamu",
        type: 1,
        options: [
          {
            name: "page",
            description: "Halaman progres",
            type: 4,
            required: false,
            min_value: 1,
          },
        ],
      },
      {
        name: "clear",
        description: "Hapus judul tertentu dari riwayat progres baca kamu",
        type: 1,
        options: [
          {
            name: "judul",
            description: "Judul manga yang ingin dihapus dari progres",
            type: 3,
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: "mark",
    description: "Pasang penanda status pada manga di whitelist",
    default_member_permissions: MANAGE_GUILD_PERMISSION,
    options: [
      {
        name: "query",
        description: "Judul manga atau nomor urut",
        type: 3,
        required: true,
      },
      {
        name: "reason",
        description: "Pilih status baru",
        type: 3,
        required: true,
        choices: [
          { name: "Hiatus", value: "hiatus" },
          { name: "End Season", value: "end_season" },
          { name: "End", value: "end" },
          { name: "Clear Status", value: "clear" },
        ],
      },
    ],
  },
  {
    name: "setchannel",
    description: "Set channel notifikasi manga updates",
    default_member_permissions: MANAGE_GUILD_PERMISSION,
    options: [
      {
        name: "channel",
        description: "Channel tujuan notifikasi",
        type: 7,
        required: true,
        channel_types: [0],
      },
    ],
  },
  {
    name: "random",
    description: "Dapatkan rekomendasi manhwa/manhua acak",
  },
  {
    name: "check",
    description: "Cek chapter terbaru dari whitelist secara manual (Quick Sync)",
  },
  {
    name: "health",
    description: "Cek status kesehatan scraper/situs sumber",
  },
  {
    name: "resync24h",
    description: "Sync ulang chapter yang rilis dalam 24 jam terakhir (Deep Sync)",
    default_member_permissions: MANAGE_GUILD_PERMISSION,
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
    name: "search",
    description: "Cari manga di whitelist",
    options: [
      {
        type: 3, // STRING
        name: "query",
        description: "Judul atau URL manga",
        required: true,
      },
    ],
  },
  {
    name: "pref",
    description: "Atur preferensi notifikasi kamu",
    options: [
      {
        name: "ping",
        description: "Atur mode mention (ping) untuk update manga",
        type: 1,
        options: [
          {
            name: "mode",
            description: "Pilih mode notifikasi",
            type: 3,
            required: false,
            choices: [
              { name: "Semua Update (Default)", value: "all" },
              { name: "Hanya Followed Manga", value: "follows" },
              { name: "Mati (Tidak ada ping)", value: "none" },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "clear",
    description: "Hapus seluruh isi whitelist (Owner Only)",
    default_member_permissions: MANAGE_GUILD_PERMISSION,
  },
];

async function registerCommands() {
  try {
    console.log("📝 Updating consolidated Discord slash commands...\n");

    const response = await fetch(
      `https://discord.com/api/v10/applications/${process.env.DISCORD_APPLICATION_ID}/commands`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(commands),
      }
    );

    if (response.ok) {
      const data = await response.json();
      console.log("✅ Commands updated successfully!");
      console.log(`\n📋 Final Consolidated Commands (${data.length}):`);
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
