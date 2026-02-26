import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.DISCORD_APPLICATION_ID;

if (!BOT_TOKEN || !APP_ID) {
  console.error("❌ Please set DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID in .env");
  process.exit(1);
}

const commands = [
  {
    name: "add",
    description: "Add manga to whitelist",
    options: [{
      name: "title",
      description: "Manga title to add",
      type: 3, // STRING
      required: true
    }]
  },
  {
    name: "remove",
    description: "Remove manga from whitelist",
    options: [{
      name: "title",
      description: "Manga title to remove",
      type: 3, // STRING
      required: true
    }]
  },
  {
    name: "list",
    description: "List all whitelisted manga",
  },
  {
    name: "status",
    description: "Show bot status",
  },
  {
    name: "search",
    description: "Search manga on ikiru.wtf",
    options: [{
      name: "query",
      description: "Search query",
      type: 3, // STRING
      required: true
    }]
  },
  {
    name: "info",
    description: "Get manga info",
    options: [{
      name: "title",
      description: "Manga title",
      type: 3, // STRING
      required: true
    }]
  },
  {
    name: "clear",
    description: "Clear all whitelist",
  },
  {
    name: "recent",
    description: "Show 5 latest chapters",
  },
  {
    name: "setchannel",
    description: "Set notification channel for manga updates",
    options: [{
      name: "channel",
      description: "Channel to send notifications",
      type: 7, // CHANNEL
      required: true,
      channel_types: [0] // Text channels only
    }]
  },
  {
    name: "getchannel",
    description: "Get current notification channel",
  }
];

async function registerCommands() {
  try {
    console.log("📝 Registering Discord slash commands...\n");
    
    const response = await fetch(
      `https://discord.com/api/v10/applications/${APP_ID}/commands`,
      {
        method: "PUT",
        headers: {
          "Authorization": `Bot ${BOT_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(commands)
      }
    );

    if (response.ok) {
      const data = await response.json();
      console.log("✅ Commands registered successfully!");
      console.log("\n📋 Registered commands:");
      data.forEach(cmd => {
        console.log(`  /${cmd.name} - ${cmd.description}`);
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
