import "dotenv/config";
import { httpGet } from "../lib/httpClient.js";

async function test() {
  const testUrl = "https://02.ikiru.wtf/manga/lookism/";
  try {
    console.log("Testing:", testUrl);
    const res = await httpGet(testUrl, { timeout: 5000 });
    console.log("Status:", res.status);
  } catch (err) {
    console.error("Error:", err.message);
    if (err.response) console.log("Response status:", err.response.status);
  }
}

test();
