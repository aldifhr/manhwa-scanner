import axios from "axios";
import "dotenv/config";

const BASE_URL = "http://localhost:3000";
const CRON_SECRET = process.env.CRON_SECRET;
const WORKER_TOKEN = process.env.WORKER_TOKEN;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

let dashboardCookie = null;

async function runTest(name, url, method = "GET", data = null, useSession = false) {
  console.log(`\n>>> Testing: ${name}...`);
  const start = Date.now();
  try {
    const config = {
      method,
      url: `${BASE_URL}${url}`,
      headers: {
        "Authorization": `Bearer ${CRON_SECRET}`,
      },
      data: data || (method === "POST" ? {} : undefined),
    };

    if (useSession && dashboardCookie) {
      config.headers["Cookie"] = dashboardCookie;
    }

    if (method === "POST") {
      config.headers["Content-Type"] = "application/json";
    }

    // Add specific auth for worker if needed
    if (url.includes("/api/worker")) {
      config.headers["Authorization"] = WORKER_TOKEN;
      config.url = `${BASE_URL}${url}${url.includes("?") ? "&" : "?"}token=${WORKER_TOKEN}`;
    }

    const response = await axios(config);
    const duration = Date.now() - start;

    console.log(`[PASS] ${name} | Latency: ${duration}ms | Status: ${response.status}`);

    if (response.data?.data?.timingMetrics) {
      console.log("--- Internal Metrics ---");
      console.table(response.data.data.timingMetrics);
    } else if (response.data?.duration) {
      console.log(`  Reported internal duration: ${response.data.duration}`);
    }

    return { name, duration, status: response.status, data: response.data };
  } catch (err) {
    const duration = Date.now() - start;
    console.error(`[FAIL] ${name} | Latency: ${duration}ms | Error: ${err.message}`);
    if (err.response) {
      console.error("Response data:", JSON.stringify(err.response.data, null, 2));
    }
    return { name, duration, status: err.response?.status || 500, error: err.message };
  }
}

async function login() {
  console.log("\n>>> Logging into Dashboard...");
  try {
    const response = await axios.post(`${BASE_URL}/api/auth?action=login`, {
      password: DASHBOARD_PASSWORD,
    });
    const setCookie = response.headers["set-cookie"];
    if (setCookie) {
      dashboardCookie = setCookie[0].split(";")[0];
      console.log("[PASS] Login successful");
      return true;
    }
    console.error("[FAIL] Login failed: No cookie returned");
    return false;
  } catch (err) {
    console.error(`[FAIL] Login failed: ${err.message}`);
    return false;
  }
}

async function main() {
  if (!CRON_SECRET) {
    console.error("Missing CRON_SECRET in .env");
    process.exit(1);
  }

  const results = [];

  // 1. Cron Update (Normal)
  results.push(await runTest("Cron Update (Normal)", "/api/cron?action=update&mode=normal", "POST"));

  // 2. Cron Update (Fast)
  results.push(await runTest("Cron Update (Fast)", "/api/cron?action=update&mode=fast", "POST"));

  // 3. Cron Update (Full)
  results.push(await runTest("Cron Update (Full)", "/api/cron?action=update&mode=full", "POST"));

  // 4. Worker (Queue processing)
  results.push(await runTest("Worker Dispatch", "/api/worker"));

  // 5. Cron Health (Link validation - usually slow)
  results.push(await runTest("Health Check", "/api/cron?action=health", "GET"));

  // 6. Dashboard APIs (Require Login)
  if (await login()) {
    results.push(await runTest("Auth Status", "/api/auth?action=status", "GET", null, true));
    results.push(await runTest("Dashboard Snapshot", "/api/dashboard-snapshot", "GET", null, true));
    results.push(await runTest("History", "/api/history", "GET", null, true));
    results.push(await runTest("Health Status", "/api/health-status", "GET", null, true));
    results.push(await runTest("Notices", "/api/notices", "GET", null, true));
  }

  console.log("\n\n" + "=".repeat(40));
  console.log("FINAL PERFORMANCE SUMMARY");
  console.log("=".repeat(40));
  console.table(results.map(r => ({
    Scenario: r.name,
    Latency: `${r.latency ?? r.duration}ms`,
    Status: r.status,
    InternalMsg: r.data?.data?.outcome || r.data?.error?.message || "OK",
  })));

  console.log("\nDetailed timing metrics captured in results.");
}

main().catch(console.error);
