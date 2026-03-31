import axios from 'axios';
import pLimit from 'p-limit';

const CONCURRENCY_LIMIT = 5;

/**
 * Mendapatkan status kesehatan satu link URL.
 */
export async function checkSingleLink(url) {
  const headers = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
  };

  try {
    // Coba HEAD dahulu untuk efisiensi
    const res = await axios.head(url, { 
      timeout: 10000,
      headers,
      validateStatus: (status) => status < 400
    });
    return { url, status: res.status, ok: true };
  } catch {
    // Jika HEAD gagal (beberapa site blokir HEAD), coba GET
    try {
        const res = await axios.get(url, { 
            timeout: 15000, 
            headers,
            validateStatus: (status) => true
        });
        const isOk = res.status >= 200 && res.status < 400;
        return { url, status: res.status, ok: isOk };
    } catch (e) {
        return { url, status: e.code || 'TIMEOUT/ERROR', ok: false, message: e.message };
    }
  }
}

/**
 * Mengecek kesehatan semua link dalam whitelist.
 * Menggunakan p-limit untuk mengelola concurrency.
 */
export async function checkWhitelistLinks(whitelist) {
  if (!Array.isArray(whitelist)) return { total: 0, ok: 0, dead: [], results: [] };

  const allLinks = [];
  whitelist.forEach(item => {
    item.sources?.forEach(s => {
      if (s.url) {
        allLinks.push({ 
          title: item.title, 
          url: s.url, 
          source: s.source 
        });
      }
    });
  });

  const limit = pLimit(CONCURRENCY_LIMIT);
  const results = await Promise.all(
    allLinks.map(link => limit(async () => {
      const res = await checkSingleLink(link.url);
      return { ...link, ...res };
    }))
  );

  const dead = results.filter(r => !r.ok);

  return {
    total: results.length,
    ok: results.length - dead.length,
    dead,
    allResults: results
  };
}
