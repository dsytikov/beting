'use strict';

const { buildData } = require('../scripts/build-data');

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedData = null;
let cachedAt = 0;
let inFlight = null;

function unavailableData(message) {
  const now = new Date();
  return {
    date: now.toISOString().slice(0, 10),
    generatedAt: now.toISOString(),
    sources: {
      bsd: { ok: false, count: 0, message },
      sstats: { ok: false, count: 0, message }
    },
    errors: [message],
    predictions: []
  };
}

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
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }

  const forceRefresh = req.method === 'POST' || req.query?.refresh === '1';
  if (!forceRefresh && cachedData && Date.now() - cachedAt < CACHE_TTL_MS) {
    return res.status(200).json(cachedData);
  }

  try {
    const data = await Promise.race([
      refreshData(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Источники данных не ответили за 8 секунд.')), 8000);
        timer.unref?.();
      })
    ]);
    return res.status(200).json(data);
  } catch (error) {
    const message = String(error?.message || error).slice(0, 220);
    console.error('[api/data] Refresh failed:', message);
    return res.status(200).json(cachedData || unavailableData(message));
  }
};
