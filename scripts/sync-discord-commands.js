#!/usr/bin/env node
/**
 * Discord Command Sync Script
 * Registers all slash commands with Discord API
 *
 * Usage: node scripts/sync-discord-commands.js
 */

import dotenv from "dotenv";
dotenv.config();

const APP_ID = process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!APP_ID || !BOT_TOKEN) {
  console.error(
    "❌ Error: DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN must be set",
  );
  process.exit(1);
}

const commands = [
  {
    name: "list",
    description: "📚 Lihat daftar manga yang ada di whitelist",
    type: 1,
    options: [
      {
        name: "page",
        description: "Nomor halaman (default: 1)",
        type: 4, // INTEGER
        required: false,
      },
      {
        name: "search",
        description: "Cari manga berdasarkan judul",
        type: 3, // STRING
        required: false,
      },
      {
        name: "filter",
        description: "Filter berdasarkan status (ongoing/completed/hiatus)",
        type: 3, // STRING
        required: false,
        choices: [
          { name: "Ongoing", value: "ongoing" },
          { name: "Completed", value: "completed" },
          { name: "Hiatus", value: "hiatus" },
        ],
      },
    ],
  },
  {
    name: "search",
    description: "🔍 Cari manga di whitelist (alias dari /list)",
    type: 1,
    options: [
      {
        name: "query",
        description: "Kata kunci pencarian",
        type: 3, // STRING
        required: true,
      },
      {
        name: "page",
        description: "Nomor halaman",
        type: 4, // INTEGER
        required: false,
      },
    ],
  },
  {
    name: "add",
    description: "➕ Tambah manga baru ke whitelist (khusus admin)",
    type: 1,
    options: [
      {
        name: "title",
        description: "Judul manga yang ingin ditambahkan",
        type: 3, // STRING
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "remove",
    description: "➖ Hapus manga dari whitelist (khusus admin)",
    type: 1,
    options: [
      {
        name: "query",
        description: "Judul, nomor urut, atau ketik 'all' untuk hapus semua",
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: "follow",
    description: "🔔 Kelola notifikasi manga yang di-follow",
    type: 1,
    options: [
      {
        name: "list",
        description: "📋 Lihat daftar manga yang di-follow",
        type: 1, // SUB_COMMAND
      },
      {
        name: "unfollow",
        description: "❌ Berhenti follow manga",
        type: 1, // SUB_COMMAND
        options: [
          {
            name: "title",
            description: "Judul manga yang ingin di-unfollow",
            type: 3, // STRING
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: "myprogress",
    description: "📖 Lihat dan kelola progress baca manga",
    type: 1,
    options: [
      {
        name: "list",
        description: "📋 Lihat daftar progress baca",
        type: 1, // SUB_COMMAND
        options: [
          {
            name: "page",
            description: "Nomor halaman",
            type: 4, // INTEGER
            required: false,
          },
        ],
      },
      {
        name: "clear",
        description: "🗑️ Hapus manga dari progress",
        type: 1, // SUB_COMMAND
        options: [
          {
            name: "judul",
            description: "Judul manga yang ingin dihapus dari progress",
            type: 3, // STRING
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: "status",
    description: "📊 Lihat status bot dan statistik",
    type: 1,
  },
  {
    name: "sync",
    description: "🔄 Sinkronisasi manual whitelist (khusus admin)",
    type: 1,
  },
  {
    name: "setchannel",
    description: "📢 Set channel untuk notifikasi chapter baru (khusus admin)",
    type: 1,
    options: [
      {
        name: "channel",
        description: "Mention channel (#nama-channel)",
        type: 7, // CHANNEL
        required: true,
        channel_types: [0, 5], // GUILD_TEXT, GUILD_NEWS
      },
    ],
  },
  {
    name: "mark",
    description: "🏷️ Tandai manga dengan status khusus (khusus admin)",
    type: 1,
    options: [
      {
        name: "query",
        description: "Judul manga atau nomor urut",
        type: 3, // STRING
        required: true,
      },
      {
        name: "reason",
        description: "Pilih status baru",
        type: 3, // STRING
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
    name: "pref",
    description: "⚙️ Atur preferensi notifikasi",
    type: 1,
    options: [
      {
        name: "mode",
        description: "Pilih mode notifikasi",
        type: 3, // STRING
        required: false,
        choices: [
          { name: "All - Dapat notif semua manga", value: "all" },
          { name: "Follows - Hanya manga yang di-follow", value: "follows" },
          { name: "None - Tidak ada notifikasi", value: "none" },
        ],
      },
    ],
  },
  {
    name: "health",
    description: "🏥 Cek kesehatan sistem bot (khusus admin)",
    type: 1,
  },
  {
    name: "permission",
    description: "🔒 Kelola permission admin (khusus owner)",
    type: 1,
    options: [
      {
        name: "user",
        description: "User yang ingin diberi/revoke akses admin",
        type: 6, // USER
        required: true,
      },
      {
        name: "action",
        description: "Tambah atau hapus permission",
        type: 3, // STRING
        required: true,
        choices: [
          { name: "Grant Admin", value: "grant" },
          { name: "Revoke Admin", value: "revoke" },
        ],
      },
    ],
  },
  {
    name: "clear",
    description: "🗑️ Hapus seluruh whitelist (⚠️ DANGER - khusus owner)",
    type: 1,
  },
  {
    name: "check",
    description: "🔍 Cek chapter terbaru dari whitelist (Quick Sync)",
    type: 1,
  },
  {
    name: "resync24h",
    description: "🔄 Sync ulang chapter 24 jam terakhir (Deep Sync)",
    type: 1,
    options: [
      {
        name: "max_send",
        description: "Maksimal chapter yang dikirim (default 100)",
        type: 4, // INTEGER
        required: false,
      },
    ],
  },
];

async function registerCommands() {
  const url = `https://discord.com/api/v10/applications/${APP_ID}/commands`;

  console.log("🔄 Syncing commands to Discord...");
  console.log(`📱 App ID: ${APP_ID}`);
  console.log(`📋 Total commands: ${commands.length}`);
  console.log("");

  try {
    // Use bulk PUT to replace all commands at once (avoids rate limiting)
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });

    if (response.ok) {
      const data = await response.json();
      console.log(`✅ Successfully registered ${data.length} commands`);
      for (const cmd of data) {
        console.log(`   • ${cmd.name}: ${cmd.description.substring(0, 40)}...`);
      }
    } else {
      const error = await response.text();
      console.error("❌ Failed to register commands");
      console.error(`   Status: ${response.status}`);
      console.error(`   Error: ${error}`);
      return;
    }
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    return;
  }

  console.log("");
  console.log("🎉 Command sync complete!");
  console.log(
    "⚠️  Note: Commands may take up to 1 hour to appear in all guilds",
  );
  console.log("🔄 For immediate testing, use the guild-specific sync option");
}

async function deleteAllCommands() {
  const url = `https://discord.com/api/v10/applications/${APP_ID}/commands`;

  console.log("🗑️  Fetching existing commands...");

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
      },
    });

    if (!response.ok) {
      console.error(`❌ Failed to fetch commands: ${response.status}`);
      return;
    }

    const existingCommands = await response.json();
    console.log(`📋 Found ${existingCommands.length} existing commands`);

    for (const cmd of existingCommands) {
      const deleteUrl = `${url}/${cmd.id}`;
      const deleteResponse = await fetch(deleteUrl, {
        method: "DELETE",
        headers: {
          Authorization: `Bot ${BOT_TOKEN}`,
        },
      });

      if (deleteResponse.ok) {
        console.log(`🗑️  Deleted: ${cmd.name}`);
      } else {
        console.error(
          `❌ Failed to delete ${cmd.name}: ${deleteResponse.status}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    console.log("✅ All commands deleted");
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
  }
}

// Handle command line arguments
const args = process.argv.slice(2);

if (args.includes("--delete") || args.includes("-d")) {
  deleteAllCommands().then(() => registerCommands());
} else if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Discord Command Sync Script

Usage:
  node scripts/sync-discord-commands.js [options]

Options:
  --delete, -d    Delete all commands first, then re-register
  --help, -h      Show this help message

Environment Variables:
  DISCORD_APPLICATION_ID    Discord Application ID (required)
  DISCORD_BOT_TOKEN         Discord Bot Token (required)
  `);
} else {
  registerCommands();
}
