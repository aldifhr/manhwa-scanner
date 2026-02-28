// test-info.js
import { searchIkiru, fetchDescription } from "./lib/scraper.js";

const title = "one piece"; // ganti sesuai yang mau ditest

const results = await searchIkiru(title);
console.log("Results:", JSON.stringify(results.slice(0, 3), null, 2));

if (results.length) {
  const desc = await fetchDescription(results[0].url);
  console.log("Description:", desc);
}