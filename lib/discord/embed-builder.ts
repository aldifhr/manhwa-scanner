/**
 * Discord embed building for chapter updates
 */

import { getTimestampMs } from "../dateUtils.js";
import { getStatusColor } from "../scrapers/shared.js";
import {
  DISCORD_COMPONENT_TYPE,
  DISCORD_BUTTON_STYLE,
} from "../config.js";
import type { DiscordEmbedData, MangaMetadata } from "../types.js";
import { ratingStars, shortSynopsis, truncateTitle, normalizeChapterText } from "./formatting.js";
import { sourceMeta, normalizeSourceLabel, statusBar, getNormalizedStatus } from "./source.js";
import { ICON_BELL } from "./common.js";

/**
 * Build toast content for chapter notification
 */
export function buildToastContent({ title, chapter, type }: { title: unknown; chapter: unknown; type?: string }): string {
  const plainTitle = String(title || "Untitled")
    .replace(/\s+/g, " ")
    .trim();

  if (type === "report") {
    return ""; // No toast needed for reports as the embed title is enough
  }

  const normalizedChapter = normalizeChapterText(String(chapter || "Unknown"));
  const line = `${ICON_BELL} New Chapter: **${plainTitle}** • **${normalizedChapter}**`;
  return line.length > 180 ? `${line.slice(0, 177)}...` : line;
}

/**
 * Build rich Discord embed for chapter updates
 */
export function buildRichChapterEmbed(data: DiscordEmbedData, eventTimestamp: string): {
  title: string;
  url?: string;
  color: number;
  fields: { name: string; value: string; inline?: boolean }[];
  footer: { text: string };
  timestamp: string;
  description?: string;
  thumbnail?: { url: string };
} {
  const statusColor = getStatusColor(data.status);
  const source = sourceMeta(data.source);
  const sourceLabel = normalizeSourceLabel(data.source);
  const title = String(data.title || "Untitled").trim();
  const chapter = String(data.chapter || "Unknown").trim();

  const statusStr = data.status || "Unknown";
  const status = statusBar[statusStr] ?? "Unknown";
  const safeMangaUrl = String(data.mangaUrl || data.url || "").trim();
  const safeChapterUrl = String(data.url || data.mangaUrl || "").trim();

  const truncatedTitle = truncateTitle(title);
  const isReport = data.type === "report";

    const meta = data.metadata || {};
    const synopsis = data.description || meta.description || meta.synopsis || null;
    const synopsisText = shortSynopsis(synopsis);
    
    // Build fields array
    const fields: { name: string; value: string; inline?: boolean }[] = [];

    if (isReport) {
        // Cleaner fields for reports
        if (data.chapter && data.chapter !== "Unknown") {
            fields.push({ name: "📁 Category", value: `\`${data.chapter}\``, inline: true });
        }
        if (data.source && data.source !== "system") {
            fields.push({ name: "🔗 Origin", value: `\`${data.source}\``, inline: true });
        }
    } else {
        const statusStr = data.status || meta.status || "Unknown";
        const status = getNormalizedStatus(statusStr);
        const genres = data.genres || meta.genres || [];
        const genresText = Array.isArray(genres) && genres.length > 0
            ? genres.slice(0, 5).join(", ")
            : null;

        const ratingValue = (meta.rating !== undefined && meta.rating !== null) ? meta.rating : data.rating;
        const ratingDisplay = (ratingValue !== undefined && ratingValue !== null && ratingValue !== "" && ratingValue !== "N/A")
            ? ratingStars(ratingValue)
            : "`No rating`";

    // Chapter field
    fields.push({
        name: "📖 Chapter",
        value: `**${chapter}**`,
        inline: true,
    });

    // Source & Status (inline)
    fields.push({
        name: "🔗 Source",
        value: `\`${sourceLabel}\``,
        inline: true,
    });
    fields.push({
        name: "📊 Status",
        value: `\`${status}\``,
        inline: true,
    });

    // Genres if available
    if (genresText) {
        fields.push({
        name: "🏷️ Genres",
        value: `\`${genresText}\``,
        inline: false,
        });
    }

    // Rating
    fields.push({
        name: "⭐ Rating",
        value: ratingDisplay,
        inline: true,
    });
  }

  // Action buttons as text
  const actionParts: string[] = [];
  if (!isReport) {
    if (safeChapterUrl) {
        actionParts.push(`[📖 Read Chapter](${safeChapterUrl})`);
    }
    if (safeMangaUrl && safeMangaUrl !== safeChapterUrl) {
        actionParts.push(`[📚 Series Page](${safeMangaUrl})`);
    }
  }

  const actionLine = actionParts.length > 0
    ? `**Links:** ${actionParts.join(" • ")}`
    : "";

  if (!isReport) {
    // Parse release time for Discord timestamp
    const releaseTimeMs = getTimestampMs(data.updatedTime);
    const releaseUnix = Number.isFinite(releaseTimeMs) ? Math.floor(releaseTimeMs / 1000) : null;
    const releaseTimestamp = releaseUnix ? `<t:${releaseUnix}:R>` : "Unknown";
    const releaseFull = releaseUnix ? `<t:${releaseUnix}:F>` : "Unknown";

    // Add Release Time field (prominent)
    fields.unshift({
        name: "🕐 Released",
        value: `${releaseTimestamp} (${releaseFull})`,
        inline: false,
    });
  }

  // Footer
  const footerText = isReport ? "System Monitor" : `Source: ${sourceLabel}`;

  const embed: {
    title: string;
    url?: string;
    color: number;
    fields: { name: string; value: string; inline?: boolean }[];
    footer: { text: string };
    timestamp: string;
    description?: string;
    thumbnail?: { url: string };
  } = {
    title: truncatedTitle,
    url: isReport ? undefined : (safeMangaUrl || safeChapterUrl || undefined),
    color: isReport ? 0xFFA500 : (sourceMeta(data.source).color || statusColor),
    fields,
    footer: { text: footerText },
    timestamp: eventTimestamp,
  };

  // Add synopsis as description if available
  if (synopsisText && synopsisText.length > 0) {
    embed.description = synopsisText.trim() + (actionLine ? `\n${actionLine}` : "");
  } else if (actionLine) {
    embed.description = actionLine;
  }

  // Use thumbnail for cover image
  const coverUrl = data.cover || meta.cover || data.image || meta.image;
  if (coverUrl?.startsWith("http")) {
    embed.thumbnail = { url: coverUrl };
  }

  return embed;
}

