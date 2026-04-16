import test from "node:test";
import assert from "node:assert/strict";
import { buildScrapeOptions } from "../lib/services/scrapePreferences.js";
import { getShinigamiPublicBase } from "../lib/domain.js";

const shigBase = getShinigamiPublicBase();

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
      shinigami_project: [`${shigBase}/series/lookism/`],
      shinigami_mirror: [`${shigBase}/series/wind-breaker/`],
    },
    preferredSecondaryEntries: {
      shinigami_project: [
        {
          title: "Lookism",
          url: `${shigBase}/series/lookism/`,
        },
      ],
      shinigami_mirror: [
        {
          title: "Wind Breaker",
          url: `${shigBase}/series/wind-breaker/`,
        },
      ],
    },
  });
});
