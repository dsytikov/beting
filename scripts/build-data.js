'use strict';

const fs = require('node:fs');

const BSD_BASE = 'https://sports.bzzoiro.com/api/v2';
const SSTATS_BASE = 'https://api.sstats.net';
let date = new Date().toISOString().slice(0, 10);
const errors = [];
const sourceStatus = {
  bsd: { ok: false, count: 0, message: '' },
  sstats: { ok: false, count: 0, message: '' }
};

function arr(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['results', 'data', 'items', 'games', 'events', 'predictions', 'matches']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  if (payload?.data && typeof payload.data === 'object') return arr(payload.data);
  return [];
}
function first(...values) {
  return values.find(v => v !== undefined && v !== null && v !== '') ?? null;
}
function percent(value) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return null;
  return `${Number(value).toFixed(1)}%`;
}
function safeError(error) {
  return String(error?.message || error).replace(/https?:\/\/\S+/g, '[API URL]').slice(0, 220);
}
function dateKey(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const european = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (european) return `${european[3]}-${european[2]}-${european[1]}`;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}
async function getJson(url, headers = {}, timeoutMs = 5000) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 160)}`);
  try { return JSON.parse(body); } catch { throw new Error('API вернул не JSON'); }
}
function teamName(value) {
  if (value && typeof value === 'object') return first(value.name, value.Name, value.title, value.short_name, '—');
  return first(value, '—');
}
function normalizeBsd(event, prediction) {
  // Accept both the documented "markets" shape and legacy/provider variants.
  const markets = prediction?.markets || prediction?.predictions || {};
  const result = markets.match_result || markets.matchResult || markets.result || {};
  const ou = markets.over_under || markets.total_goals || markets.totalGoals || {};
  const corners = markets.corners || markets.total_corners || {};
  const expected = markets.expected_goals || markets.expectedGoals || {};
  const predicted = first(result.predicted, prediction?.recommendations?.favorite);
  const probHome = percent(result.prob_home);
  const probDraw = percent(result.prob_draw);
  const probAway = percent(result.prob_away);
  const hasResultProbs = [result.prob_home, result.prob_draw, result.prob_away]
    .some(value => value !== undefined && value !== null && Number.isFinite(Number(value)));
  const outcome = predicted
    ? ({ home: 'П1', draw: 'X', away: 'П2' })[String(predicted).toLowerCase()] || String(predicted)
    : hasResultProbs
      ? `П1 ${probHome ?? '—'} / X ${probDraw ?? '—'} / П2 ${probAway ?? '—'}`
      : '—';
  const over15 = first(ou.prob_over_15, ou.prob_over_1_5);
  const over25 = first(ou.prob_over_25, ou.prob_over_2_5);
  const over35 = first(ou.prob_over_35, ou.prob_over_3_5);
  const corner85 = first(corners.prob_over_85, corners.prob_over_8_5);
  const corner95 = first(corners.prob_over_95, corners.prob_over_9_5);
  const corner105 = first(corners.prob_over_105, corners.prob_over_10_5);
  const cornerParts = [
    corner85 !== null ? `8.5: ${percent(corner85)}` : null,
    corner95 !== null ? `9.5: ${percent(corner95)}` : null,
    corner105 !== null ? `10.5: ${percent(corner105)}` : null
  ].filter(Boolean);
  const eventDate = first(event.event_date, event.start_time, event.kickoff, event.date);
  return {
    source: 'BSD',
    eventId: first(event.id, prediction?.event_id, prediction?.event?.id),
    time: eventDate,
    league: first(event.league?.name, event.competition?.name, event.league_name, event.league, '—') && teamName(first(event.league?.name, event.competition?.name, event.league_name, event.league, '—')),
    home: teamName(first(event.home_team, event.home, event.HomeTeam, '—')),
    away: teamName(first(event.away_team, event.away, event.AwayTeam, '—')),
    outcome,
    totalGoals: [
      over15 !== null ? `ТБ 1.5: ${percent(over15)}` : null,
      over25 !== null ? `ТБ 2.5: ${percent(over25)}` : null,
      over35 !== null ? `ТБ 3.5: ${percent(over35)}` : null
    ].filter(Boolean).join(' / ') || (first(expected.home, expected.away) !== null ? `xG ${expected.home ?? '—'}–${expected.away ?? '—'}` : '—'),
    individualTotals: first(expected.home, expected.away) !== null ? `Х ${expected.home ?? '—'} / Г ${expected.away ?? '—'} xG` : '—',
    corners: cornerParts.length ? `ТБ угл. ${cornerParts.join(' / ')}` : '—',
    yellowCards: '—'
  };
}
function normalizeSstats(game) {
  const prediction = game.prediction || game.predictions || game;
  const markets = prediction.markets || prediction.predictions || {};
  const dateTime = first(
    game.Date, game.date, game.DateTime, game.dateTime, game.eventDate, game.event_date,
    game.StartTime, game.startTime, game.start_time, game.Kickoff, game.kickoff,
    game.MatchDate, game.matchDate, game.match_date, game.gameDate, game.GameDate,
    game.start, game.timestamp, game.date_start, game.DateStart
  );
  const home = first(game.HomeTeamName, game.homeTeamName, game.homeTeam?.name, game.homeTeam, game.home, game.HomeTeam);
  const away = first(game.AwayTeamName, game.awayTeamName, game.awayTeam?.name, game.awayTeam, game.away, game.AwayTeam);
  return {
    source: 'SStats',
    eventId: first(game.Id, game.id, game.GameId, game.gameId),
    time: dateTime,
    league: first(game.LeagueName, game.leagueName, game.league?.name, game.league, game.League, '—') && teamName(first(game.LeagueName, game.leagueName, game.league?.name, game.league, game.League, '—')),
    home: teamName(home),
    away: teamName(away),
    outcome: first(markets.match_result?.predicted, markets.matchResult, game.predictedWinner, game.PredictedWinner, '—'),
    totalGoals: first(markets.over_under?.prediction, markets.totalGoals, game.TotalGoals, '—'),
    individualTotals: '—',
    corners: first(markets.corners?.prediction, markets.totalCorners, game.TotalCorners, '—'),
    yellowCards: '—'
  };
}
async function fetchBSD() {
  const token = process.env.BSD_TOKEN || '';
  if (!token) throw new Error('Не задан BSD_TOKEN в Environment Variables Vercel');
  const headers = { Authorization: `Token ${token}`, Accept: 'application/json' };
  const params = new URLSearchParams({ date_from: date, date_to: date, limit: '200', offset: '0' });

  const [eventsResult, predictionsResult] = await Promise.allSettled([
    getJson(`${BSD_BASE}/events/?${params}`, headers),
    getJson(`${BSD_BASE}/predictions/?${params}`, headers)
  ]);
  if (eventsResult.status === 'rejected' && predictionsResult.status === 'rejected') {
    throw new Error(`events: ${safeError(eventsResult.reason)}; predictions: ${safeError(predictionsResult.reason)}`);
  }

  const events = eventsResult.status === 'fulfilled' ? arr(eventsResult.value) : [];
  const predictions = predictionsResult.status === 'fulfilled' ? arr(predictionsResult.value) : [];
  const predictionByEvent = new Map();
  const predictionByTeams = new Map();
  const nameKey = value => String(teamName(value) || '')
    .normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
    .toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, ' ').trim();
  const eventTeamsKey = event => {
    const home = first(event.home_team, event.home, event.HomeTeam, event.event?.home_team);
    const away = first(event.away_team, event.away, event.AwayTeam, event.event?.away_team);
    return home && away ? `${nameKey(home)}| ${nameKey(away)}` : null;
  };
  for (const prediction of predictions) {
    const eventId = first(prediction.event_id, prediction.event?.id, prediction.match_id, prediction.match?.id);
    if (eventId !== null) predictionByEvent.set(String(eventId), prediction);
    const nestedEvent = prediction.event || prediction.match || prediction;
    const teamsKey = eventTeamsKey(nestedEvent);
    if (teamsKey) predictionByTeams.set(teamsKey, prediction);
  }

  if (events.length) {
    const matchedPredictions = events.map(event => {
      const byId = predictionByEvent.get(String(first(event.id, event.event_id, event.eventId)));
      const byTeams = predictionByTeams.get(eventTeamsKey(event));
      return byId || byTeams || null;
    });

    // The docs expose a per-event prediction endpoint as a fallback. Limit the
    // fallback fan-out so a sparse prediction feed cannot exhaust the serverless budget.
    const missingUpcoming = [];
    events.forEach((event, index) => {
      const status = String(first(event.status, event.match_status, '')).toLowerCase();
      const kickoff = first(event.event_date, event.start_time, event.kickoff, event.date);
      if (!matchedPredictions[index] && kickoff && dateKey(kickoff) === date &&
          (!status || status === 'upcoming') && missingUpcoming.length < 12) {
        missingUpcoming.push({ event, index });
      }
    });
    await Promise.all(missingUpcoming.map(async ({ event, index }) => {
      const eventId = first(event.id, event.event_id, event.eventId);
      if (eventId === null) return;
      try {
        const payload = await getJson(`${BSD_BASE}/events/${encodeURIComponent(eventId)}/prediction/`, headers, 2500);
        const candidate = payload?.prediction || payload?.data?.prediction || payload?.data || payload;
        if (candidate && (candidate.markets || candidate.predictions || candidate.recommendations)) {
          matchedPredictions[index] = candidate;
        }
      } catch {
        // A per-event prediction can legitimately be absent; keep other matches.
      }
    }));

    const matched = matchedPredictions.filter(Boolean).length;
    const rows = events.map((event, index) => normalizeBsd(event, matchedPredictions[index]));
    if (predictionsResult.status === 'rejected') {
      sourceStatus.bsd.message = `Расписание получено, прогнозы BSD недоступны: ${safeError(predictionsResult.reason)}`;
    } else if (predictions.length && matched === 0) {
      sourceStatus.bsd.message = `Получено ${events.length} матчей и ${predictions.length} прогнозов BSD, но сопоставить прогнозы не удалось`;
    } else {
      sourceStatus.bsd.message = `Прогнозы BSD сопоставлены: ${matched} из ${events.length} матчей`;
    }
    return rows;
  }

  return predictions.map(prediction => {
    const event = prediction.event || prediction.match || prediction;
    return normalizeBsd(event, prediction);
  });
}
async function fetchSStats() {
  const token = process.env.SSTATS_TOKEN || '';
  if (!token) throw new Error('Не задан SSTATS_TOKEN в Environment Variables Vercel');
  // Request only the target day. Fetching an entire year can be slow or time out.
  // SStats documents From/To filters for Games/list.
  const params = new URLSearchParams({ from: date, to: date, limit: '200', order: '-1', apikey: token });
  const payload = await getJson(`${SSTATS_BASE}/games/list?${params}`);
  const games = arr(payload);
  return games.filter(game => {
    const raw = first(
      game.Date, game.date, game.DateTime, game.dateTime, game.eventDate, game.event_date,
      game.StartTime, game.startTime, game.start_time, game.Kickoff, game.kickoff,
      game.MatchDate, game.matchDate, game.match_date, game.gameDate, game.GameDate,
      game.start, game.timestamp, game.date_start, game.DateStart
    );
    return dateKey(raw) === date;
  }).map(normalizeSstats);
}
async function runSource(name, fn) {
  try {
    const rows = await fn();
    const priorMessage = sourceStatus[name].message;
    sourceStatus[name] = {
      ok: true,
      count: rows.length,
      message: priorMessage || (rows.length ? '' : `API ответил, но матчи за ${date} не найдены или формат ответа не распознан`)
    };
    if (!rows.length) errors.push(`${name === 'bsd' ? 'BSD' : 'SStats'}: ${sourceStatus[name].message}`);
    else if (priorMessage) errors.push(`${name === 'bsd' ? 'BSD' : 'SStats'}: ${priorMessage}`);
    return rows;
  } catch (error) {
    const message = safeError(error);
    sourceStatus[name] = { ok: false, count: 0, message };
    errors.push(`${name === 'bsd' ? 'BSD' : 'SStats'}: ${message}`);
    return [];
  }
}
async function buildData() {
  date = new Date().toISOString().slice(0, 10);
  errors.length = 0;
  sourceStatus.bsd = { ok: false, count: 0, message: '' };
  sourceStatus.sstats = { ok: false, count: 0, message: '' };
  const [bsd, sstats] = await Promise.all([runSource('bsd', fetchBSD), runSource('sstats', fetchSStats)]);
  const predictions = [...bsd, ...sstats]
    .filter(row => row.time && dateKey(row.time) === date)
    .sort((a, b) => new Date(a.time) - new Date(b.time));
  return { date, generatedAt: new Date().toISOString(), sources: sourceStatus, errors, predictions };
}

if (require.main === module) {
  buildData().then(output => {
    fs.writeFileSync('data.json', JSON.stringify(output, null, 2) + '\n');
    console.log(`Generated data.json: ${output.predictions.length} rows; BSD=${output.sources.bsd.count}; SStats=${output.sources.sstats.count}`);
    if (!output.sources.bsd.ok && !output.sources.sstats.ok) {
      console.warn('Both data sources failed; generated JSON contains diagnostic errors.');
    }
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { buildData };
