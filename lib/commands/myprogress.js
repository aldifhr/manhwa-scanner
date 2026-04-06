import { getChapterNumber, normalizeTitleKey } from "../domain.js";
import {
  editInteractionResponse,
  editInteractionResponseWithComponents,
} from "../discord.js";
import { waitUntil } from "@vercel/functions";
import { REDIS_SCAN_BATCH_SIZE } from "../config.js";

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
    const action = parts.shift(); // ambil 'read' / 'unread' di awal
    const chapter = parts.pop(); // ambil 'chapter' di akhir
    const title = parts.join(":"); // gabungkan sisa array text untuk 'title'

    const titleKey = normalizeTitleKey(title);

    if (!titleKey) {
      return res.json({
        type: 4,
        data: { content: "Invalid title.", flags: 64 },
      });
    }

    // Send deferred response immediately to prevent "This interaction failed"
    res.json({ type: 5, data: { flags: 64 } });

    // Process in background using waitUntil
    waitUntil(
      (async () => {
        try {
          const progressDataKey = "users:progress_data";
          const progressListKey = "users:progress_list";
          const progressKeyLegacy = `user:progress:${userId}:${titleKey}`; // Sangat lama
          const progressDataKeyLegacy = `user:progress_data:${userId}`; // Hash per-user lama

          let resultMessage = `📚 **${title}** (Chapter ${chapter}) sudah ditandai masuk ke progress baca kamu!`;
          const chapterNum = getChapterNumber(chapter);
          const newData = { timestamp: Date.now(), title, chapter, chapterNum };

          // Coba ambil dari Master Hash
          const usersDataStr = await redis.hget(progressDataKey, userId);
          let userData = {};
          if (usersDataStr) {
            try {
              // Handle case where data might already be an object or invalid JSON
              if (typeof usersDataStr === "object") {
                userData = usersDataStr;
              } else if (usersDataStr === "[object Object]") {
                userData = {};
              } else {
                userData = JSON.parse(usersDataStr);
              }
            } catch (parseErr) {
              console.error(
                "[myprogress] Failed to parse user data:",
                usersDataStr,
                parseErr.message,
              );
              userData = {};
            }
          }
          let existingProgress = userData[titleKey];

          // Fallback migration check
          if (!existingProgress) {
            try {
              existingProgress = await redis.hget(
                progressDataKeyLegacy,
                titleKey,
              );
              if (
                existingProgress &&
                typeof existingProgress === "string" &&
                existingProgress !== "[object Object]"
              ) {
                try {
                  existingProgress = JSON.parse(existingProgress);
                } catch (e) {
                  // Keep as is if parse fails
                }
              }
            } catch (e) {
              existingProgress = null;
            }
            if (!existingProgress) {
              try {
                existingProgress = await redis.get(progressKeyLegacy);
                if (
                  existingProgress &&
                  typeof existingProgress === "string" &&
                  existingProgress !== "[object Object]"
                ) {
                  try {
                    existingProgress = JSON.parse(existingProgress);
                  } catch (e) {
                    // Keep as is if parse fails
                  }
                }
              } catch (e) {
                existingProgress = null;
              }
            }
          }

          if (action === "read") {
            if (
              !existingProgress ||
              chapterNum >= existingProgress.chapterNum
            ) {
              userData[titleKey] = newData;

              const usersListStr = await redis.hget(progressListKey, userId);
              let userList = [];
              if (usersListStr) {
                try {
                  if (typeof usersListStr === "object") {
                    userList = usersListStr;
                  } else if (usersListStr !== "[object Object]") {
                    userList = JSON.parse(usersListStr);
                  }
                } catch (parseErr) {
                  console.error(
                    "[myprogress] Failed to parse user list:",
                    usersListStr,
                    parseErr.message,
                  );
                  userList = [];
                }
              }
              userList = userList.filter((i) => i.member !== titleKey);
              userList.push({ score: Date.now(), member: titleKey });
              userList.sort((a, b) => b.score - a.score);

              await Promise.all([
                redis.hset(progressDataKey, {
                  [userId]: JSON.stringify(userData),
                }),
                redis.hset(progressListKey, {
                  [userId]: JSON.stringify(userList),
                }),
                redis.del(progressKeyLegacy),
                redis.del(progressDataKeyLegacy),
                redis.del(`user:progress_list:${userId}`), // zset legacy cleanup
              ]);
            } else {
              resultMessage = `Judul ini sudah ada di progress kamu (Terakhir: **${existingProgress.chapter}**).`;
            }
          } else if (action === "unread") {
            delete userData[titleKey];
            const usersListStr = await redis.hget(progressListKey, userId);
            let userList = [];
            if (usersListStr) {
              try {
                if (typeof usersListStr === "object") {
                  userList = usersListStr;
                } else if (usersListStr !== "[object Object]") {
                  userList = JSON.parse(usersListStr);
                }
              } catch (parseErr) {
                console.error(
                  "[myprogress] Failed to parse user list:",
                  usersListStr,
                  parseErr.message,
                );
                userList = [];
              }
            }
            const filteredList = userList.filter((i) => i.member !== titleKey);

            await Promise.all([
              redis.hset(progressDataKey, {
                [userId]: JSON.stringify(userData),
              }),
              redis.hset(progressListKey, {
                [userId]: JSON.stringify(filteredList),
              }),
              redis.del(progressKeyLegacy),
              redis.hdel(progressDataKeyLegacy, titleKey),
              redis.zrem(`user:progress_list:${userId}`, titleKey),
            ]);
          }

          const isMessageEphemeral = (payload.message?.flags & 64) === 64;
          const token = payload.token;

          if (!isMessageEphemeral) {
            // In public channels:
            // 1. If clicking 'read' (green button): Just send ephemeral confirm, DON'T change button to red.
            // 2. If clicking 'unread' (red button - usually stuck from old behavior): Update back to green for everyone.

            if (action === "unread") {
              await editInteractionResponseWithComponents(token, {
                components: buildToggleButton("unread", title, chapter),
              });
            } else {
              await editInteractionResponse(token, {
                content: resultMessage,
                flags: 64,
              });
            }
          } else {
            await editInteractionResponseWithComponents(token, {
              components: buildToggleButton("read", title, chapter),
            });
          }
        } catch (err) {
          console.error("[myprogress] Error processing button click:", err);
          console.error("[myprogress] Error details:", {
            message: err.message,
            stack: err.stack,
            title: title,
            chapter: chapter,
            action: action,
            userId: userId,
          });
          const token = payload.token;
          try {
            await editInteractionResponse(token, {
              content: `❌ Error: ${err.message || "Unknown error"}`,
              flags: 64,
            });
          } catch (editErr) {
            console.error(
              "[myprogress] Failed to send error response:",
              editErr,
            );
          }
        }
      })(),
    );

    return;
  }

  const subcommand = options?.[0]?.name;
  const subOptions = options?.[0]?.options || [];

  if (subcommand === "clear") {
    // Handling "/myprogress clear [judul]"
    const query = subOptions.find((o) => o.name === "judul")?.value;
    if (!query) {
      return res.json({
        type: 4,
        data: {
          content: "❌ Masukkan judul manga yang ingin dihapus dari progres.",
          flags: 64,
        },
      });
    }

    const titleKey = normalizeTitleKey(query);
    const progressDataKey = "users:progress_data";
    const progressListKey = "users:progress_list";

    res.json({ type: 5, data: { flags: 64 } });
    waitUntil(
      (async () => {
        try {
          const usersDataStr = await redis.hget(progressDataKey, userId);
          const userData = usersDataStr ? JSON.parse(usersDataStr) : {};
          let existing = userData[titleKey];
          const progressKeyLegacy = `user:progress:${userId}:${titleKey}`;
          const progressDataKeyLegacy = `user:progress_data:${userId}`;

          if (!existing) {
            existing = await redis.hget(progressDataKeyLegacy, titleKey);
          }

          if (!existing) {
            existing = await redis.get(progressKeyLegacy);
            if (existing && typeof existing === "string") {
              try {
                existing = JSON.parse(existing);
              } catch {
                /* keep as is */
              }
            }
          }

          if (!existing) {
            return editInteractionResponse(
              payload,
              `❌ Progres untuk **${query}** tidak ditemukan.`,
            );
          }

          delete userData[titleKey];
          const usersListStr = await redis.hget(progressListKey, userId);
          const userList = usersListStr ? JSON.parse(usersListStr) : [];
          const filteredList = userList.filter((i) => i.member !== titleKey);

          await Promise.all([
            redis.hset(progressDataKey, { [userId]: JSON.stringify(userData) }),
            redis.hset(progressListKey, {
              [userId]: JSON.stringify(filteredList),
            }),
            redis.del(progressKeyLegacy),
            redis.hdel(progressDataKeyLegacy, titleKey),
            redis.zrem(`user:progress_list:${userId}`, titleKey),
          ]);

          return editInteractionResponse(
            payload,
            `✅ Berhasil menghapus **${existing.title || query}** dari progres baca kamu.`,
          );
        } catch (err) {
          console.error("[handleMyProgress clear] Error:", err);
          return editInteractionResponse(payload, `❌ Gagal: ${err.message}`);
        }
      })(),
    );
    return;
  }

  // Handling /myprogress list (default behavior)
  const page =
    parseInt(subOptions?.find((o) => o.name === "page")?.value, 10) || 1;
  if (!res.headersSent) {
    res.json({ type: 5, data: { flags: 64 } });
  }

  waitUntil(
    (async () => {
      try {
        const progressListKey = "users:progress_list";
        const progressDataKey = "users:progress_data";

        const usersListStr = await redis.hget(progressListKey, userId);
        let userList = null;
        let migratedFromLegacy = false;

        if (!usersListStr) {
          // Check legacy ZSET
          const indexKeyLegacy = `user:progress_list:${userId}`;
          const titleKeysLegacy = await redis.zrange(indexKeyLegacy, 0, -1, {
            rev: true,
            withScores: true,
          });

          if (titleKeysLegacy && titleKeysLegacy.length > 0) {
            userList = titleKeysLegacy
              .map((tk, i) => ({
                member: tk,
                score: titleKeysLegacy[i + 1] || Date.now(),
              }))
              .filter((i) => typeof i.member === "string");
            migratedFromLegacy = true;
          } else {
            // Check for individual legacy progress keys
            const legacyDataKey = `user:progress_data:${userId}`;
            const legacyHash = await redis.hgetall(legacyDataKey);
            if (legacyHash && Object.keys(legacyHash).length > 0) {
              userList = Object.keys(legacyHash).map((tk) => ({
                member: tk,
                score: Date.now(),
              }));
              migratedFromLegacy = true;
            } else {
              userList = [];
            }
          }
        } else {
          userList = JSON.parse(usersListStr);
        }

        // Also check for any individual legacy keys that might not be in the list
        const individualLegacyKeys = [];
        for (const item of userList) {
          const tk = item.member;
          const legacyKey = `user:progress:${userId}:${tk}`;
          const legacyData = await redis.get(legacyKey);
          if (legacyData) {
            individualLegacyKeys.push({ tk, key: legacyKey, data: legacyData });
          }
        }

        // If list is empty, scan for individual legacy keys
        if (userList.length === 0) {
          try {
            const scanPattern = `user:progress:${userId}:*`;
            let cursor = 0;
            do {
              const [nextCursor, keys] = await redis.scan(cursor, {
                match: scanPattern,
                count: REDIS_SCAN_BATCH_SIZE,
              });
              cursor = Number(nextCursor);
              for (const key of keys) {
                const legacyData = await redis.get(key);
                if (legacyData) {
                  const tk = key.slice(`user:progress:${userId}:`.length);
                  individualLegacyKeys.push({ tk, key, data: legacyData });
                  userList.push({ member: tk, score: Date.now() });
                }
              }
            } while (cursor !== 0);
          } catch {
            /* ignore scan errors */
          }
        }

        const pageSize = 10;
        const total = userList.length;
        const totalPage = Math.ceil(total / pageSize) || 1;
        const pageSafe = Math.min(Math.max(1, page), totalPage);

        const start = (pageSafe - 1) * pageSize;
        const end = start + pageSize;

        const pagedItems = userList.slice(start, end);
        const titleKeys = pagedItems.map((i) => i.member);

        if (!titleKeys || titleKeys.length === 0) {
          return editInteractionResponseWithComponents(
            payload,
            pageSafe > 1
              ? "Halaman ini kosong."
              : "Kamu belum menandai progress baca apapun.",
            [],
          );
        }

        const usersDataStr = await redis.hget(progressDataKey, userId);
        const userData = usersDataStr ? JSON.parse(usersDataStr) : {};

        const progressData = [];
        const migratedData = {};
        const legacyKeysToDelete = [];

        for (const tk of titleKeys) {
          if (userData[tk]) {
            progressData.push(userData[tk]);
          } else {
            const legacyKey = `user:progress:${userId}:${tk}`;
            let data = await redis.hget(`user:progress_data:${userId}`, tk);
            if (!data) {
              data = await redis.get(legacyKey);
              if (data) {
                // Parse if stored as JSON string
                if (typeof data === "string") {
                  try {
                    data = JSON.parse(data);
                  } catch {
                    /* keep as is */
                  }
                }
                legacyKeysToDelete.push(legacyKey);
                migratedData[tk] = data;
              }
            } else if (typeof data === "string") {
              try {
                data = JSON.parse(data);
              } catch {
                /* keep as is */
              }
            }
            if (data) {
              progressData.push(data);
              if (!migratedData[tk] && typeof data === "object") {
                migratedData[tk] = data;
              }
            }
          }
        }

        // Add individual legacy keys to the delete list
        for (const { tk, key, data } of individualLegacyKeys) {
          legacyKeysToDelete.push(key);
          if (!migratedData[tk]) {
            let parsedData = data;
            if (typeof data === "string") {
              try {
                parsedData = JSON.parse(data);
              } catch {
                /* keep as is */
              }
            }
            migratedData[tk] = parsedData;
          }
        }

        // If we found legacy data, migrate it to the new structure
        if (
          migratedFromLegacy ||
          legacyKeysToDelete.length > 0 ||
          Object.keys(migratedData).length > 0
        ) {
          // Merge any newly found legacy data into userData
          for (const [tk, data] of Object.entries(migratedData)) {
            userData[tk] = data;
          }

          // Update userList to include any newly migrated entries
          const existingKeys = new Set(userList.map((i) => i.member));
          for (const tk of Object.keys(migratedData)) {
            if (!existingKeys.has(tk)) {
              userList.push({ member: tk, score: Date.now() });
            }
          }

          // Sort by score descending
          userList.sort((a, b) => b.score - a.score);

          // Save to new structure
          await redis.hset(progressDataKey, {
            [userId]: JSON.stringify(userData),
          });
          await redis.hset(progressListKey, {
            [userId]: JSON.stringify(userList),
          });

          // Clean up legacy keys
          for (const key of legacyKeysToDelete) {
            await redis.del(key);
          }
          if (migratedFromLegacy) {
            await redis.del(`user:progress_list:${userId}`);
            await redis.del(`user:progress_data:${userId}`);
          }
        }

        if (progressData.length === 0) {
          return editInteractionResponseWithComponents(
            payload,
            pageSafe > 1
              ? "Halaman ini kosong."
              : "Kamu belum menandai progress baca apapun.",
            [],
          );
        }

        const lines = progressData.map((p, i) => {
          const date = new Date(p.timestamp).toLocaleDateString("id-ID", {
            timeZone: "Asia/Jakarta",
          });
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

        return editInteractionResponseWithComponents(
          payload,
          content,
          components,
        );
      } catch (err) {
        console.error("[handleMyProgress] Error:", err);
        return editInteractionResponse(
          payload,
          `Terjadi kesalahan: ${err.message}`,
        );
      }
    })(),
  );
}
