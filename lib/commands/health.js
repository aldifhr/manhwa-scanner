import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { redis } from "../redis.js";
import { editInteractionResponse, editInteractionResponseWithComponents } from "../discord.js";
import { isGuildAdmin } from "../permissions.js";
import { performFullHealthCheck } from "../services/health.js";

export default async function handleHealth(payload, options, res) {
  if (!isGuildAdmin(payload)) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Command ini hanya untuk admin server.", flags: 64 },
    });
  }

  // Akui perintah dengan pesan loading karena scan memakan waktu
  res.json({ 
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, 
    data: { flags: 64 } 
  });

  waitUntil(
    (async () => {
      try {
        await editInteractionResponse(payload, "🔍 **Sedang menjalankan Audit Kesehatan penuh...**\n_(Proses ini memakan waktu sekitar 30-60 detik)_");
        
        const brokenLinks = await performFullHealthCheck();
        const lastCheck = await redis.get("health:last-check");
        const recommendations = await redis.get("health:recommendations") || [];

        let statusEmoji = brokenLinks.length === 0 ? "✅" : "⚠️";
        let content = [
          `## ${statusEmoji} Hasil Audit Kesehatan Bot`,
          `Audit selesai pada: \`${new Date(lastCheck).toLocaleString("id-ID")}\``,
          "",
          `Link dicek: **${brokenLinks.length + (await redis.hlen("whitelist:data") || 0)}** sumber`,
          `Link rusak ditemukan: **${brokenLinks.length}**`,
          "",
        ];

        if (brokenLinks.length > 0) {
          content.push("### ❌ Daftar Link Rusak:");
          const list = brokenLinks.slice(0, 10).map(b => `• **${b.title}** (${b.status})`).join("\n");
          content.push(list);
          if (brokenLinks.length > 10) content.push(`_...dan ${brokenLinks.length - 10} lainnya._`);
        } else {
          content.push("✅ Semua link saat ini dapat diakses dengan baik.");
        }

        if (recommendations.length > 0) {
          content.push("");
          content.push(`💡 **Rekomendasi**: Ada **${recommendations.length}** manga dengan kegagalan berturut-turut. Pertimbangkan untuk menghapusnya.`);
        }

        await editInteractionResponse(payload, content.join("\n"));
      } catch (err) {
        console.error("[handleHealth] Error:", err);
        await editInteractionResponse(payload, `❌ Gagal menjalankan audit: ${err.message}`);
      }
    })()
  );
}
