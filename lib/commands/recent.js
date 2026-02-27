import { waitUntil } from "@vercel/functions";
import { editInteractionResponse } from "../discord.js";
import axios from "axios";
import * as cheerio from "cheerio";

const SITE_URL = "https://02.ikiru.wtf/";

export default async function handleRecent(payload, options, res) {
  res.json({ type: 5 });
  
  waitUntil((async () => {
    try {
      console.log("🔍 Scraping", SITE_URL);
      const { data } = await axios.get(SITE_URL, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        timeout: 10000,
      });
      
      const $ = cheerio.load(data);
      const results = [];
      
      // ✅ #latest-list → Real HTML structure [file:396]
      $('#latest-list a').each((i, el) => {
        const $a = $(el);
        const $time = $a.find('time[datetime]');
        const $chapterP = $a.find('p:contains("Chapter")');
        
        if (!$time.length || !$chapterP.length) return;
        
        const updatedTime = $time.attr('datetime');
        const chapterText = $chapterP.text().trim();
        const $titleEl = $a.siblings('h1,h3').first().addBack().filter('h1,h3').first();
        const title = $titleEl.text().trim();
        
        // Debug log
        console.log(`Found: ${title} | ${chapterText} | ${updatedTime}`);
        
        if (!title || !chapterText.includes('Chapter')) return;
        
        const updateDate = new Date(updatedTime);
        const now = new Date();
        const diffMs = now - updateDate;
        const diffHours = diffMs / (1000 * 60 * 60);
        
        console.log(`${title} → ${diffHours.toFixed(1)}h`);
        
        if (diffHours <= 24) {
          results.push({ 
            title, 
            chapter: chapterText, 
            updatedTime,
            diffHours: diffHours.toFixed(1)
          });
        }
      });
      
      console.log(`Total 24h results: ${results.length}`);
      
      if (results.length === 0) {
        await editInteractionResponse(payload.token, "🕐 **No chapters in last 24h.**\n\n*Site clean hari ini!*");
        return;
      }

      // Format output
      const list = results
        .slice(0, 10)
        .map(r => `• **${r.title}**\n  ${r.chapter} • ${formatTimeAgo(r.updatedTime)}`)
        .join("\n\n");

      const embed = {
        title: `🕐 **Recent Chapters (24h)** (${results.length})`,
        description: list,
        color: 0x00ff88,
        timestamp: new Date().toISOString()
      };

      await editInteractionResponse(payload.token, { embeds: [embed] });
      
    } catch (err) {
      console.error("Recent error:", err.message);
      await editInteractionResponse(payload.token, `❌ **Error:** ${err.message}`);
    }
  })());
}

// ✅ Helper function
function formatTimeAgo(datetime) {
  const date = new Date(datetime);
  const now = new Date();
  const diffMs = now - date;
  const diffHours = Math.floor(diffMs / 3600000);
  const diffMin = Math.floor((diffMs % 3600000) / 60000);
  
  if (diffHours < 1) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return 'Today';
}
