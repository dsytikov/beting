'use strict';

const assert = require('node:assert/strict');
const { normalizeBsd, normalizeSstats, normalizeFootballData } = require('./build-data');
const { normalizeEuro365 } = require('./euro365');

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
  const oldEuro365 = process.env.EURO365_API_KEY;
  delete process.env.EURO365_API_KEY;
  const oldFdData = process.env.FD_DATA_TOKEN;
  delete process.env.FD_DATA_TOKEN;

  try {
    const dataRes = responseMock();
    await data({ method: 'GET', query: {} }, dataRes);
    assert.equal(dataRes.statusCode, 200);
    assert.ok(Array.isArray(dataRes.payload.predictions));
    assert.equal(dataRes.payload.sources.bsd.ok, false);
    assert.equal(dataRes.payload.sources.sstats.ok, false);
    assert.equal(dataRes.payload.sources.euro365.ok, false);
    assert.equal(dataRes.payload.sources.fbdata.ok, false);
    assert.ok(Array.isArray(dataRes.payload.errors));

    const dataMethodRes = responseMock();
    await data({ method: 'PUT', query: {} }, dataMethodRes);
    assert.equal(dataMethodRes.statusCode, 405);
  } finally {
    if (oldBsd === undefined) delete process.env.BSD_TOKEN;
    else process.env.BSD_TOKEN = oldBsd;
    if (oldSstats === undefined) delete process.env.SSTATS_TOKEN;
    else process.env.SSTATS_TOKEN = oldSstats;
    if (oldEuro365 === undefined) delete process.env.EURO365_API_KEY;
    else process.env.EURO365_API_KEY = oldEuro365;
    if (oldFdData === undefined) delete process.env.FD_DATA_TOKEN;
    else process.env.FD_DATA_TOKEN = oldFdData;
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
  assert.match(bsdRow.underGoals, /ТМ 2.5: 39.0%/);
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
  assert.match(sstatsRow.underGoals, /ТМ 2.5 Poisson:/);


  const footballHistory = [
    { status: 'FINISHED', competition: { code: 'PL' }, homeTeam: { id: 1 }, awayTeam: { id: 3 }, score: { fullTime: { home: 2, away: 0 } } },
    { status: 'FINISHED', competition: { code: 'PL' }, homeTeam: { id: 4 }, awayTeam: { id: 2 }, score: { fullTime: { home: 0, away: 1 } } },
    { status: 'FINISHED', competition: { code: 'PL' }, homeTeam: { id: 1 }, awayTeam: { id: 5 }, score: { fullTime: { home: 3, away: 1 } } },
    { status: 'FINISHED', competition: { code: 'PL' }, homeTeam: { id: 6 }, awayTeam: { id: 2 }, score: { fullTime: { home: 1, away: 2 } } }
  ];
  const footballRow = normalizeFootballData({
    id: 999, utcDate: '2026-10-10T16:00:00Z', status: 'SCHEDULED',
    competition: { code: 'PL', name: 'Premier League' },
    homeTeam: { id: 1, shortName: 'Home' }, awayTeam: { id: 2, shortName: 'Away' },
    score: { fullTime: { home: null, away: null } }
  }, footballHistory);
  assert.equal(footballRow.source, 'FB_DATA');
  assert.equal(footballRow.league, 'Premier League');
  assert.equal(footballRow.home, 'Home');
  assert.equal(footballRow.away, 'Away');
  assert.match(footballRow.probabilityOutcome, /П1 .*% \/ X .*% \/ П2 .*%/);
  assert.match(footballRow.totalGoals, /ТБ 2.5:/);
  assert.match(footballRow.underGoals, /ТМ 2.5:/);

  const euroRow = normalizeEuro365(
    's2-test.123',
    { ts: Math.floor(Date.parse('2026-10-10T15:00:00Z') / 1000), h: 'Alpha', a: 'Beta', t: [7, 'Test League', 1], live: false },
    {
      '1001': { s: { s: 0, '2001': [200, 0, null, 1], '2002': [350, 0, null, 1], '2003': [400, 0, null, 1] } },
      '1018': { 's2.5': { s: 0, '2004': [180, 0, null, 1], '2005': [220, 0, null, 1] } }
    },
    { markets: { '1001': '1x2', '1018': 'Total Goals - Over / Under' }, outcomes: { '2001': '1', '2002': 'X', '2003': '2', '2004': 'Over', '2005': 'Under' }, full: {} },
    '2026-10-10'
  );
  assert.equal(euroRow.source, 'Euro365');
  assert.equal(euroRow.home, 'Alpha');
  assert.equal(euroRow.away, 'Beta');
  assert.match(euroRow.probabilityOutcome, /П1 31/);
  assert.match(euroRow.totalGoals, /ТБ 2.5:/);
  assert.match(euroRow.underGoals, /ТМ 2.5:/);

  console.log('Smoke tests passed: API response shape, provider field normalization, and missing-token diagnostics.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
