import { waitUntil } from "@vercel/functions";
import { editInteractionResponse } from "../discord.js";
import axios from "axios";
import * as cheerio from "cheerio";

const SITE_URL = "https://02.ikiru.wtf/";

export default function handleRecent(payload, options, res) {
  res.json({ type: 5 });

  waitUntil(async () => {
    try {
      const { data } = await axios.get(SITE_URL, {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 10000,
      });
      const $ = cheerio.load(data);
      
      // ✅ Target LATEST UPDATES only
      const results = [];
      
      // Find "Latest Updates" section specifically
      $('h1:contains("Latest Updates")').nextUntil('h1').find('a').each((i, el) => {
        const $card = $(el);
        const chapterText = $card.find("p").text().trim();
        
        if (!chapterText.includes("Chapter")) return;
        
        const $parent = $card.parent();
        const title = $parent.find("h1,h3").first().text().trim();
        const updatedTime = $card.find("time").attr("datetime");
        
        if (title && chapterText) {
          results.push({ title, chapter: chapterText, updatedTime });
        }
      });
      
      if (results.length === 0) {
        await editInteractionResponse(payload.token, "🕐 No recent chapters found.");
        return;
      }

      const list = results
        .slice(0, 5)
        .map(r => `• **${r.title}** — ${r.chapter}`)
        .join("\n");

      await editInteractionResponse(payload.token, `🕐 **5 Latest Chapters:**\n\n${list}`);
      
    } catch (err) {
      await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
    }
  });
}
