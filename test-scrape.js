import { readFileSync } from 'fs';
import { scrapeMangaUpdates } from './lib/scraper.js';

process.env.IKIRU_EMAIL = 'mirbless15@gmail.com';
process.env.IKIRU_PASSWORD = 'faraygod7crew';

async function verify() {
  const whitelist = JSON.parse(readFileSync('./whitelist.json'));
  const titles = whitelist.map(w => w.title.toLowerCase());
  
  console.log('Whitelist count:', titles.length);
  
  const updates = await scrapeMangaUpdates();
  const hits = updates.filter(u => 
    titles.some(t => u.title.toLowerCase().includes(t))
  );
  
  console.log('Scrape OK:', updates.length);
  console.log('Hits:', hits.length);
  console.log('Sample hit:', hits[0]?.title);
}

verify();
