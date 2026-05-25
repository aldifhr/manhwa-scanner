import "dotenv/config";
import { loadWhitelist, redis } from "../lib/redis.js";
import { scrapeMangaUpdatesWithMeta } from "../lib/scrapers/orchestrator.js";
import { scrapeIkiruUpdatesWithMeta } from "../lib/scrapers/ikiru.js";
import { createWhitelistMatcher } from "../lib/domain.js";
import { buildDispatchChapterMeta, DISPATCH_HISTORY_KEY } from "../lib/services/dispatch.js";
import { CHAPTER_PENDING_TTL_SEC } from "../lib/config.js";

function parseClaim(raw: any) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function isBlockingClaim(claim: any, nowMs = Date.now()) {
  if (!claim?.status) return false;
  if (claim.status === "sent") return true;
  if (claim.status !== "pending") return true;
  const claimedAtMs = new Date(claim.claimedAt || "").getTime();
  if (!Number.isFinite(claimedAtMs)) return false;
  return nowMs - claimedAtMs < CHAPTER_PENDING_TTL_SEC * 1000;
}

function isWithin24h(updatedTime: string | number) {
  const ts = new Date(updatedTime || "").getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= 24 * 60 * 60 * 1000;
}

function toArrayHmget(keys: string[], result: any): any[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") return keys.map((k) => result[k]);
  return [];
}

async function main() {
  const incremental = process.env.TRACK_INCREMENTAL === "true";
  const skipExpansion = process.env.TRACK_SKIP_EXPANSION === "true";

  const whitelist = await loadWhitelist();
  const isMatched = createWhitelistMatcher(whitelist);

  const orchestrated = await scrapeMangaUpdatesWithMeta(redis, {
    deduplicate: true,
    incremental,
    skipExpansion,
  });
  let items = orchestrated?.items || [];
  let sourceMode = "orchestrator";
  if (!items.length) {
    const ikiruOnly = await scrapeIkiruUpdatesWithMeta(redis, {
      skipExpansion,
      startTime: Date.now(),
    });
    items = Array.isArray(ikiruOnly?.results) ? ikiruOnly.results : [];
    sourceMode = "ikiru_fallback";
  }

  const matched = items.filter(isMatched);
  const fresh = matched.filter((item) => isWithin24h(item.updatedTime));
  const meta = buildDispatchChapterMeta(fresh).filter((entry) => entry.key);

  const chapterKeys = meta.map((entry) => entry.key);
  const duplicateKeys = [...new Set(meta.map((entry) => entry.duplicateKey).filter(Boolean) as string[])];

  const [chapterStatesRaw, duplicateStatesRaw] = await Promise.all([
    chapterKeys.length ? redis.hmget(DISPATCH_HISTORY_KEY, ...chapterKeys) : [],
    duplicateKeys.length ? redis.hmget(DISPATCH_HISTORY_KEY, ...duplicateKeys) : [],
  ]);

  const chapterStates = toArrayHmget(chapterKeys, chapterStatesRaw).map(parseClaim);
  const duplicateStates = toArrayHmget(duplicateKeys, duplicateStatesRaw).map(parseClaim);
  const duplicateMap = new Map(duplicateKeys.map((k, i) => [k, duplicateStates[i] ?? null]));

  const blocked: any[] = [];
  const eligible: any[] = [];

  for (let i = 0; i < meta.length; i++) {
    const entry = meta[i];
    const byChapter = chapterStates[i] ?? null;
    const byDuplicate = entry.duplicateKey ? duplicateMap.get(entry.duplicateKey) : null;

    const blockedByChapter = isBlockingClaim(byChapter);
    const blockedByDuplicate = isBlockingClaim(byDuplicate);

    const row = {
      title: entry.item?.title,
      chapter: entry.item?.chapter,
      source: entry.item?.source,
      updatedTime: entry.item?.updatedTime,
      chapterKey: entry.key,
      duplicateKey: entry.duplicateKey,
      blockReason: blockedByChapter
        ? "chapter_key"
        : blockedByDuplicate
          ? "duplicate_key"
          : null,
    };

    if (blockedByChapter || blockedByDuplicate) blocked.push(row);
    else eligible.push(row);
  }

  console.log(
    JSON.stringify(
      {
        scanned: items.length,
        whitelist: whitelist.length,
        matched: matched.length,
        freshWithin24h: fresh.length,
        validForDispatch: meta.length,
        blocked: blocked.length,
        eligible: eligible.length,
        mode: { incremental, skipExpansion },
        sourceMode,
        blockedSample: blocked.slice(0, 20),
        eligibleSample: eligible.slice(0, 20),
      },
      null,
      2,
    ),
  );
}

main().catch((err: any) => {
  console.error("[track-fresh24h] failed:", err?.message || err);
  process.exit(1);
});
