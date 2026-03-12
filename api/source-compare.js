import { redis } from "../lib/redis.js";
import { isCronAuthorized } from "../lib/auth.js";
import { logApiHit } from "../lib/requestLog.js";
import { SOURCE_COMPARE_CACHE_KEY, SOURCE_COMPARE_STATE_KEY } from "../lib/cacheKeys.js";
import {
  buildSourceCompareState,
  getSourceCompareHeadSignature,
  SOURCE_COMPARE_STATE_TTL_SEC,
} from "../lib/sourceCompareState.js";

const SOURCE_COMPARE_CACHE_SEC = Number(process.env.SOURCE_COMPARE_CACHE_SEC || 180);

export default async function handler(req, res) {
  logApiHit("source-compare", req);

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isCronAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const cacheTtl = Number.isFinite(SOURCE_COMPARE_CACHE_SEC) && SOURCE_COMPARE_CACHE_SEC > 0
      ? Math.floor(SOURCE_COMPARE_CACHE_SEC)
      : 180;
    res.setHeader(
      "Cache-Control",
      `private, max-age=${Math.min(cacheTtl, 30)}, stale-while-revalidate=${cacheTtl}`,
    );
    const cached = await redis.get(SOURCE_COMPARE_CACHE_KEY);
    if (cached && typeof cached === "object") {
      return res.status(200).json(cached);
    }

    const state = await redis.get(SOURCE_COMPARE_STATE_KEY);
    let payload = state?.payload ?? null;
    const [headEntries, recentCountRaw] = await Promise.all([
      redis.lrange("recent:chapters", 0, 4),
      redis.llen("recent:chapters"),
    ]);
    const recentHead = Array.isArray(headEntries) ? headEntries.filter(Boolean) : [];
    const headSignature = getSourceCompareHeadSignature(recentHead);
    const recentCount = Number.isFinite(Number(recentCountRaw))
      ? Number(recentCountRaw)
      : recentHead.length;
    const stateMatchesRecent =
      typeof state?.headSignature === "string" &&
      state.headSignature === headSignature &&
      Number(state?.recentCount ?? -1) === recentCount &&
      (recentHead.length > 0 || recentCount === 0);

    if (!payload || typeof payload !== "object" || !stateMatchesRecent) {
      const raw = await redis.lrange("recent:chapters", 0, 199);
      const entries = Array.isArray(raw) ? raw.filter(Boolean) : [];
      const nextState = buildSourceCompareState(entries);
      payload = nextState.payload;
      await redis
        .set(SOURCE_COMPARE_STATE_KEY, nextState, { ex: SOURCE_COMPARE_STATE_TTL_SEC })
        .catch(() => {});
    }

    await redis.set(SOURCE_COMPARE_CACHE_KEY, payload, { ex: cacheTtl }).catch(() => {});
    return res.status(200).json(payload);
  } catch (err) {
    console.error("[source-compare] Error:", err);
    return res.status(500).json({
      error: "Internal error",
      summary: { totalCompared: 0, ikiruWins: 0, shinigamiWins: 0, ties: 0 },
      sourceCounts: { ikiru: 0, shinigami_project: 0, shinigami_mirror: 0 },
      comparisons: [],
    });
  }
}
