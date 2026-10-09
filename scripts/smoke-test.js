'use strict';

const assert = require('node:assert/strict');
const { normalizeBsd, normalizeSstats } = require('./build-data');

function responseMock() {
  return {
    statusCode: 200,
    headers: {},
    payload: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; }
  };
}

async function main() {
  const health = require('../api/health');
  const data = require('../api/data');

  const healthRes = responseMock();
  health({ method: 'GET' }, healthRes);
  assert.equal(healthRes.statusCode, 200);
  assert.equal(healthRes.payload.ok, true);
  assert.equal(healthRes.payload.service, 'beting-dashboard');

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

  const bsdRow = normalizeBsd(
    { id: 42, event_date: '2026-10-09T18:00:00Z', league: { id: 7, name: 'Test League' }, home_team: { name: 'Home FC' }, away_team: { name: 'Away FC' } },
    { event: { id: 42, home_team: 'Home FC', away_team: 'Away FC' }, markets: {
      match_result: { prob_home: 48, prob_draw: 27, prob_away: 25, predicted: 'home' },
      over_under: { prob_over_25: 61 }, expected_goals: { home: 1.6, away: 1.1 },
      corners: { prob_over_95: 52 }, yellow_cards: { prob_over_35: 44 }
    } }
  );
  assert.equal(bsdRow.league, 'Test League');
  assert.equal(bsdRow.home, 'Home FC');
  assert.equal(bsdRow.away, 'Away FC');
  assert.equal(bsdRow.source, 'BSD');
  assert.equal(bsdRow.outcome, 'П1');
  assert.equal(bsdRow.probabilityOutcome, 'П1 48.0% / X 27.0% / П2 25.0%');
  assert.match(bsdRow.totalGoals, /ТБ 2.5: 61.0%/);
  assert.match(bsdRow.individualTotals, /1.6/);
  assert.match(bsdRow.corners, /9.5: 52.0%/);
  assert.match(bsdRow.yellowCards, /3.5: 44.0%/);

  const bsdDocumentedSchemaRow = normalizeBsd(
    { id: 606053, event_date: '2026-10-09T18:00:00Z', home_team: 'Home FC', away_team: 'Away FC' },
    { event: { id: 606053 }, prob_home_win: 52.3, prob_draw: 24.1, prob_away_win: 23.6, predicted_result: 'H' }
  );
  assert.equal(bsdDocumentedSchemaRow.probabilityOutcome, 'П1 52.3% / X 24.1% / П2 23.6%');
  assert.equal(bsdDocumentedSchemaRow.outcome, 'П1');

  const leagueIdRow = normalizeBsd(
    { id: 43, event_date: '2026-10-09T18:00:00Z', league: { id: 50 }, home_team: 'Home FC', away_team: 'Away FC' },
    { event: { id: 43 }, markets: { match_result: { predicted: 'away' } } },
    new Map([['50', 'Mapped League']])
  );
  assert.equal(leagueIdRow.league, 'Mapped League');
  assert.equal(leagueIdRow.outcome, 'П2');

  const sstatsRow = normalizeSstats(
    { Id: 1183255, Date: '2026-10-09T19:00:00Z', LeagueId: 7, HomeTeamName: 'Alpha', AwayTeamName: 'Beta' },
    { data: { homeWinProbability: 0.51, drawProbability: 0.25, awayWinProbability: 0.24, homeXg: 1.7, awayXg: 1.2 } },
    new Map([['7', 'SStats Test League']])
  );
  assert.equal(sstatsRow.league, 'SStats Test League');
  assert.equal(sstatsRow.home, 'Alpha');
  assert.equal(sstatsRow.away, 'Beta');
  assert.equal(sstatsRow.source, 'SStats');
  assert.match(sstatsRow.outcome, /51.0%/);
  assert.equal(sstatsRow.probabilityOutcome, 'П1 51.0% / X 25.0% / П2 24.0%');
  assert.match(sstatsRow.individualTotals, /1.7/);
  assert.match(sstatsRow.totalGoals, /ТБ 2.5 Poisson:/);

  console.log('Smoke tests passed: API response shape, provider field normalization, and missing-token diagnostics.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
