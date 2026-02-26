import axios from "axios";
import dotenv from "dotenv";
import { 
  loadWhitelist, 
  formatTimeAgo, 
  getStatusColor, 
  fetchDescription, 
  scrapeMangaUpdates, 
  STATUS_EMOJI
} from "./lib/scraper.js";

dotenv.config();

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

async function sendDiscordNotification(data) {
  const fields = [
    { 
      name: "⭐ Rating", 
      value: data.rating ? `**${data.rating}** / 10` : "No rating", 
      inline: true 
    },
    { 
      name: "📊 Status", 
      value: `${STATUS_EMOJI[data.status] || "⚪"} ${data.status}`, 
      inline: true 
    }
  ];
  
  if (data.updatedTime) {
    fields.push({ 
      name: "🕐 Updated", 
      value: formatTimeAgo(data.updatedTime), 
      inline: true 
    });
  }

  const description = await fetchDescription(data.mangaUrl);
  let descriptionText = `**${data.chapter}**`;
  if (description) {
    descriptionText += `\n\n📄 **Synopsis:**\n${description}`;
  }
  descriptionText += `\n\n[Read Chapter](${data.url})`;

  const payload = {
    embeds: [{
      title: `📖 ${data.title}`,
      description: descriptionText,
      url: data.url,
      color: getStatusColor(data.status),
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: `🆕 Latest Release • ikiru.wtf`,
        icon_url: "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png"
      },
      thumbnail: data.cover?.startsWith("http") ? { url: data.cover } : undefined
    }],
  };

  await axios.post(WEBHOOK, payload);
}

async function main() {
  try {
    const whitelist = loadWhitelist();
    console.log(`📋 Loaded ${whitelist.length} manga from whitelist\n`);
    
    console.log("🌐 Fetching from https://02.ikiru.wtf/ ...");
    const results = await scrapeMangaUpdates();
    console.log(`✅ Found ${results.length} fresh chapters\n`);

    if (results.length === 0) {
      console.log("ℹ️ No new chapters today. Exiting.");
      return;
    }

    for (const data of results) {
      console.log(`📝 Sending: ${data.title} - ${data.chapter}`);
      
      // Send to Discord
      await sendDiscordNotification(data);
      console.log("✅ Discord sent!\n");
    }
    
    console.log("🎉 All notifications sent!");
  } catch (err) {
    console.error("❌ ERROR:", err.message);
    process.exit(1);
  }
}

main();
