import { waitUntil }               from "@vercel/functions";
import { editInteractionResponse } from "../discord.js";
import axios                       from "axios";
import * as cheerio                from "cheerio";

const SITE_URL = "https://02.ikiru.wtf/";

export default function handleRecent(payload, options, res) {
  res.json({ type: 5 });

  waitUntil((async () => {
    try {
      const response = await axios.get(SITE_URL, {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 10000,
      });
      const $       = cheerio.load(response.data);
      const results = [];
      let inSection = false;

      $("*").each((i, el) => {
        const tagName = el.tagName?.toLowerCase();
        const text    = $(el).text().trim();

        if (tagName === "h1" && (text === "Project Updates" || text === "Latest Updates")) {
          inSection = true;
        }
        if (inSection && tagName === "h1" && text !== "Project Updates" && text !== "Latest Updates" && text.includes("Updates")) {
          inSection = false;
        }
        if (inSection && tagName === "a") {
          const card        = $(el);
          const chapterText = card.find("p").text().trim();
          if (chapterText.includes("Chapter")) {
            const parent      = card.parent();
            const t           = parent.find("h1").text().trim() || card.find("h3").text().trim();
            const updatedTime = card.find("time").attr("datetime");
            if (t && chapterText) {
              results.push({ title: t, chapter: chapterText, updatedTime });
            }
          }
        }
      });

      if (results.length === 0) {
        await editInteractionResponse(payload.token, "🕐 No recent chapters found.");
        return;
      }

      const list = results
        .slice(0, 5)
        .map((r) => `• **${r.title}** — ${r.chapter}`)
        .join("\n");

      await editInteractionResponse(payload.token, `🕐 **5 Latest Chapters:**\n\n${list}`);
    } catch (err) {
      await editInteractionResponse(payload.token, `❌ Error fetching recent chapters: ${err.message}`);
    }
  })());
}
