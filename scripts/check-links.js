import fs from 'fs';
import 'dotenv/config';
import { checkWhitelistLinks } from '../lib/services/linkCheckService.js';

async function run() {
  if (!fs.existsSync('whitelist.json')) {
    console.error('Error: whitelist.json missing');
    return;
  }

  const whitelist = JSON.parse(fs.readFileSync('whitelist.json', 'utf8'));
  console.log(`🚀 Checking ${whitelist.length} manga entries in whitelist.json...`);
  
  const report = await checkWhitelistLinks(whitelist);
  const results = report.allResults;
  const deadLinks = report.dead;
  const okCount = report.ok;

  console.log('\n====================================');
  console.log('🏁 FINAL REPORT');
  console.log('====================================');
  console.log(`✅ OK      : ${okCount}`);
  console.log(`❌ DEAD    : ${deadLinks.length}`);
  console.log(`📊 TOTAL   : ${results.length}`);
  console.log('====================================\n');

  if (deadLinks.length > 0) {
    console.log('List of Dead Links:');
    deadLinks.forEach(d => {
      const statusStr = d.status ? `[${d.status}]` : '[ERR]';
      console.log(`${statusStr.padEnd(7)} ${d.title.padEnd(40)} | ${d.source.padEnd(15)} | ${d.url}`);
    });
    
    // Suggest cleanup
    console.log(`\n💡 Tip: You can remove these links using '/remove <URL>' or by manually editing whitelist.json`);
  } else {
    console.log('✨ All links are active! Your whitelist is clean.');
  }
}

run().catch(err => console.error('Fatal:', err));
