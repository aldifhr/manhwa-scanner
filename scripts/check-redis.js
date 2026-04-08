import { redis } from "../lib/redis.js";

async function checkRedis() {
  const mangaId = "8016654b-7b26-4bc2-be36-bf1b5dd92fe1";

  // Check shinigami cache after timeout fix
  const cachedChapters = await redis.get(`shinigami:chapters:${mangaId}`);
  console.log("Cached chapters for", mangaId);
  console.log(cachedChapters ? JSON.parse(cachedChapters) : "No cache");

  // Also check the shinigami update list cache
  const updateCache = await redis.keys("shinigami:*");
  console.log("\nAll shinigami cache keys:", updateCache);

  process.exit(0);
}

checkRedis().catch((err) => {
  console.error(err);
  process.exit(1);
});
