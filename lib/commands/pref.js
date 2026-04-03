import { InteractionResponseType } from "discord-interactions";
import { getUserNotifyMode, setUserNotifyMode, updateNotifyModeIndex, NOTIFY_MODES } from "../services/notifications.js";

export default async function handlePref(payload, options, res) {
  const userId = payload.member?.user?.id ?? payload.user?.id;
  const subcommand = options?.[0]?.name;
  const subOptions = options?.[0]?.options || [];

  if (subcommand === "ping") {
    const newMode = subOptions.find(o => o.name === "mode")?.value;

    if (!newMode) {
      // Just query current mode
      const currentMode = await getUserNotifyMode(userId);
      let desc = "";
      if (currentMode === NOTIFY_MODES.ALL) {
        desc = "🔔 **Semua Update**: Kamu akan di-tag untuk setiap update manga di whitelist.";
      } else if (currentMode === NOTIFY_MODES.FOLLOWS) {
        desc = "⭐ **Hanya Follow**: Kamu hanya akan di-tag untuk manga yang kamu klik 'Follow'.";
      } else {
        desc = "🔕 **Mati**: Kamu tidak akan di-tag sama sekali.";
      }

      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `Mode notifikasi kamu saat ini: **${currentMode.toUpperCase()}**\n\n${desc}`,
          flags: 64,
        },
      });
    }

    // Update mode
    try {
      await setUserNotifyMode(userId, newMode);
      await updateNotifyModeIndex(userId, newMode);

      let msg = "";
      if (newMode === NOTIFY_MODES.ALL) {
        msg = "✅ Mode Berhasil diubah: **SEMUA UPDATE**. Sekarang kamu akan di-tag untuk setiap update manga!";
      } else if (newMode === NOTIFY_MODES.FOLLOWS) {
        msg = "✅ Mode Berhasil diubah: **HANYA FOLLOW**. Kamu hanya akan di-tag untuk manga yang kamu ikuti secara manual.";
      } else {
        msg = "✅ Mode Berhasil diubah: **NONAKTIF**. Kamu tidak akan mendapatkan tag notifikasi lagi.";
      }

      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: msg, flags: 64 },
      });
    } catch (err) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `❌ Gagal mengubah preference: ${err.message}`, flags: 64 },
      });
    }
  }

  return res.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "Subcommand tidak dikenal.", flags: 64 },
  });
}
