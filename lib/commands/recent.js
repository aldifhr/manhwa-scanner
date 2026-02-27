import { waitUntil } from "@vercel/functions";
import { editInteractionResponse } from "../discord.js";
import axios from "axios";
import * as cheerio from "cheerio";

export default async function handleRecent(payload, options, res) {
  res.json({ type: 5 });
  
  // ✅ FIX: Return Promise dari IIFE
  waitUntil((async () => {
    try {
      const { data } = await axios.get("https://02.ikiru.wtf/", {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 10000,
      });
      
      const $ = cheerio.load(data);
      const results = [];
      
      // Latest Updates + 24h filter
      $('h1:contains("Latest Updates")').nextUntil('h1').find('a').each((i, el) => {
        const $card = $(el);
        const chapterText = $card.find("p").text().trim();
        
        if (!chapterText.includes("Chapter")) return;
        
        const $parent = $card.parent();
        const title = $parent.find("h1,h3").first().text().trim();
        const updatedTime = $card.find("time").attr("datetime");
        
        if (title && chapterText && updatedTime) {
          const updateDate = new Date(updatedTime);
          const diffHours = (new Date() - updateDate) / 3600000;
          
          if (diffHours <= 24) {
            results.push({ title, chapter: chapterText, updatedTime });
          }
        }
      });
      
      if (results.length === 0) {
        await editInteractionResponse(payload.token, "🕐 No chapters in last 24h.");
        return;
      }

      const list = results
        .slice(0, 5)
        .map(r => `• **${r.title}** — ${r.chapter} (${formatTimeAgo(r.updatedTime)})`)
        .join("\n");

      await editInteractionResponse(payload.token, `🕐 **Recent Chapters (24h):**\n\n${list}`);
      
    } catch (err) {
      await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
    }
  })());  // ← IIFE return Promise!
}
