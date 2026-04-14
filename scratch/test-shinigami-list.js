const API_BASE = "https://a.shinigami.asia/api";
import https from "https";

export async function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function check() {
  const url = `${API_BASE}/v1/manga/list?type=all&page=1&page_size=3&is_update=true&sort=latest&sort_order=desc`;
  const data = await httpGet(url);
  console.log(JSON.stringify(data.data[0], null, 2));
}

check().catch(console.error);
