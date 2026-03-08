import assert from "node:assert/strict";

const SOURCE_FAILURE_THRESHOLD = 3;
const SOURCE_COOLDOWN_SECONDS = 1800;
const MANGA_HISTORY_LIMIT = 20;
const VERBOSE = process.argv.includes("--verbose");

function vLog(...args) {
  if (!VERBOSE) return;
  console.log(...args);
}

function defaultSourceHealth(source) {
  return {
    source,
    status: "healthy",
    consecutiveFailures: 0,
    disabledUntil: null,
    lastError: null,
    lastSuccessAt: null,
    lastCheckedAt: null,
  };
}

function isSourceInCooldown(health, nowMs = Date.now()) {
  if (!health?.disabledUntil) return false;
  const disabledMs = new Date(health.disabledUntil).getTime();
  return Number.isFinite(disabledMs) && disabledMs > nowMs;
}

function applySourceOutcome(current, outcome, nowIso) {
  const next = { ...current, lastCheckedAt: nowIso };
  const outcomeStatus = outcome?.status || "ok";

  if (outcomeStatus === "error") {
    const failures = Number(next.consecutiveFailures || 0) + 1;
    const isDegraded = failures >= SOURCE_FAILURE_THRESHOLD;
    next.consecutiveFailures = failures;
    next.status = isDegraded ? "degraded" : "healthy";
    next.lastError = outcome.error || "unknown error";
    next.disabledUntil = isDegraded
      ? new Date(Date.now() + SOURCE_COOLDOWN_SECONDS * 1000).toISOString()
      : null;
    return next;
  }

  if (outcomeStatus === "ok") {
    next.status = "healthy";
    next.consecutiveFailures = 0;
    next.disabledUntil = null;
    next.lastError = null;
    next.lastSuccessAt = nowIso;
    return next;
  }

  if (next.status === "degraded" && !isSourceInCooldown(next)) {
    next.status = "healthy";
    next.consecutiveFailures = 0;
    next.disabledUntil = null;
    next.lastError = null;
  }
  return next;
}

function normalizeSource(source) {
  const s = String(source || "").toLowerCase().trim();
  if (s === "mirror" || s === "shinigami_mirror") return "shinigami_mirror";
  if (s === "shinigami" || s === "project" || s === "shinigami_project") {
    return "shinigami_project";
  }
  return "ikiru";
}

function normalizeUrl(u) {
  return String(u || "")
    .replace(/\/+$/, "")
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\/(?:www\.)?shngm\.id\b/, "https://a.shinigami.asia")
    .replace(/^https?:\/\/(?:www\.)?shinigami\.asia\b/, "https://a.shinigami.asia");
}

function normalizeTitle(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildMangaHistoryKey(item) {
  const source = normalizeSource(item?.source);
  const mangaUrl = normalizeUrl(item?.mangaUrl || "");
  if (mangaUrl) return `history:manga:${source}:${mangaUrl}`;

  const title = normalizeTitle(item?.title || "");
  if (!title) return null;
  return `history:manga:${source}:title:${title}`;
}

function buildChapterHistoryRef(item) {
  const chapterUrl = normalizeUrl(item?.url || "");
  if (chapterUrl) return chapterUrl;

  const chapter = String(item?.chapter || "").trim();
  const updated = String(item?.updatedTime || "").trim();
  if (!chapter && !updated) return null;
  return `${chapter}|${updated}`;
}

class FakeRedis {
  constructor() {
    this.listStore = new Map();
  }

  async lrange(key, start, end) {
    const arr = this.listStore.get(key) || [];
    return arr.slice(start, end + 1);
  }

  async lpush(key, value) {
    const arr = this.listStore.get(key) || [];
    arr.unshift(value);
    this.listStore.set(key, arr);
  }

  async ltrim(key, start, end) {
    const arr = this.listStore.get(key) || [];
    this.listStore.set(key, arr.slice(start, end + 1));
  }

  async expire() {
    return 1;
  }
}

async function saveMangaHistory(redis, item) {
  const key = buildMangaHistoryKey(item);
  const chapterRef = buildChapterHistoryRef(item);
  if (!key || !chapterRef) return;

  const current = await redis.lrange(key, 0, MANGA_HISTORY_LIMIT - 1);
  if (current.includes(chapterRef)) {
    await redis.expire(key, 60);
    return;
  }

  await Promise.all([
    redis.lpush(key, chapterRef),
    redis.ltrim(key, 0, MANGA_HISTORY_LIMIT - 1),
    redis.expire(key, 60),
  ]);
}

async function run() {
  const nowIso = new Date().toISOString();

  let health = defaultSourceHealth("shinigami_mirror");
  vLog("[health:init]", health);

  health = applySourceOutcome(health, { status: "error", error: "timeout" }, nowIso);
  assert.equal(health.status, "healthy");
  assert.equal(health.consecutiveFailures, 1);
  vLog("[health:after error#1]", health);

  health = applySourceOutcome(health, { status: "error", error: "timeout" }, nowIso);
  assert.equal(health.status, "healthy");
  assert.equal(health.consecutiveFailures, 2);
  vLog("[health:after error#2]", health);

  health = applySourceOutcome(health, { status: "error", error: "timeout" }, nowIso);
  assert.equal(health.status, "degraded");
  assert.ok(health.disabledUntil, "disabledUntil should exist after threshold reached");
  vLog("[health:after error#3 degraded]", health);

  const stillCooldown = applySourceOutcome(health, { status: "skipped" }, nowIso);
  assert.equal(stillCooldown.status, "degraded");
  vLog("[health:skipped while cooldown]", stillCooldown);

  const recovered = applySourceOutcome(health, { status: "ok" }, nowIso);
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.disabledUntil, null);
  vLog("[health:recovered by ok]", recovered);

  const redis = new FakeRedis();
  for (let i = 1; i <= 25; i++) {
    await saveMangaHistory(redis, {
      source: "shinigami_mirror",
      mangaUrl: "https://a.shinigami.asia/series/abc",
      url: `https://a.shinigami.asia/chapter/${i}`,
      chapter: `Chapter ${i}`,
      updatedTime: `2026-03-08T11:${String(i).padStart(2, "0")}:00Z`,
    });
  }
  vLog("[history:inserted]", "chapter 1..25");

  const key = "history:manga:shinigami_mirror:https://a.shinigami.asia/series/abc";
  const saved = await redis.lrange(key, 0, 99);
  assert.equal(saved.length, 20, "history should keep only the latest 20 entries");
  assert.equal(saved[0], "https://a.shinigami.asia/chapter/25");
  assert.equal(saved[19], "https://a.shinigami.asia/chapter/6");
  vLog("[history:window-size]", saved.length);
  vLog("[history:head]", saved[0]);
  vLog("[history:tail]", saved[19]);

  await saveMangaHistory(redis, {
    source: "shinigami_mirror",
    mangaUrl: "https://a.shinigami.asia/series/abc",
    url: "https://a.shinigami.asia/chapter/25",
    chapter: "Chapter 25",
    updatedTime: "2026-03-08T11:25:00Z",
  });
  const afterDuplicate = await redis.lrange(key, 0, 99);
  assert.equal(afterDuplicate.length, 20, "duplicate chapter must not increase history size");
  vLog("[history:after-duplicate-size]", afterDuplicate.length);
  vLog("[history:first-5]", afterDuplicate.slice(0, 5));
  vLog("[history:last-5]", afterDuplicate.slice(-5));

  console.log("PASS test-local-health-history");
}

run().catch((err) => {
  console.error("FAIL test-local-health-history:", err.message);
  process.exit(1);
});
