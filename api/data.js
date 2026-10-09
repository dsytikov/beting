'use strict';

const { buildData } = require('../scripts/build-data');

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedData = null;
let cachedAt = 0;
let inFlight = null;

async function refreshData() {
  if (inFlight) return inFlight;
  inFlight = buildData().then((data) => {
    cachedData = data;
    cachedAt = Date.now();
    return data;
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }

  try {
    const forceRefresh = req.method === 'POST' || req.query?.refresh === '1';
    let data;
    if (!forceRefresh && cachedData && Date.now() - cachedAt < CACHE_TTL_MS) {
      data = cachedData;
    } else {
      data = await refreshData();
    }
    return res.status(200).json(data);
  } catch (error) {
    console.error('[api/data] Refresh failed:', String(error?.message || error).slice(0, 300));
    return res.status(502).json({ ok: false, message: 'Не удалось получить данные от источников API.' });
  }
};
