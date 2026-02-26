import { waitUntil }               from "@vercel/functions";
import { editInteractionResponse } from "../discord.js";
import axios                       from "axios";
import * as cheerio                from "cheerio";

const SITE_URL = "https://02.ikiru.wtf/";

export default function handlePopular(payload, options, res) {
  res.json({ type: 5 });

  waitUntil((async () => {
    try {
      const period     = options?.[0]?.value || "daily";
      const periodText = period === "daily" ? "Today" : period === "weekly" ? "This Week" : "This Month";
      const response   = await axios.get(SITE_URL, {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 10000,
      });
      const $       = cheerio.load(response.data);
      const results = [];

      $(`[data-trending-chart="${period}"] li`).each((i, el) => {
        const link  = $(el).find("a").attr("href");
        const title = $(el).find("h3").text().trim();
        if (title && link) {
          results.push({
            rank:  i + 1,
            title,
            url:   link.startsWith("http") ? link : `https://02.ikiru.wtf${link}`,
          });
        }
      });

      if (results.length === 0) {
        await editInteractionResponse(payload.token, `🔥 No popular manga found for **${periodText}**.`);
        return;
      }

      const list = results
        .map((r) => {
          const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : `#${r.rank}`;
          return `${medal} **[${r.title}](${r.url})**`;
        })
        .join("\n");

      await editInteractionResponse(payload.token, `🔥 **Popular Manga — ${periodText}:**\n\n${list}`);
    } catch (err) {
      await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
    }
  })());
}
