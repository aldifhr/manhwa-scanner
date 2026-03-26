import { normalizeTitleKey, getChapterNumber } from "../domain/manga.js";
import { editInteractionResponse } from "../discord.js";
import { waitUntil } from "@vercel/functions";

export default async function handleMyProgress(payload, options, res, redis) {
  const userId = payload.member?.user?.id ?? payload.user?.id;
  const isButton = options?.[0]?.name === "button";

  if (isButton) {
    // Handling "Mark as Read" button: custom_id = read:title:chapter
    const customId = options[0].value;
    const [action, title, chapter] = customId.split(":");
    const titleKey = normalizeTitleKey(title);
    
    if (!titleKey) return res.json({ type: 4, data: { content: "Invalid title.", flags: 64 } });

    const progressKey = `user:progress:${userId}:${titleKey}`;
    const chapterNum = getChapterNumber(chapter);

    let updatedComponents = [];

    if (action === "read") {
      const existingProgress = await redis.get(progressKey);
      if (!existingProgress || chapterNum >= existingProgress.chapterNum) {
        await redis.set(progressKey, {
          chapter,
          chapterNum,
          timestamp: new Date().toISOString()
        });
      }

      updatedComponents = [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 4, // Danger/Red
              label: "Sudah Dibaca ✓",
              custom_id: `unread:${title}:${chapter}`,
              disabled: false,
            },
          ],
        },
      ];
    } else if (action === "unread") {
      await redis.del(progressKey);

      updatedComponents = [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3, // Success/Green
              label: "Tandai Sudah Baca",
              custom_id: `read:${title}:${chapter}`,
              disabled: false,
            },
          ],
        },
      ];
    }

    // Type 7 = UPDATE_MESSAGE — edits the original message in-place
    return res.json({
      type: 7,
      data: { components: updatedComponents },
    });
  }

  // Handling /myprogress command
  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    (async () => {
      try {
        // Scan or get all progress for this user
        const pattern = `user:progress:${userId}:*`;
        const keys = await redis.keys(pattern);
        
        if (!keys || keys.length === 0) {
          return editInteractionResponse(payload, "Kamu belum menandai progress baca apapun.");
        }

        const progressData = [];
        for (const key of keys) {
          const data = await redis.get(key);
          const titleKey = key.split(":").pop();
          if (data) progressData.push({ titleKey, ...data });
        }

        // Sort by timestamp
        progressData.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        const lines = progressData.slice(0, 20).map((p, i) => {
          const date = new Date(p.timestamp).toLocaleDateString("id-ID");
          return `${i + 1}. **${p.titleKey.toUpperCase()}** - ${p.chapter} (${date})`;
        });

        const content = `📚 **Progress Baca Kamu (20 Terakhir):**\n\n${lines.join("\n")}`;
        return editInteractionResponse(payload, content);
      } catch (err) {
        console.error("[handleMyProgress] Error:", err);
        return editInteractionResponse(payload, `Error: ${err.message}`);
      }
    })()
  );
}
