#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const BSD_BASE = 'https://sports.bzzoiro.com/api/v2';
const SSTATS_BASE = 'https://api.sstats.net';
const date = new Date().toISOString().slice(0, 10);
const errors = [];
const sourceStatus = {
  bsd: { ok: false, count: 0, message: '' },
  sstats: { ok: false, count: 0, message: '' }
};

function arr(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['results', 'data', 'items', 'games', 'events']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}
function first(...values) {
  return values.find(v => v !== undefined && v !== null && v !== '') ?? null;
}
function percent(value) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  return `${n.toFixed(1)}%`;
}
function safeError(error) {
  return String(error?.message || error).replace(/https?:\/\/\S+/g, '[API URL]').slice(0, 220);
}
async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 160)}`);
  try { return JSON.parse(body); } catch { throw new Error('API вернул не JSON'); }
}
function normalizeBsd(prediction) {
  const event = prediction.event || prediction.match || {};
  const markets = prediction.markets || prediction.predictions || {};
  const result = markets.match_result || markets.matchResult || {};
  const ou = markets.over_under || markets.total_goals || {};
  const corners = markets.corners || {};
  const expected = markets.expected_goals || {};
  const predicted = first(result.predicted, prediction.predicted, prediction.recommendations?.favorite);
  const outcome = predicted
    ? `${({ home: 'П1', draw: 'X', away: 'П2' })[String(predicted).toLowerCase()] || predicted}${first(result.prob_home, result.prob_draw, result.prob_away) !== null ? '' : ''}`
    : first(result.prob_home, result.prob_draw, result.prob_away) !== null
      ? `П1 ${percent(result.prob_home)} / X ${percent(result.prob_draw)} / П2 ${percent(result.prob_away)}`
      : '—';
  const goalsLine = first(ou.prob_over_25, ou.prob_over_2_5);
  const totalGoals = goalsLine !== null ? `ТБ 2.5: ${percent(goalsLine)}`
    : first(expected.home, expected.away) !== null ? `xG ${expected.home ?? '—'}–${expected.away ?? '—'}` : '—';
  const cornerLine = first(corners.prob_over_95, corners.prob_over_9_5, corners.prob_over_85);
  return {
    source: 'BSD',
    time: first(event.start_time, event.kickoff, prediction.start_time, event.date),
    league: first(event.league?.name, event.competition?.name, event.league_name, '—'),
    home: first(event.home_team?.name, event.home_team, event.home, '—'),
    away: first(event.away_team?.name, event.away_team, event.away, '—'),
    outcome,
    totalGoals,
    individualTotals: first(expected.home, expected.away) !== null ? `Х ${expected.home ?? '—'} / Г ${expected.away ?? '—'} xG` : '—',
    corners: cornerLine !== null ? `ТБ угл. ${corners.prob_over_95 !== undefined ? '9.5' : '8.5'}: ${percent(cornerLine)}` : '—',
    yellowCards: '—'
  };
}
function normalizeSstats(game) {
  const prediction = game.prediction || game.predictions || game;
  const markets = prediction.markets || prediction.predictions || {};
  const dateTime = first(game.date, game.startTime, game.start_time, game.kickoff, game.matchDate);
  return {
    source: 'SStats',
    time: dateTime,
    league: first(game.leagueName, game.league?.name, game.league, '—'),
    home: first(game.homeTeamName, game.homeTeam?.name, game.homeTeam, game.home, '—'),
    away: first(game.awayTeamName, game.awayTeam?.name, game.awayTeam, game.away, '—'),
    outcome: first(markets.match_result?.predicted, markets.matchResult, game.predictedWinner, '—'),
    totalGoals: first(markets.over_under?.prediction, markets.totalGoals, '—'),
    individualTotals: '—',
    corners: first(markets.corners?.prediction, markets.totalCorners, '—'),
    yellowCards: '—'
  };
}
async function fetchBSD() {
  const token = process.env.BSD_TOKEN || '';
  if (!token) throw new Error('Не задан BSD_TOKEN в GitHub Secrets/Variables');
  const headers = { Authorization: `Token ${token}`, Accept: 'application/json' };
  const params = new URLSearchParams({ date_from: date, date_to: date, limit: '200' });
  const predictionsPayload = await getJson(`${BSD_BASE}/predictions/?${params}`, headers);
  const predictions = arr(predictionsPayload);
  if (predictions.length) return predictions.map(normalizeBsd);
  const eventsPayload = await getJson(`${BSD_BASE}/events/?${params}`, headers);
  return arr(eventsPayload).map(event => ({
    source: 'BSD', time: first(event.start_time, event.date), league: first(event.league?.name, event.competition?.name, '—'),
    home: first(event.home_team?.name, event.home?.name, '—'), away: first(event.away_team?.name, event.away?.name, '—'),
    outcome: '—', totalGoals: '—', individualTotals: '—', corners: '—', yellowCards: '—'
  }));
}
async function fetchSStats() {
  const token = process.env.SSTATS_TOKEN || '';
  if (!token) throw new Error('Не задан SSTATS_TOKEN в GitHub Secrets/Variables');
  const params = new URLSearchParams({ DateFrom: date, DateTo: date, apikey: token });
  const payload = await getJson(`${SSTATS_BASE}/Games/list?${params}`);
  return arr(payload).filter(game => {
    const raw = first(game.date, game.startTime, game.start_time, game.kickoff, game.matchDate);
    if (!raw) return false;
    return String(raw).slice(0, 10) === date;
  }).map(normalizeSstats);
}
async function runSource(name, fn) {
  try {
    const rows = await fn();
    sourceStatus[name] = { ok: true, count: rows.length, message: '' };
    return rows;
  } catch (error) {
    const message = safeError(error);
    sourceStatus[name] = { ok: false, count: 0, message };
    errors.push(`${name === 'bsd' ? 'BSD' : 'SStats'}: ${message}`);
    return [];
  }
}
async function main() {
  const [bsd, sstats] = await Promise.all([runSource('bsd', fetchBSD), runSource('sstats', fetchSStats)]);
  const predictions = [...bsd, ...sstats]
    .filter(row => row.time && String(row.time).slice(0, 10) === date)
    .sort((a, b) => new Date(a.time) - new Date(b.time));
  const output = { date, generatedAt: new Date().toISOString(), sources: sourceStatus, errors, predictions };
  fs.writeFileSync('data.json', JSON.stringify(output, null, 2) + '\n');
  console.log(`Generated data.json: ${predictions.length} rows; BSD=${bsd.length}; SStats=${sstats.length}`);
  if (!sourceStatus.bsd.ok && !sourceStatus.sstats.ok) {
    console.warn('Both data sources failed; published JSON contains diagnostic errors.');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
