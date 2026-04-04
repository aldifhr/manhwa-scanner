import crypto from 'crypto';

function linkStatsKey(url) {
  const hash = crypto.createHash('md5').update(url).digest('hex');
  return `health:stats:v2:${hash}`;
}

const u1 = 'https://d.shinigami.asia/series/0c2d8ca8-5c40-4be7-8750-eda292d3be51';
const u2 = 'https://d.shinigami.asia/series/dd8ac0a4-b6ec-4f46-842c-98871ea3dc43';

const k1 = linkStatsKey(u1);
const k2 = linkStatsKey(u2);

console.log('URL 1 Key:', k1);
console.log('URL 2 Key:', k2);

if (k1 === k2) {
  console.error('FAIL: Keys are still colliding!');
  process.exit(1);
} else {
  console.log('PASS: Keys are unique!');
}
