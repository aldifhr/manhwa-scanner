import { httpGet } from "../httpClient.js";
import { redis, loadWhitelist } from "../redis.js";

/**
 * Checks all URLs in the whitelist and identifies broken links.
 * Returns an array of broken items.
 */
export async function performHealthCheck() {
  const whitelist = await loadWhitelist();
  const data = [];
  
  // Flatten sources from nested whitelist to check each URL
  for (const item of whitelist) {
    if (item.sources) {
      for (const s of item.sources) {
        if (s.url) {
          data.push({ title: item.title, url: s.url });
        }
      }
    }
  }

  const brokenLinks = [];
  console.log(`🔍 Starting health check for ${data.length} sources...`);

  const batchSize = 10; // Increased batch size
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    
    await Promise.all(
      batch.map(async (item) => {
        if (!item.url) return;
        
        try {
          // We use httpGet which already has retry logic from httpClient.js
          const response = await httpGet(item.url, { 
            timeout: 10000,
            headers: { "User-Agent": "Mozilla/5.0 (IkiruBot HealthCheck)" } 
          });
          
          if (response.status >= 400) {
            brokenLinks.push({ 
              title: item.title, 
              url: item.url, 
              status: response.status 
            });
          }
        } catch (err) {
          const status = err.response?.status || "ERR";
          // Only count as broken if it's a definitive error (like 404 or 500)
          // or if the request totally failed.
          if (status === 404 || status === 410 || status === "ERR") {
            brokenLinks.push({ 
              title: item.title, 
              url: item.url, 
              status 
            });
          }
        }
      })
    );
    
    // Small delay between batches
    if (i + batchSize < data.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Save results to Redis for the /health command
  await redis.set("health:broken-links", brokenLinks);
  await redis.set("health:last-check", new Date().toISOString());

  console.log(`✅ Health check finished. Found ${brokenLinks.length} broken links.`);
  return brokenLinks;
}
