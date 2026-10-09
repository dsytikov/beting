#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 10000);
const DATA_FILE = path.join(__dirname, 'data.json');
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const MAX_DATA_AGE_MS = REFRESH_INTERVAL_MS;
let activeRefresh = null;
let lastRefreshStarted = 0;

function runBuilder() {
  if (activeRefresh) return activeRefresh;
  lastRefreshStarted = Date.now();
  activeRefresh = new Promise((resolve) => {
    console.log('[data] Starting API refresh');
    const child = spawn(process.execPath, [path.join(__dirname, 'scripts', 'build-data.js')], {
      cwd: __dirname,
      env: process.env,
      stdio: 'inherit'
    });
    child.on('error', (error) => {
      console.error('[data] Could not start builder:', error.message);
      resolve({ ok: false, message: 'Не удалось запустить сборщик данных.' });
    });
    child.on('close', (code) => {
      console.log(`[data] Builder finished with exit code ${code}`);
      resolve({ ok: code === 0, exitCode: code });
    });
  }).finally(() => {
    activeRefresh = null;
  });
  return activeRefresh;
}

async function readData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    let data;
    try { data = JSON.parse(raw); } catch { return { data: null, stale: true }; }
    const generatedAt = Date.parse(data.generatedAt || '');
    const stale = !Number.isFinite(generatedAt) || Date.now() - generatedAt > MAX_DATA_AGE_MS;
    return { data, stale };
  } catch {
    return { data: null, stale: true };
  }
}

async function sendFile(response, filename, contentType, cacheControl = 'no-cache') {
  try {
    const content = await fs.readFile(path.join(__dirname, filename));
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' });
    response.end(content);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(payload));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  const pathname = url.pathname;

  if (request.method === 'GET' && pathname === '/healthz') {
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'POST' && pathname === '/api/refresh') {
    if (activeRefresh) {
      const result = await activeRefresh;
      return sendJson(response, 200, result);
    }
    if (Date.now() - lastRefreshStarted < 30_000) {
      return sendJson(response, 429, { ok: false, message: 'Подождите 30 секунд перед следующим обновлением.' });
    }
    const result = await runBuilder();
    return sendJson(response, 200, result);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD, POST', 'Content-Type': 'text/plain; charset=utf-8' });
    return response.end('Method not allowed');
  }

  if (pathname === '/data.json') {
    const current = await readData();
    if (current.stale) {
      if (activeRefresh) await activeRefresh;
      else if (Date.now() - lastRefreshStarted >= 30_000) await runBuilder();
    }
    return sendFile(response, 'data.json', 'application/json; charset=utf-8', 'no-store');
  }

  if (pathname === '/' || pathname === '/index.html') {
    return sendFile(response, 'index.html', 'text/html; charset=utf-8');
  }
  if (pathname === '/app.js') return sendFile(response, 'app.js', 'text/javascript; charset=utf-8');
  if (pathname === '/styles.css') return sendFile(response, 'styles.css', 'text/css; charset=utf-8');

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Football dashboard listening on 0.0.0.0:${PORT}`);
  void runBuilder();
  setInterval(() => { void runBuilder(); }, REFRESH_INTERVAL_MS).unref();
});
