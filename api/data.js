'use strict';

const { buildData } = require('../scripts/build-data');

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedData = null;
let cachedAt = 0;
let inFlight = null;

function json(res, status, payload) {
  return res.status(status).json(payload);
}

async function refreshData() {
  if (!inFlight) {
    inFlight = buildData()
      .then((data) => {
        cachedData = data;
        cachedAt = Date.now();
        return data;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { ok: false, message: 'Method not allowed' });
  }

  const forceRefresh = req.method === 'POST' || req.query?.refresh === '1';

  if (!forceRefresh && cachedData && Date.now() - cachedAt < CACHE_TTL_MS) {
    return json(res, 200, cachedData);
  }

  let timer;
  try {
    const data = await Promise.race([
      refreshData(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Data sources timed out after 8 seconds')), 8000);
      })
    ]);
    return json(res, 200, data);
  } catch (error) {
    const message = String(error?.message || error).replace(/https?:\/\/\S+/g, '[API URL]').slice(0, 220);
    console.error('[api/data] refresh failed:', message);

    if (cachedData) {
      return json(res, 200, { ...cachedData, stale: true, refreshError: message });
    }
    return json(res, 503, {
      date: new Date().toISOString().slice(0, 10),
      generatedAt: new Date().toISOString(),
      sources: {
        bsd: { ok: false, count: 0, message },
        sstats: { ok: false, count: 0, message }
      },
      errors: [message],
      predictions: []
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
};
