'use strict';

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }

  return res.status(200).json({
    ok: true,
    service: 'beting-dashboard',
    timestamp: new Date().toISOString()
  });
};
