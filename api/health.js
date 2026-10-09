'use strict';

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, message: 'Method not allowed' }));
  }

  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: true,
    service: 'beting-dashboard',
    runtime: 'nodejs',
    node: process.version,
    deployment: {
      url: process.env.VERCEL_URL || null,
      environment: process.env.VERCEL_ENV || null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null
    },
    env: {
      BSD_TOKEN: Boolean(process.env.BSD_TOKEN),
      SSTATS_TOKEN: Boolean(process.env.SSTATS_TOKEN)
    },
    timestamp: new Date().toISOString()
  }));
};
