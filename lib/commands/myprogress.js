import { normalizeTitleKey, getChapterNumber } from "../domain/manga.js";
import { editInteractionResponse } from "../discord.js";
import { waitUntil } from "@vercel/functions";

function buildToggleButton(action, title, chapter) {
  const isMarkingRead = action === "read";
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: isMarkingRead ? 4 : 3, // 4 = Danger/Red, 3 = Success/Green
          label: isMarkingRead ? "Sudah Dibaca ✓" : "Tandai Sudah Baca",
          custom_id: `read:${title}:${chapter}`,
          disabled: false,
        },
      ],
    },
  ];
}

export default async function handleMyProgress(payload, options, res, redis) {
  const userId = payload.member?.user?.id ?? payload.user?.id;
  const isButton = options?.[0]?.name === "button";

  if (isButton) {
    // Handling "Mark as Read" button toggle
    const customId = options[0].value;
    
    // Gunakan shift() dan pop() untuk menghindari bug jika judul manga mengandung tanda titik dua ":" (misal: "Re:Zero")
    const parts = customId.split(":");
    const action = parts.shift();       // ambil 'read' / 'unread' di awal
    const chapter = parts.pop();        // ambil 'chapter' di akhir
    const title = parts.join(":");      // gabungkan sisa array text untuk 'title'

    const titleKey = normalizeTitleKey(title);
    
    if (!titleKey) {
      return res.json({ type: 4, data: { content: "Invalid title.", flags: 64 } });
    }

    const progressKey = `user:progress:${userId}:${titleKey}`;
    
    let resultMessage = `📚 **${title}** (Chapter ${chapter}) sudah ditandai masuk ke progress baca kamu!`;
    const chapterNum = getChapterNumber(chapter);
    const existingProgress = await redis.get(progressKey);

    if (action === "read" || action === "unread") {
      if (!existingProgress || chapterNum >= existingProgress.chapterNum) {
        await redis.set(progressKey, {
          title,
          chapter,
          chapterNum,
          timestamp: new Date().toISOString()
        });
      } else {
        resultMessage = `Judul ini sudah ada di progress kamu (Terakhir: **${existingProgress.chapter}**).`;
      }
    }

    const isMessageEphemeral = (payload.message?.flags & 64) === 64;

    if (!isMessageEphemeral) {
      // In public channels:
      // 1. If clicking 'read' (green button): Just send ephemeral confirm, DON'T change button to red.
      // 2. If clicking 'unread' (red button - usually stuck from old behavior): Update back to green for everyone.
      
      if (action === "unread") {
        return res.json({
          type: 7, // UPDATE_MESSAGE
          data: { components: buildToggleButton("unread", title, chapter) },
        });
      }

      return res.json({
        type: 4,
        data: {
          content: resultMessage,
          flags: 64,
        },
      });
    }

    return res.json({
      type: 7, // UPDATE_MESSAGE
      data: { components: buildToggleButton("read", title, chapter) },
    });
  }

  // Handling /myprogress slash command
  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    (async () => {
      try {
        const pattern = `user:progress:${userId}:*`;
        const keys = await redis.keys(pattern);
        
        if (!keys || keys.length === 0) {
          return editInteractionResponse(payload, "Kamu belum menandai progress baca apapun.");
        }

        // Use mget to prevent N+1 queries
        const values = await redis.mget(...keys);
        const progressData = keys.reduce((acc, key, i) => {
          if (values[i]) {
            acc.push({ titleKey: key.split(":").pop(), ...values[i] });
          }
          return acc;
        }, []);

        // Sort by most recently updated
        progressData.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        const lines = progressData.slice(0, 20).map((p, i) => {
          const date = new Date(p.timestamp).toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" });
          const displayTitle = p.title ? p.title : p.titleKey.toUpperCase();
          return `${i + 1}. **${displayTitle}** - ${p.chapter} (${date})`;
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
