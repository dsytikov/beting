'use strict';

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }
  return res.status(200).json({
    ok: true,
    runtime: 'nodejs',
    node: process.version,
    env: {
      BSD_TOKEN: Boolean(process.env.BSD_TOKEN),
      SSTATS_TOKEN: Boolean(process.env.SSTATS_TOKEN)
    },
    timestamp: new Date().toISOString()
  });
};
