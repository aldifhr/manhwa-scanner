import { fetchSecondaryMetadata } from "../lib/scrapers/secondary.js";

async function run() {
  const meta = await fetchSecondaryMetadata("shinigami_project", "the-rebel-of-the-tyrant-noble-family", null);
  console.log(JSON.stringify(meta, null, 2));
}

run().catch(console.error);
