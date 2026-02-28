import redis from '../lib/redis';

export const config = { api: { bodyParser: false } };
export default async function handler(req, res) {
  // Auth Bearer check (sama kayak cron.js)
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const times = [];
    const sent = [];
    const skipped = [];
    const duration = [];

    // Last 24 runs (2 jam, 5min intervals)
    for (let i = 23; i >= 0; i--) {
      const timeLabel = `${i * 5}' ago`;
      const minuteSlot = Math.floor(Date.now() / (5 * 60 * 1000)) - i;
      const key = `cron:trend:${minuteSlot}`;

      times.push(timeLabel);

      try {
        const stat = await redis.get(key);
        const data = stat ? JSON.parse(stat) : { sent: 0, skipped: 0, duration: 0 };
        sent.push(data.sent || 0);
        skipped.push(data.skipped || 0);
        duration.push(data.duration || 0);
      } catch (e) {
        sent.push(0);
        skipped.push(0);
        duration.push(0);
      }
    }

    res.status(200).json({
      times,
      sent,
      skipped,
      duration,
      totalSent: sent.reduce((a, b) => a + b, 0),
      avgDuration: Math.round(duration.reduce((a, b) => a + b, 0) / 24 * 10) / 10
    });

  } catch (error) {
    console.error('Trend API error:', error);
    res.status(500).json({ error: 'Internal error', times: [], sent: [], skipped: [] });
  }
}
