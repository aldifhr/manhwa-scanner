import test from "node:test";
import assert from "node:assert/strict";
import { buildScrapeOptions } from "../lib/services/scrapePreferences.js";

test("buildScrapeOptions keeps manual and cron scrape preferences aligned", () => {
  const options = buildScrapeOptions([
    { title: "Nano Machine", source: "ikiru" },
    {
      title: "Lookism",
      source: "shinigami_project",
      url: "https://shngm.id/series/lookism/",
    },
    {
      title: "Wind Breaker",
      source: "shinigami_mirror",
      url: "https://a.shinigami.asia/series/wind-breaker/",
    },
  ]);

  assert.deepEqual(options, {
    preferredIkiruTitles: ["Nano Machine"],
    preferredSecondaryTitles: {
      shinigami_project: ["Lookism"],
      shinigami_mirror: ["Wind Breaker"],
    },
    preferredSecondaryUrls: {
      shinigami_project: ["https://a.shinigami.asia/series/lookism"],
      shinigami_mirror: ["https://a.shinigami.asia/series/wind-breaker"],
    },
  });
});
