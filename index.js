import axios from "axios";
import * as cheerio from "cheerio";
import { Redis } from "@upstash/redis";

const URL = "https://02.ikiru.wtf/";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function scrape() {
  const res = await axios.get(URL);
  const $ = cheerio.load(res.data);

  const items = [];

  $("a").each((i, el) => {
    const link = $(el).attr("href");
    const chapterText = $(el).find("p").text().trim();

    if (chapterText.includes("Chapter")) {
      const title = $(el).find("h3").text().trim();

      items.push({
        title,
        chapter: chapterText,
        url: link,
      });
    }
  });

  return items;
}

async function sendDiscord(data) {
  await axios.post(DISCORD_WEBHOOK, {
    content: `📢 **New Chapter!**
    
**${data.title}**
${data.chapter}
${data.url}`,
  });
}

async function main() {
  const items = await scrape();

  for (const item of items) {
    const key = `chapter:${item.url}`;
    const exists = await redis.get(key);

    if (!exists) {
      console.log("NEW:", item.title, item.chapter);

      await sendDiscord(item);
      await redis.set(key, "sent");
    }
  }
}

main();
