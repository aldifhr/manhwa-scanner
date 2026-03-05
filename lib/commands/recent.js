import { waitUntil } from "@vercel/functions";
import { editInteractionResponseWithComponents } from "../discord.js";
import axios from "axios";
import * as cheerio from "cheerio";
import { formatTimeAgo } from "../scraper.js";

const SITE_URL = "https://02.ikiru.wtf/";

export default function handleRecent(payload, options, res) {
  // Defer interaction
  res.json({ type: 5 });

  waitUntil(
    (async () => {
      try {
        console.log("🔍 Scraping", SITE_URL);

        const { data } = await axios.get(SITE_URL, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          timeout: 10000,
        });

        const $ = cheerio.load(data);
        const results = [];
        const seen = new Set();

        // Ambil horizontal layout saja
        const horizontalItems = $(
          "#latest-list:not(.group-data-direction\\:horizontal\\:hidden) > div",
        );

        if (horizontalItems.length === 0) {
          console.warn(
            "[handleRecent] Selector tidak match — struktur HTML mungkin berubah",
          );
        }

        horizontalItems.each((i, el) => {
          if (results.length >= 5) return; // TOP 5 only

          const card = $(el);

          // Ambil chapter terbaru
          const chapterLink = card.find('a[href*="/chapter-"]').first();
          if (!chapterLink.length) return;

          const $time = chapterLink.find("time[datetime]").first();
          const $chapterP = chapterLink.find('p:contains("Chapter")').first();
          if (!$time.length || !$chapterP.length) return;

          const updatedTime = $time.attr("datetime");
          const chapterText = $chapterP.text().trim();

          // Cari title di parent card
          let title = "";
          let $parent = card;
          while ($parent.length && title.length < 3) {
            title = $parent
              .find("h1,h3,.text-15px,.font-bold")
              .first()
              .text()
              .trim();
            $parent = $parent.parent();
          }

          // fallback dari slug URL
          if (!title) {
            const href = chapterLink.attr("href");
            title = href?.split("/manga/")[1]?.replace(/-/g, " ") || "Unknown";
          }

          // ❌ No duplicate
          const key = `${title}-${chapterText}`;
          if (seen.has(key)) return;
          seen.add(key);

          // Filter 24 jam
          const diffHours = (new Date() - new Date(updatedTime)) / 3600000;
          if (diffHours > 24) return;

          let url = chapterLink.attr("href");
          if (url?.startsWith("/")) url = `${SITE_URL}${url}`;

          results.push({
            title: title.slice(0, 50),
            chapter: chapterText,
            updatedTime,
            url,
          });
        });

        console.log(`Total 24h results: ${results.length}`);

        // Jika tidak ada chapter
        if (results.length === 0) {
          await editInteractionResponseWithComponents(
            payload.token,
            "🕐 **No chapters in last 24h.**\n\n*Site clean hari ini!*",
            [],
            [],
          );
          return;
        }

        // Format embed
        const description = results
          .map(
            (r, i) =>
              `**${i + 1}. ${r.title}**\n${r.chapter} • ${formatTimeAgo(
                r.updatedTime,
              )}\n[→ Baca Sekarang](${r.url})`,
          )
          .join("\n\n");

        const embed = {
          title: `🕐 Recent Top 5 Chapters (24h)`,
          description,
          color: 0x00ff88,
          timestamp: new Date().toISOString(),
        };

        // Kirim embed ke Discord
        await editInteractionResponseWithComponents(
          payload.token,
          "",
          [],
          [embed],
        );
      } catch (err) {
        console.error("Recent error:", err.message);
        await editInteractionResponseWithComponents(
          payload.token,
          `❌ **Error:** ${err.message}`,
          [],
          [],
        );
      }
    })(),
  );
}
