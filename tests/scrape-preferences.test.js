import test from "node:test";
import assert from "node:assert/strict";
import { buildScrapeOptions } from "../lib/services/scrapePreferences.js";

test("buildScrapeOptions keeps manual and cron scrape preferences aligned", () => {
  const options = buildScrapeOptions([
    { title: "Nano Machine", source: "ikiru" },
    { title: "Lookism", source: "shinigami_project" },
    { title: "Wind Breaker", source: "shinigami_mirror" },
  ]);

  assert.deepEqual(options, {
    preferredIkiruTitles: ["Nano Machine"],
    preferredSecondaryTitles: {
      shinigami_project: ["Lookism"],
      shinigami_mirror: ["Wind Breaker"],
    },
  });
});
