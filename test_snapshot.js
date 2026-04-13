import { fetchDashboardSnapshot } from "./lib/redis.js";
fetchDashboardSnapshot().then(res => {
  console.log("Queue length:", res.queueLength);
  console.log("Queue items:", JSON.stringify(res.queueItems, null, 2));
  process.exit(0);
}).catch(console.error);
