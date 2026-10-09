'use strict';

const assert = require('node:assert/strict');

function responseMock() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = value || ''; this.payload = this.body ? JSON.parse(this.body) : null; return this; }
  };
}

async function main() {
  const health = require('../api/health');
  const data = require('../api/data');

  const healthRes = responseMock();
  health({ method: 'GET' }, healthRes);
  assert.equal(healthRes.statusCode, 200);
  assert.equal(healthRes.payload.ok, true);
  assert.equal(healthRes.payload.runtime, 'nodejs');

  const methodRes = responseMock();
  health({ method: 'POST' }, methodRes);
  assert.equal(methodRes.statusCode, 405);
  assert.equal(methodRes.payload.ok, false);

  const oldBsd = process.env.BSD_TOKEN;
  const oldSstats = process.env.SSTATS_TOKEN;
  delete process.env.BSD_TOKEN;
  delete process.env.SSTATS_TOKEN;

  try {
    const dataRes = responseMock();
    await data({ method: 'GET', query: {} }, dataRes);
    assert.equal(dataRes.statusCode, 200);
    assert.ok(Array.isArray(dataRes.payload.predictions));
    assert.equal(dataRes.payload.sources.bsd.ok, false);
    assert.equal(dataRes.payload.sources.sstats.ok, false);
    assert.ok(Array.isArray(dataRes.payload.errors));

    const dataMethodRes = responseMock();
    await data({ method: 'PUT', query: {} }, dataMethodRes);
    assert.equal(dataMethodRes.statusCode, 405);
  } finally {
    if (oldBsd === undefined) delete process.env.BSD_TOKEN;
    else process.env.BSD_TOKEN = oldBsd;
    if (oldSstats === undefined) delete process.env.SSTATS_TOKEN;
    else process.env.SSTATS_TOKEN = oldSstats;
  }

  console.log('Smoke tests passed: native Node API responses and source-error JSON are valid.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
