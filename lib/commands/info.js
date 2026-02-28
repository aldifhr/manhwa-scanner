import { waitUntil } from "@vercel/functions";
import { editInteractionResponse } from "../discord.js";
import { InteractionResponseType } from "discord-interactions";
import axios from "axios";
import * as cheerio from "cheerio";

export default function handleInfo(payload, options, res) {
  const title = options?.[0]?.value;
  if (!title) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Please provide a manga title!" },
    });
  }

  res.json({ type: 5 });

  waitUntil(
    (async () => {
      try {
        const searchResponse = await axios.post(
          "https://02.ikiru.wtf/wp-admin/admin-ajax.php?nonce=eecc652792&action=search",
          new URLSearchParams({ query: title }),
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.5",
              Referer: "https://02.ikiru.wtf/",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            timeout: 10000,
          },
        );

        const $search = cheerio.load(searchResponse.data);
        let mangaUrl = null;
        let mangaTitle = null;

        $search("a").each((i, el) => {
          const foundTitle = $search(el).find("h3, .title, h2").text().trim();
          if (
            foundTitle &&
            foundTitle.toLowerCase().includes(title.toLowerCase())
          ) {
            mangaUrl = $search(el).attr("href");
            mangaTitle = foundTitle;
            return false;
          }
        });

        if (!mangaUrl) {
          await editInteractionResponse(
            payload.token,
            `🔍 Manga **"${title}"** tidak ditemukan.`,
          );
          return;
        }

        const fullUrl = mangaUrl.startsWith("http")
          ? mangaUrl
          : `https://02.ikiru.wtf${mangaUrl}`;
        const detailResponse = await axios.get(fullUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            Referer: "https://02.ikiru.wtf/",
          },
          timeout: 10000,
        });

        const $detail = cheerio.load(detailResponse.data);
        const description =
          $detail('meta[name="description"]').attr("content") ||
          $detail(".description, .summary, [class*='description']")
            .first()
            .text()
            .trim() ||
          "No synopsis available";
        const rating = $detail(".numscore").first().text().trim() || "N/A";
        const status =
          $detail("p.font-normal.text-xs, .status")
            .filter((_, el) =>
              ["Ongoing", "Completed", "Hiatus", "Dropped"].includes(
                $detail(el).text().trim(),
              ),
            )
            .first()
            .text()
            .trim() || "Unknown";
        const chapters = $detail("a[href*='chapter']").length || "Unknown";
        const shortDesc =
          description.length > 200
            ? description.substring(0, 197) + "..."
            : description;

        await editInteractionResponse(
          payload.token,
          `📖 **[${mangaTitle}](${fullUrl})**\n\n` +
            `⭐ **Rating:** ${rating}/10\n` +
            `📊 **Status:** ${status}\n` +
            `📚 **Chapters:** ${chapters}\n\n` +
            `📝 **Synopsis:**\n${shortDesc}\n\n` +
            `💡 Use \`/add "${mangaTitle}"\` to add to whitelist`,
        );
      } catch (err) {
        await editInteractionResponse(
          payload.token,
          `❌ Error getting manga info: ${err.message}`,
        );
      }
    })(),
  );
}
