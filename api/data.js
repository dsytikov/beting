'use strict';

const { buildData } = require('../scripts/build-data');

const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
let cachedData;
let cachedAt = 0;
let inFlight;

function sendJson(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(status).json(payload);
}

function requestWantsRefresh(req) {
  if (req.method === 'POST') return true;
  if (req.query && req.query.refresh === '1') return true;
  try {
    return new URL(req.url || '/', 'https://vercel.invalid').searchParams.get('refresh') === '1';
  } catch {
    return false;
  }
}

function safeMessage(error) {
  return String(error && error.message ? error.message : error)
    .replace(/https?:\/\/\S+/g, '[API URL]')
    .replace(/(?:token|apikey|api_key|authorization)[=: ]+[^\s&]+/ig, '[REDACTED]')
    .slice(0, 220);
}

function emptyResult(message) {
  const now = new Date().toISOString();
  return {
    date: now.slice(0, 10),
    generatedAt: now,
    sources: {
      bsd: { ok: false, count: 0, message },
      sstats: { ok: false, count: 0, message }
    },
    errors: [message],
    predictions: []
  };
}

async function refreshData() {
  if (!inFlight) {
    inFlight = Promise.resolve()
      .then(() => buildData())
      .then((data) => {
        if (!data || !Array.isArray(data.predictions) || !data.sources) {
          throw new Error('Data builder returned an invalid payload');
        }
        cachedData = data;
        cachedAt = Date.now();
        return data;
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  return inFlight;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { ok: false, message: 'Method not allowed' });
  }

  const forceRefresh = requestWantsRefresh(req);
  if (!forceRefresh && cachedData && Date.now() - cachedAt < CACHE_TTL_MS) {
    return sendJson(res, 200, cachedData);
  }

  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Data refresh exceeded 8 seconds')), REQUEST_TIMEOUT_MS);
    });
    const data = await Promise.race([refreshData(), timeout]);
    return sendJson(res, 200, data);
  } catch (error) {
    const message = safeMessage(error);
    console.error('[api/data] refresh failed:', message);

    if (cachedData) {
      return sendJson(res, 200, { ...cachedData, stale: true, refreshError: message });
    }
    return sendJson(res, 503, emptyResult(message));
  } finally {
    if (timer) clearTimeout(timer);
  }
};
