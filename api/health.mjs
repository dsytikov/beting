'use strict';

const headers = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'Content-Type': 'application/json; charset=utf-8'
};

export default {
  async fetch(request) {
    if (request.method !== 'GET') {
      return Response.json(
        { ok: false, message: 'Method not allowed' },
        { status: 405, headers: { ...headers, Allow: 'GET' } }
      );
    }

    return Response.json({
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
    }, { status: 200, headers });
  }
};
