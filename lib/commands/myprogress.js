import { normalizeTitleKey, getChapterNumber } from "../domain.js";
import { editInteractionResponse, editInteractionResponseWithComponents } from "../discord.js";
import { waitUntil } from "@vercel/functions";

function buildToggleButton(state, title, chapter) {
  const isRead = state === "read";
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: isRead ? 4 : 3, // 4 = Danger/Red, 3 = Success/Green
          label: isRead ? "Sudah Dibaca ✓" : "Tandai Sudah Baca",
          custom_id: `${isRead ? "unread" : "read"}:${title.slice(0, 70)}:${chapter.slice(0, 20)}`,
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

    const progressDataKey = `user:progress_data:${userId}`;
    const progressKeyLegacy = `user:progress:${userId}:${titleKey}`;
    
    let resultMessage = `📚 **${title}** (Chapter ${chapter}) sudah ditandai masuk ke progress baca kamu!`;
    const chapterNum = getChapterNumber(chapter);
    
    // Coba ambil dari Hash (form baru)
    let existingProgress = await redis.hget(progressDataKey, titleKey);
    // Fallback ke key individual (form lama) jika tidak ada di Hash
    if (!existingProgress) {
      existingProgress = await redis.get(progressKeyLegacy);
    }

    if (action === "read") {
      if (!existingProgress || chapterNum >= existingProgress.chapterNum) {
        // Update data baru ke dalam Hash
        const newData = {
          title,
          chapter,
          chapterNum,
          timestamp: new Date().toISOString()
        };
        
        await Promise.all([
          redis.hset(progressDataKey, { [titleKey]: newData }),
          // Index for fast listing: [Key, Score, Value]
          redis.zadd(`user:progress_list:${userId}`, {
            score: Date.now(),
            member: titleKey
          }),
          // Hapus key lama jika ada (cleanup)
          redis.del(progressKeyLegacy)
        ]);
      } else {
        resultMessage = `Judul ini sudah ada di progress kamu (Terakhir: **${existingProgress.chapter}**).`;
      }
    } else if (action === "unread") {
      await Promise.all([
        redis.hdel(progressDataKey, titleKey),
        redis.del(progressKeyLegacy), // Pastikan key lama juga dihapus
        redis.zrem(`user:progress_list:${userId}`, titleKey)
      ]);
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

  const subcommand = options?.[0]?.name;
  const subOptions = options?.[0]?.options || [];

  if (subcommand === "clear") {
    // Handling "/myprogress clear [judul]"
    const query = subOptions.find(o => o.name === "judul")?.value;
    if (!query) {
      return res.json({ type: 4, data: { content: "❌ Masukkan judul manga yang ingin dihapus dari progres.", flags: 64 } });
    }

    const titleKey = normalizeTitleKey(query);
    const progressDataKey = `user:progress_data:${userId}`;
    const progressKeyLegacy = `user:progress:${userId}:${titleKey}`;
    const indexKey = `user:progress_list:${userId}`;

    res.json({ type: 5, data: { flags: 64 } });
    waitUntil((async () => {
      try {
        // Coba cek di Hash dulu baru legacy
        const existing = (await redis.hget(progressDataKey, titleKey)) || (await redis.get(progressKeyLegacy));
        
        if (!existing) {
          await redis.zrem(indexKey, titleKey);
          return editInteractionResponse(payload, `❌ Progres untuk **${query}** tidak ditemukan.`);
        }
        
        await Promise.all([
          redis.hdel(progressDataKey, titleKey),
          redis.del(progressKeyLegacy),
          redis.zrem(indexKey, titleKey)
        ]);
        
        return editInteractionResponse(payload, `✅ Berhasil menghapus **${existing.title || query}** dari progres baca kamu.`);
      } catch (err) {
        console.error("[handleMyProgress clear] Error:", err);
        return editInteractionResponse(payload, `❌ Gagal: ${err.message}`);
      }
    })());
    return;
  }

  // Handling /myprogress list (default behavior)
  const page = parseInt(subOptions?.find(o => o.name === "page")?.value, 10) || 1;
  if (!res.headersSent) {
    res.json({ type: 5, data: { flags: 64 } });
  }

  waitUntil(
    (async () => {
      try {
        const indexKey = `user:progress_list:${userId}`;
        const progressDataKey = `user:progress_data:${userId}`;
        
        // --- LAZY MIGRATION START ---
        // 1. Jika ZSET index kosong, coba cari dari pattern key lama "user:progress:ID:*"
        const zsetCount = await redis.zcard(indexKey);
        if (zsetCount === 0) {
          let cursor = "0";
          const allLegacyKeys = [];
          do {
            const [nextCursor, keysBatch] = await redis.scan(cursor, {
              match: `user:progress:${userId}:*`,
              count: 100
            });
            allLegacyKeys.push(...keysBatch);
            cursor = nextCursor;
          } while (cursor !== "0" && allLegacyKeys.length < 500);

          if (allLegacyKeys.length > 0) {
            const oldValues = await redis.mget(...allLegacyKeys);
            const migrationTasks = [];
            
            allLegacyKeys.forEach((key, i) => {
              const val = oldValues[i];
              if (!val) return;
              const tk = key.split(":").pop();
              const score = val.timestamp ? new Date(val.timestamp).getTime() : Date.now();
              // Tambahkan ke ZSET index
              migrationTasks.push(redis.zadd(indexKey, { score, member: tk }));
              // Pindahkan ke Hash
              migrationTasks.push(redis.hset(progressDataKey, { [tk]: val }));
              // Hapus key lama
              migrationTasks.push(redis.del(key));
            });
            
            if (migrationTasks.length > 0) await Promise.all(migrationTasks);
          }
        }
        // --- LAZY MIGRATION END ---

        const pageSize = 10;
        const total = await redis.zcard(indexKey);
        const totalPage = Math.ceil(total / pageSize) || 1;
        const pageSafe = Math.min(Math.max(1, page), totalPage);

        const start = (pageSafe - 1) * pageSize;
        const end = start + pageSize - 1;

        // Ambil titles dari Sorted Set (ZSET) sesuai halaman
        const titleKeys = await redis.zrange(indexKey, start, end, { rev: true });
        
        if (!titleKeys || titleKeys.length === 0) {
          return editInteractionResponseWithComponents(payload, pageSafe > 1 ? "Halaman ini kosong." : "Kamu belum menandai progress baca apapun.", []);
        }

        // Ambil detail progress dari Hash secara bulk
        const progressValues = await redis.hmget(progressDataKey, ...titleKeys);
        
        // Jika ada yang null di Hash, mungkin belum dipindahkan dari key individual (lazy migration part 2)
        const progressData = [];
        const missingLegacyTasks = [];

        for (let i = 0; i < titleKeys.length; i++) {
          if (progressValues[i]) {
            progressData.push(progressValues[i]);
          } else {
            const tk = titleKeys[i];
            const legacyKey = `user:progress:${userId}:${tk}`;
            const legacyVal = await redis.get(legacyKey);
            
            if (legacyVal) {
              progressData.push(legacyVal);
              // Migrasi on-the-fly ke Hash
              missingLegacyTasks.push(redis.hset(progressDataKey, { [tk]: legacyVal }));
              missingLegacyTasks.push(redis.del(legacyKey));
            }
          }
        }
        
        if (missingLegacyTasks.length > 0) {
          // Jangan nunggu, biar proses respons tetap cepat
          waitUntil(Promise.all(missingLegacyTasks));
        }

        if (progressData.length === 0) {
          return editInteractionResponseWithComponents(payload, pageSafe > 1 ? "Halaman ini kosong." : "Kamu belum menandai progress baca apapun.", []);
        }

        const lines = progressData.map((p, i) => {
          const date = new Date(p.timestamp).toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" });
          const displayTitle = p.title || "Untitled";
          return `${start + i + 1}. **${displayTitle}** - ${p.chapter} (${date})`;
        });

        const footer = `\n*Halaman ${pageSafe}/${totalPage}*`;
        const content = `📚 **Progress Baca Kamu:**\n\n${lines.join("\n")}${footer}`;
        
        const components = [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 1,
                label: "Sebelumnya",
                custom_id: `myprogress:${pageSafe - 1}`,
                disabled: pageSafe <= 1,
              },
              {
                type: 2,
                style: 2,
                label: `Hal ${pageSafe}`,
                custom_id: "noop",
                disabled: true,
              },
              {
                type: 2,
                style: 1,
                label: "Berikutnya",
                custom_id: `myprogress:${pageSafe + 1}`,
                disabled: pageSafe >= totalPage,
              },
            ],
          },
        ];

        return editInteractionResponseWithComponents(payload, content, components);
      } catch (err) {
        console.error("[handleMyProgress] Error:", err);
        return editInteractionResponse(payload, `Terjadi kesalahan: ${err.message}`);
      }
    })()
  );
}

