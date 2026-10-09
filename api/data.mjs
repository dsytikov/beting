'use strict';

import buildDataModule from '../scripts/build-data.js';

const { buildData } = buildDataModule;
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
  inFlight = buildData().then((result) => {
    cachedData = result;
    cachedAt = Date.now();
    return result;
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Type': 'application/json; charset=utf-8'
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method !== 'GET' && request.method !== 'POST') {
      return Response.json(
        { ok: false, message: 'Method not allowed' },
        { status: 405, headers: { ...headers, Allow: 'GET, POST' } }
      );
    }

    const forceRefresh = request.method === 'POST' || url.searchParams.get('refresh') === '1';
    if (!forceRefresh && cachedData && Date.now() - cachedAt < CACHE_TTL_MS) {
      return Response.json(cachedData, { status: 200, headers });
    }

    try {
      const timeout = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Источники данных не ответили за 8 секунд.')), 8000);
        timer.unref?.();
      });
      const result = await Promise.race([refreshData(), timeout]);
      return Response.json(result, { status: 200, headers });
    } catch (error) {
      const message = String(error?.message || error).slice(0, 220);
      console.error('[api/data] Refresh failed:', message);
      return Response.json(cachedData || unavailableData(message), { status: 200, headers });
    }
  }
};
