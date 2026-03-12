import { redis } from "../lib/redis.js";
import { logApiHit } from "../lib/requestLog.js";
import { prepareAuthorizedGet } from "../lib/api/getEndpoint.js";
import { SOURCE_COMPARE_CACHE_KEY, SOURCE_COMPARE_STATE_KEY } from "../lib/cacheKeys.js";
import {
  buildSourceCompareState,
  getSourceCompareHeadSignature,
  SOURCE_COMPARE_STATE_TTL_SEC,
} from "../lib/sourceCompareState.js";

const SOURCE_COMPARE_CACHE_SEC = Number(process.env.SOURCE_COMPARE_CACHE_SEC || 180);

export default async function handler(req, res) {
  logApiHit("source-compare", req);

  const prepared = prepareAuthorizedGet(req, res, {
    defaultCacheTtl: 180,
    rawCacheTtl: SOURCE_COMPARE_CACHE_SEC,
    maxAgeCap: 30,
  });
  if (!prepared) return;
  const { cacheTtl } = prepared;

  try {
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
