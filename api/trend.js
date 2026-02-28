export default async function handler(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.secret;
  if (!token || token !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const now = Math.floor(Date.now() / (5 * 60 * 1000));

    // Buat semua key sekaligus
    const slots = Array.from({ length: 24 }, (_, i) => now - (23 - i));
    const keys = slots.map((slot) => `cron:trend:${slot}`);

    // ✅ 1x request ke Redis, ambil semua sekaligus
    const results = await redis.mget(...keys);

    const times = [];
    const sent = [];
    const skipped = [];
    const duration = [];

    slots.forEach((slot, i) => {
      const slotTime = new Date(slot * 5 * 60 * 1000);
      times.push(slotTime.toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit'
      }));

      const data = results[i] ?? { sent: 0, skipped: 0, duration: 0 };
      sent.push(data.sent || 0);
      skipped.push(data.skipped || 0);
      duration.push(data.duration || 0);
    });

    const totalDuration = duration.reduce((a, b) => a + b, 0);

    res.status(200).json({
      times,
      sent,
      skipped,
      duration,
      totalSent: sent.reduce((a, b) => a + b, 0),
      avgDuration: Math.round((totalDuration / 24) * 10) / 10
    });

  } catch (error) {
    console.error('Trend API error:', error);
    res.status(500).json({ error: 'Internal error', times: [], sent: [], skipped: [] });
  }
}