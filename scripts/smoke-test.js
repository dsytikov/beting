'use strict';

const assert = require('node:assert/strict');

async function main() {
  const { default: health } = await import('../api/health.mjs');
  const { default: data } = await import('../api/data.mjs');

  const healthResponse = await health.fetch(new Request('https://example.test/api/health'));
  assert.equal(healthResponse.status, 200);
  const healthPayload = await healthResponse.json();
  assert.equal(healthPayload.ok, true);
  assert.equal(healthPayload.runtime, 'nodejs');

  const oldBsd = process.env.BSD_TOKEN;
  const oldSstats = process.env.SSTATS_TOKEN;
  delete process.env.BSD_TOKEN;
  delete process.env.SSTATS_TOKEN;

  try {
    const dataResponse = await data.fetch(new Request('https://example.test/api/data'));
    assert.equal(dataResponse.status, 200);
    const dataPayload = await dataResponse.json();
    assert.ok(Array.isArray(dataPayload.predictions));
    assert.equal(dataPayload.sources.bsd.ok, false);
    assert.equal(dataPayload.sources.sstats.ok, false);
    assert.ok(Array.isArray(dataPayload.errors));
  } finally {
    if (oldBsd === undefined) delete process.env.BSD_TOKEN;
    else process.env.BSD_TOKEN = oldBsd;
    if (oldSstats === undefined) delete process.env.SSTATS_TOKEN;
    else process.env.SSTATS_TOKEN = oldSstats;
  }

  console.log('Smoke tests passed: ESM /api/health and /api/data handlers return valid JSON.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