/**
 * Build rich Discord embed for manga preview (used during addition)
 */
export function buildMangaPreviewEmbed(data: {
  title: string;
  source: string;
  mangaUrl?: string;
  metadata?: Partial<MangaMetadata>;
}, eventTimestamp: string): any {
  const meta = data.metadata || {};
  const statusColor = getStatusColor(meta.status || "Unknown");
  const sourceL = normalizeSourceLabel(data.source);
  
  const title = String(data.title || "Untitled").trim();
  const truncatedTitle = truncateTitle(title);
  
  const synopsis = meta.description || null;
  const synopsisText = shortSynopsis(synopsis);
  
  const status = getNormalizedStatus(meta.status || "Unknown");
  const genresText = Array.isArray(meta.genres) && meta.genres.length > 0
    ? meta.genres.slice(0, 5).join(", ")
    : null;

  const ratingDisplay = (meta.rating !== undefined && meta.rating !== null && meta.rating !== "" && meta.rating !== "N/A")
    ? ratingStars(meta.rating)
    : "`Belum ada rating`";

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: "🔗 Sumber", value: `\`${sourceL}\``, inline: true },
    { name: "📊 Status", value: `\`${status}\``, inline: true },
    { name: "⭐ Rating", value: ratingDisplay, inline: true },
  ];

  if (genresText) {
    fields.push({ name: "🏷️ Genre", value: `\`${genresText}\``, inline: false });
  }

  const embed: any = {
    title: `✅ ${truncatedTitle}`,
    url: data.mangaUrl,
    color: sourceMeta(data.source).color || statusColor,
    fields,
    footer: { text: `Ditambahkan ke Whitelist • ${sourceL}` },
    timestamp: eventTimestamp,
  };

  if (synopsisText) {
    embed.description = synopsisText;
  }

  const coverUrl = meta.cover;
  if (coverUrl?.startsWith("http")) {
    embed.thumbnail = { url: coverUrl };
  }

  return embed;
}

/**
 * Builds the interaction components for a chapter (Bookmark button)
 */
export function buildChapterComponents(title: string): unknown[] {
  return [
    {
      type: DISCORD_COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: DISCORD_COMPONENT_TYPE.BUTTON,
          style: DISCORD_BUTTON_STYLE.SUCCESS,
          label: "🔖 Bookmark",
          custom_id: `follow_toggle:${title.slice(0, 70)}`,
        },
      ],
    },
  ];
}
