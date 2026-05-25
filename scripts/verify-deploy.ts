/**
 * Deployment Verification Script
 * Usage: npx tsx scripts/verify-deploy.ts <deploy-url>
 */

import axios from "axios";

const targetUrl = process.argv[2];

if (!targetUrl) {
  console.error("❌ Error: Target URL is required.");
  console.log("Usage: npx tsx scripts/verify-deploy.ts <your-app-url>");
  process.exit(1);
}

const cleanUrl = targetUrl.replace(/\/+$/, "");
const healthUrl = `${cleanUrl}/api/healthz`;

async function verify() {
  console.log(`🔍 Verifying deployment at: ${cleanUrl}...`);
  console.log(`📡 Checking health endpoint: ${healthUrl}...`);

  try {
    const start = Date.now();
    const response = await axios.get(healthUrl, { timeout: 10000 });
    const duration = Date.now() - start;

    if (response.status === 200 && response.data.status === "ok") {
      console.log("\n✅ **Deployment Verified Successfully!**");
      console.log(`📊 Latency: ${duration}ms`);
      console.log(`🗄️  Redis: ${response.data.database}`);
      console.log(`⏰ Timestamp: ${response.data.timestamp}`);
      process.exit(0);
    } else {
      console.error("\n⚠️  **Health check returned non-ok status.**");
      console.error(`Status: ${response.status}`);
      console.error("Response:", response.data);
      process.exit(1);
    }
  } catch (err: any) {
    console.error("\n❌ **Deployment Verification Failed!**");
    if (err.response) {
      console.error(`Status Code: ${err.response.status}`);
      console.error("Response Data:", err.response.data);
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}

verify();
