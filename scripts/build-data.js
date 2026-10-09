'use strict';

const fs = require('node:fs');

const BSD_BASE = 'https://sports.bzzoiro.com/api/v2';
const SSTATS_BASE = 'https://api.sstats.net';
let date = new Date().toISOString().slice(0, 10);
const errors = [];
const sourceStatus = {
  bsd: { ok: false, count: 0, message: '', diagnostic: '' },
  sstats: { ok: false, count: 0, message: '', diagnostic: '' }
};

function arr(payload, depth = 0) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object' || depth > 4) return [];
  for (const key of ['results', 'Results', 'data', 'Data', 'items', 'Items', 'games', 'Games', 'events', 'Events', 'predictions', 'Predictions', 'matches', 'Matches', 'records', 'value']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  for (const key of ['data', 'Data', 'result', 'Result', 'response', 'Response']) {
    if (payload[key] && typeof payload[key] === 'object') {
      const nested = arr(payload[key], depth + 1);
      if (nested.length) return nested;
    }
  }
  return [];
}
function first(...values) {
  return values.find(v => v !== undefined && v !== null && v !== '') ?? null;
}
function keyNorm(value) {
  return String(value).replace(/[^a-z0-9]/gi, '').toLowerCase();
}
function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return null;
  const wanted = new Set(keys.map(keyNorm));
  for (const [key, value] of Object.entries(obj)) {
    if (wanted.has(keyNorm(key)) && value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}
function deepPick(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  const direct = pick(obj, ...keys);
  if (direct !== null) return direct;
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = deepPick(value, keys, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}
function percent(value) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return null;
  let number = Number(value);
  if (number > 0 && number < 1) number *= 100;
  return `${number.toFixed(1)}%`;
}
function percentUnder(overValue) {
  if (overValue === undefined || overValue === null || !Number.isFinite(Number(overValue))) return null;
  const over = Number(overValue);
  const scale = over <= 1 ? 1 : 100;
  return percent(Math.max(0, Math.min(scale, scale - over)));
}
function poissonOver(lambda, threshold) {
  const mean = Number(lambda);
  if (!Number.isFinite(mean) || mean < 0 || mean > 12) return null;
  let probability = Math.exp(-mean);
  let cumulative = probability;
  for (let goals = 1; goals <= threshold; goals++) {
    probability *= mean / goals;
    cumulative += probability;
  }
  return Math.max(0, Math.min(1, 1 - cumulative));
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
  if (value && typeof value === 'object') return first(
    pick(value, 'name', 'teamName', 'displayName', 'title', 'shortName', 'short_name', 'label', 'value'),
    '—'
  );
  return first(value, '—');
}
function leagueNameFor(item, leagueNames = new Map()) {
  const raw = first(
    pick(item, 'leagueName', 'competitionName', 'tournamentName', 'divisionName', 'league', 'competition', 'tournament', 'division'),
    pick(item?.event, 'leagueName', 'competitionName', 'tournamentName', 'league', 'competition', 'tournament'),
    pick(item?.league, 'name', 'Name', 'title', 'Title')
  );
  if (raw && typeof raw === 'object') {
    const name = teamName(raw);
    if (name !== '—') return name;
    const id = pick(raw, 'id', 'leagueId', 'competitionId', 'tournamentId');
    if (id !== null && leagueNames.has(String(id))) return leagueNames.get(String(id));
  } else if (raw !== null && !/^\d+$/.test(String(raw))) {
    return String(raw);
  }
  const id = first(
    pick(item, 'leagueId', 'competitionId', 'tournamentId', 'divisionId'),
    pick(item?.league, 'id', 'leagueId'),
    pick(item?.event, 'leagueId', 'competitionId', 'tournamentId'),
    raw !== null && typeof raw !== 'object' && /^\d+$/.test(String(raw)) ? raw : null
  );
  return id !== null && leagueNames.has(String(id)) ? leagueNames.get(String(id)) : (id !== null ? String(id) : '—');
}
function normalizeBsd(event, prediction, leagueNames = new Map()) {
  const nestedEvent = first(prediction?.event, prediction?.match, prediction?.fixture, {}) || {};
  const sourceEvent = { ...(event && typeof event === 'object' ? event : {}), ...(nestedEvent && typeof nestedEvent === 'object' ? nestedEvent : {}) };
  const sourcePrediction = prediction || {};
  const marketRoot = first(sourcePrediction.markets, sourcePrediction.Markets, sourcePrediction.predictions, sourcePrediction.Predictions, sourcePrediction.data?.markets, sourcePrediction.data?.predictions, {}) || {};
  const result = first(pick(marketRoot, 'match_result', 'matchResult', 'result', '1x2', 'matchWinner'), {}) || {};
  const ou = first(pick(marketRoot, 'over_under', 'total_goals', 'totalGoals', 'goals', 'overUnder'), {}) || {};
  const corners = first(pick(marketRoot, 'corners', 'total_corners', 'totalCorners', 'cornerKicks'), {}) || {};
  const expected = first(pick(marketRoot, 'expected_goals', 'expectedGoals', 'xg', 'goalExpectancy'), {}) || {};
  const cards = first(pick(marketRoot, 'yellow_cards', 'yellowCards', 'cards', 'booking_points', 'totalCards'), {}) || {};
  const predicted = first(
    pick(result, 'predicted', 'predicted_result', 'predictedResult', 'prediction', 'winner', 'outcome', 'recommended'),
    pick(sourcePrediction.recommendations || {}, 'favorite', 'predicted', 'winner'),
    pick(sourcePrediction, 'predictedWinner', 'predicted_result', 'predictedResult', 'predicted', 'winner')
  );
  const probHomeRaw = first(
    pick(result, 'prob_home', 'probHome', 'prob_home_win', 'probHomeWin', 'home_win_prob', 'homeWinProb', 'homeProbability', 'homeWinProbability', 'home'),
    deepPick(sourcePrediction, ['prob_home', 'probHome', 'prob_home_win', 'probHomeWin', 'home_win_prob', 'homeWinProb', 'home_win_probability', 'homeWinProbability'])
  );
  const probDrawRaw = first(
    pick(result, 'prob_draw', 'probDraw', 'draw_prob', 'drawProb', 'drawProbability', 'draw'),
    deepPick(sourcePrediction, ['prob_draw', 'probDraw', 'draw_prob', 'drawProb', 'drawProbability'])
  );
  const probAwayRaw = first(
    pick(result, 'prob_away', 'probAway', 'prob_away_win', 'probAwayWin', 'away_win_prob', 'awayWinProb', 'awayProbability', 'awayWinProbability', 'away'),
    deepPick(sourcePrediction, ['prob_away', 'probAway', 'prob_away_win', 'probAwayWin', 'away_win_prob', 'awayWinProb', 'away_win_probability', 'awayWinProbability'])
  );
  const probHome = percent(probHomeRaw);
  const probDraw = percent(probDrawRaw);
  const probAway = percent(probAwayRaw);
  const hasResultProbs = [probHomeRaw, probDrawRaw, probAwayRaw].some(value => value !== null && Number.isFinite(Number(value)));
  const probabilityOutcome = hasResultProbs
    ? `П1 ${probHome ?? '—'} / X ${probDraw ?? '—'} / П2 ${probAway ?? '—'}`
    : '—';
  const outcome = predicted
    ? ({ home: 'П1', homewin: 'П1', h: 'П1', '1': 'П1', draw: 'X', tie: 'X', d: 'X', away: 'П2', awaywin: 'П2', a: 'П2', '2': 'П2' })[String(predicted).toLowerCase()] || String(predicted)
    : hasResultProbs
      ? `П1 ${probHome ?? '—'} / X ${probDraw ?? '—'} / П2 ${probAway ?? '—'}`
      : '—';
  const over15 = pick(ou, 'prob_over_15', 'prob_over_1_5', 'over15Probability', 'over1_5');
  const over25 = pick(ou, 'prob_over_25', 'prob_over_2_5', 'over25Probability', 'over2_5');
  const over35 = pick(ou, 'prob_over_35', 'prob_over_3_5', 'over35Probability', 'over3_5');
  const corner85 = pick(corners, 'prob_over_85', 'prob_over_8_5', 'over85Probability', 'over8_5');
  const corner95 = pick(corners, 'prob_over_95', 'prob_over_9_5', 'over95Probability', 'over9_5');
  const corner105 = pick(corners, 'prob_over_105', 'prob_over_10_5', 'over105Probability', 'over10_5');
  const card25 = pick(cards, 'prob_over_25', 'prob_over_2_5', 'over25Probability', 'over2_5');
  const card35 = pick(cards, 'prob_over_35', 'prob_over_3_5', 'over35Probability', 'over3_5');
  const xgHome = first(pick(expected, 'home', 'homeXg', 'xgHome', 'homeExpectedGoals', 'expected_home_goals', 'expectedHomeGoals'), deepPick(sourcePrediction, ['homeXg', 'xgHome', 'homeExpectedGoals']));
  const xgAway = first(pick(expected, 'away', 'awayXg', 'xgAway', 'awayExpectedGoals', 'expected_away_goals', 'expectedAwayGoals'), deepPick(sourcePrediction, ['awayXg', 'xgAway', 'awayExpectedGoals']));
  const eventDate = first(
    pick(sourceEvent, 'eventDate', 'startTime', 'kickoff', 'date', 'dateTime', 'matchDate', 'start'),
    pick(sourcePrediction, 'eventDate', 'startTime', 'kickoff', 'date', 'dateTime', 'matchDate', 'start')
  );
  const home = first(pick(sourceEvent, 'homeTeam', 'home', 'teamHome', 'localTeam', 'homeTeamName'), pick(sourcePrediction, 'homeTeam', 'home', 'teamHome'));
  const away = first(pick(sourceEvent, 'awayTeam', 'away', 'teamAway', 'visitorTeam', 'awayTeamName'), pick(sourcePrediction, 'awayTeam', 'away', 'teamAway'));
  const cornerParts = [
    corner85 !== null ? `8.5: ${percent(corner85)}` : null,
    corner95 !== null ? `9.5: ${percent(corner95)}` : null,
    corner105 !== null ? `10.5: ${percent(corner105)}` : null
  ].filter(Boolean);
  const lambda = xgHome !== null && xgAway !== null ? Number(xgHome) + Number(xgAway) : null;
  const goalParts = [
    over15 !== null ? `ТБ 1.5: ${percent(over15)}` : lambda !== null ? `ТБ 1.5 Poisson: ${percent(poissonOver(lambda, 1))}` : null,
    over25 !== null ? `ТБ 2.5: ${percent(over25)}` : lambda !== null ? `ТБ 2.5 Poisson: ${percent(poissonOver(lambda, 2))}` : null,
    over35 !== null ? `ТБ 3.5: ${percent(over35)}` : lambda !== null ? `ТБ 3.5 Poisson: ${percent(poissonOver(lambda, 3))}` : null
  ].filter(Boolean);
  const underGoalParts = [
    over15 !== null ? `ТМ 1.5: ${percentUnder(over15)}` : lambda !== null ? `ТМ 1.5 Poisson: ${percent(1 - poissonOver(lambda, 1))}` : null,
    over25 !== null ? `ТМ 2.5: ${percentUnder(over25)}` : lambda !== null ? `ТМ 2.5 Poisson: ${percent(1 - poissonOver(lambda, 2))}` : null,
    over35 !== null ? `ТМ 3.5: ${percentUnder(over35)}` : lambda !== null ? `ТМ 3.5 Poisson: ${percent(1 - poissonOver(lambda, 3))}` : null
  ].filter(Boolean);
  const cardParts = [
    card25 !== null ? `ТБ 2.5: ${percent(card25)}` : null,
    card35 !== null ? `ТБ 3.5: ${percent(card35)}` : null
  ].filter(Boolean);
  return {
    source: 'BSD',
    eventId: first(pick(sourceEvent, 'id', 'eventId', 'matchId'), pick(sourcePrediction, 'eventId', 'matchId'), pick(sourcePrediction.event || {}, 'id')),
    time: eventDate,
    league: leagueNameFor(sourceEvent, leagueNames),
    home: teamName(home),
    away: teamName(away),
    outcome,
    probabilityOutcome,
    totalGoals: goalParts.join(' / ') || (xgHome !== null || xgAway !== null ? `xG ${xgHome ?? '—'}–${xgAway ?? '—'}` : '—'),
    underGoals: underGoalParts.join(' / ') || '—',
    individualTotals: xgHome !== null || xgAway !== null ? `Х ${xgHome ?? '—'} / Г ${xgAway ?? '—'} xG` : '—',
    corners: cornerParts.length ? `ТБ угл. ${cornerParts.join(' / ')}` : '—',
    yellowCards: cardParts.length ? cardParts.join(' / ') : '—'
  };
}
function normalizeSstats(game, glicko = null, leagueNames = new Map()) {
  const detail = glicko?.data || glicko?.result || glicko || {};
  const prediction = first(game.prediction, game.predictions, game.Prediction, detail.prediction, detail.predictions, detail, game) || game;
  const markets = first(prediction.markets, prediction.Markets, prediction.predictions, prediction.Predictions, {}) || {};
  const dateTime = first(pick(game, 'Date', 'DateTime', 'eventDate', 'startTime', 'Kickoff', 'MatchDate', 'gameDate', 'start', 'timestamp', 'date_start'));
  const home = first(pick(game, 'HomeTeamName', 'homeTeamName', 'homeTeam', 'home', 'HomeTeam', 'teamHome'), pick(game.HomeTeam || {}, 'name', 'Name', 'teamName'));
  const away = first(pick(game, 'AwayTeamName', 'awayTeamName', 'awayTeam', 'away', 'AwayTeam', 'teamAway'), pick(game.AwayTeam || {}, 'name', 'Name', 'teamName'));
  const homeProb = first(
    pick(markets.match_result || markets.matchResult || {}, 'prob_home', 'probHome', 'homeProbability', 'homeWinProbability'),
    deepPick(detail, ['prob_home', 'probHome', 'homeProbability', 'homeWinProbability', 'homeWinProb'])
  );
  let drawProb = first(
    pick(markets.match_result || markets.matchResult || {}, 'prob_draw', 'probDraw', 'drawProbability'),
    deepPick(detail, ['prob_draw', 'probDraw', 'drawProbability', 'drawProb'])
  );
  const awayProb = first(
    pick(markets.match_result || markets.matchResult || {}, 'prob_away', 'probAway', 'awayProbability', 'awayWinProbability', 'awayWinProb'),
    deepPick(detail, ['prob_away', 'probAway', 'awayProbability', 'awayWinProbability', 'awayWinProb'])
  );
  if (drawProb === null && homeProb !== null && awayProb !== null) {
    const homeN = Number(homeProb);
    const awayN = Number(awayProb);
    const scale = homeN <= 1 && awayN <= 1 ? 1 : 100;
    const residual = scale - homeN - awayN;
    if (residual >= 0 && residual <= scale) drawProb = residual / scale <= 1 ? residual / scale : residual;
  }
  const winner = first(
    pick(prediction, 'predictedWinner', 'winner', 'prediction', 'recommendedOutcome'),
    deepPick(detail, ['predictedWinner', 'winner', 'recommendedOutcome'])
  );
  const hasProbs = [homeProb, drawProb, awayProb].some(v => v !== null && Number.isFinite(Number(v)));
  const outcome = winner
    ? ({ home: 'П1', homewin: 'П1', h: 'П1', '1': 'П1', draw: 'X', tie: 'X', d: 'X', away: 'П2', awaywin: 'П2', a: 'П2', '2': 'П2' })[String(winner).toLowerCase()] || String(winner)
    : hasProbs ? `П1 ${percent(homeProb) ?? '—'} / X ${percent(drawProb) ?? '—'} / П2 ${percent(awayProb) ?? '—'}` : '—';
  const probabilityOutcome = hasProbs
    ? `П1 ${percent(homeProb) ?? '—'} / X ${percent(drawProb) ?? '—'} / П2 ${percent(awayProb) ?? '—'}`
    : '—';
  const xgHome = first(
    deepPick(detail, ['homeXg', 'xgHome', 'homeExpectedGoals', 'expectedGoalsHome', 'homeXG', 'xGHome']),
    deepPick(game, ['homeXg', 'xgHome', 'homeExpectedGoals', 'expectedGoalsHome'])
  );
  const xgAway = first(
    deepPick(detail, ['awayXg', 'xgAway', 'awayExpectedGoals', 'expectedGoalsAway', 'awayXG', 'xGAway']),
    deepPick(game, ['awayXg', 'xgAway', 'awayExpectedGoals', 'expectedGoalsAway'])
  );
  const over15 = deepPick(detail, ['prob_over_15', 'prob_over_1_5', 'over15Probability', 'over1_5Probability']);
  const over25 = deepPick(detail, ['prob_over_25', 'prob_over_2_5', 'over25Probability', 'over2_5Probability']);
  const over35 = deepPick(detail, ['prob_over_35', 'prob_over_3_5', 'over35Probability', 'over3_5Probability']);
  const corners85 = deepPick(detail, ['prob_corners_over_85', 'cornersOver85Probability', 'prob_over_corners_8_5']);
  const corners95 = deepPick(detail, ['prob_corners_over_95', 'cornersOver95Probability', 'prob_over_corners_9_5']);
  const cards25 = deepPick(detail, ['prob_yellow_cards_over_25', 'yellowCardsOver25Probability', 'prob_cards_over_2_5']);
  const cards35 = deepPick(detail, ['prob_yellow_cards_over_35', 'yellowCardsOver35Probability', 'prob_cards_over_3_5']);
  const lambda = xgHome !== null && xgAway !== null ? Number(xgHome) + Number(xgAway) : null;
'use strict';

const fs = require('node:fs');

const BSD_BASE = 'https://sports.bzzoiro.com/api/v2';
const SSTATS_BASE = 'https://api.sstats.net';
let date = new Date().toISOString().slice(0, 10);
const errors = [];
const sourceStatus = {
  bsd: { ok: false, count: 0, message: '', diagnostic: '' },
  sstats: { ok: false, count: 0, message: '', diagnostic: '' }
};

function arr(payload, depth = 0) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object' || depth > 4) return [];
  for (const key of ['results', 'Results', 'data', 'Data', 'items', 'Items', 'games', 'Games', 'events', 'Events', 'predictions', 'Predictions', 'matches', 'Matches', 'records', 'value']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  for (const key of ['data', 'Data', 'result', 'Result', 'response', 'Response']) {
    if (payload[key] && typeof payload[key] === 'object') {
      const nested = arr(payload[key], depth + 1);
      if (nested.length) return nested;
    }
  }
  return [];
}
function first(...values) {
  return values.find(v => v !== undefined && v !== null && v !== '') ?? null;
}
function keyNorm(value) {
  return String(value).replace(/[^a-z0-9]/gi, '').toLowerCase();
}
function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return null;
  const wanted = new Set(keys.map(keyNorm));
  for (const [key, value] of Object.entries(obj)) {
    if (wanted.has(keyNorm(key)) && value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}
function deepPick(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  const direct = pick(obj, ...keys);
  if (direct !== null) return direct;
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = deepPick(value, keys, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}
function percent(value) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return null;
  let number = Number(value);
  if (number > 0 && number < 1) number *= 100;
  return `${number.toFixed(1)}%`;
}
function percentUnder(overValue) {
  if (overValue === undefined || overValue === null || !Number.isFinite(Number(overValue))) return null;
  const over = Number(overValue);
  const scale = over <= 1 ? 1 : 100;
  return percent(Math.max(0, Math.min(scale, scale - over)));
}
function poissonOver(lambda, threshold) {
  const mean = Number(lambda);
  if (!Number.isFinite(mean) || mean < 0 || mean > 12) return null;
  let probability = Math.exp(-mean);
  let cumulative = probability;
  for (let goals = 1; goals <= threshold; goals++) {
    probability *= mean / goals;
    cumulative += probability;
  }
  return Math.max(0, Math.min(1, 1 - cumulative));
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
  if (value && typeof value === 'object') return first(
    pick(value, 'name', 'teamName', 'displayName', 'title', 'shortName', 'short_name', 'label', 'value'),
    '—'
  );
  return first(value, '—');
}
function leagueNameFor(item, leagueNames = new Map()) {
  const raw = first(
    pick(item, 'leagueName', 'competitionName', 'tournamentName', 'divisionName', 'league', 'competition', 'tournament', 'division'),
    pick(item?.event, 'leagueName', 'competitionName', 'tournamentName', 'league', 'competition', 'tournament'),
    pick(item?.league, 'name', 'Name', 'title', 'Title')
  );
  if (raw && typeof raw === 'object') {
    const name = teamName(raw);
    if (name !== '—') return name;
    const id = pick(raw, 'id', 'leagueId', 'competitionId', 'tournamentId');
    if (id !== null && leagueNames.has(String(id))) return leagueNames.get(String(id));
  } else if (raw !== null && !/^\d+$/.test(String(raw))) {
    return String(raw);
  }
  const id = first(
    pick(item, 'leagueId', 'competitionId', 'tournamentId', 'divisionId'),
    pick(item?.league, 'id', 'leagueId'),
    pick(item?.event, 'leagueId', 'competitionId', 'tournamentId'),
    raw !== null && typeof raw !== 'object' && /^\d+$/.test(String(raw)) ? raw : null
  );
  return id !== null && leagueNames.has(String(id)) ? leagueNames.get(String(id)) : (id !== null ? String(id) : '—');
}
function normalizeBsd(event, prediction, leagueNames = new Map()) {
  const nestedEvent = first(prediction?.event, prediction?.match, prediction?.fixture, {}) || {};
  const sourceEvent = { ...(event && typeof event === 'object' ? event : {}), ...(nestedEvent && typeof nestedEvent === 'object' ? nestedEvent : {}) };
  const sourcePrediction = prediction || {};
  const marketRoot = first(sourcePrediction.markets, sourcePrediction.Markets, sourcePrediction.predictions, sourcePrediction.Predictions, sourcePrediction.data?.markets, sourcePrediction.data?.predictions, {}) || {};
  const result = first(pick(marketRoot, 'match_result', 'matchResult', 'result', '1x2', 'matchWinner'), {}) || {};
  const ou = first(pick(marketRoot, 'over_under', 'total_goals', 'totalGoals', 'goals', 'overUnder'), {}) || {};
  const corners = first(pick(marketRoot, 'corners', 'total_corners', 'totalCorners', 'cornerKicks'), {}) || {};
  const expected = first(pick(marketRoot, 'expected_goals', 'expectedGoals', 'xg', 'goalExpectancy'), {}) || {};
  const cards = first(pick(marketRoot, 'yellow_cards', 'yellowCards', 'cards', 'booking_points', 'totalCards'), {}) || {};
  const predicted = first(
    pick(result, 'predicted', 'predicted_result', 'predictedResult', 'prediction', 'winner', 'outcome', 'recommended'),
    pick(sourcePrediction.recommendations || {}, 'favorite', 'predicted', 'winner'),
    pick(sourcePrediction, 'predictedWinner', 'predicted_result', 'predictedResult', 'predicted', 'winner')
  );
  const probHomeRaw = first(
    pick(result, 'prob_home', 'probHome', 'prob_home_win', 'probHomeWin', 'home_win_prob', 'homeWinProb', 'homeProbability', 'homeWinProbability', 'home'),
    deepPick(sourcePrediction, ['prob_home', 'probHome', 'prob_home_win', 'probHomeWin', 'home_win_prob', 'homeWinProb', 'home_win_probability', 'homeWinProbability'])
  );
  const probDrawRaw = first(
    pick(result, 'prob_draw', 'probDraw', 'draw_prob', 'drawProb', 'drawProbability', 'draw'),
    deepPick(sourcePrediction, ['prob_draw', 'probDraw', 'draw_prob', 'drawProb', 'drawProbability'])
  );
  const probAwayRaw = first(
    pick(result, 'prob_away', 'probAway', 'prob_away_win', 'probAwayWin', 'away_win_prob', 'awayWinProb', 'awayProbability', 'awayWinProbability', 'away'),
    deepPick(sourcePrediction, ['prob_away', 'probAway', 'prob_away_win', 'probAwayWin', 'away_win_prob', 'awayWinProb', 'away_win_probability', 'awayWinProbability'])
  );
  const probHome = percent(probHomeRaw);
  const probDraw = percent(probDrawRaw);
  const probAway = percent(probAwayRaw);
  const hasResultProbs = [probHomeRaw, probDrawRaw, probAwayRaw].some(value => value !== null && Number.isFinite(Number(value)));
  const probabilityOutcome = hasResultProbs
    ? `П1 ${probHome ?? '—'} / X ${probDraw ?? '—'} / П2 ${probAway ?? '—'}`
    : '—';
  const outcome = predicted
    ? ({ home: 'П1', homewin: 'П1', h: 'П1', '1': 'П1', draw: 'X', tie: 'X', d: 'X', away: 'П2', awaywin: 'П2', a: 'П2', '2': 'П2' })[String(predicted).toLowerCase()] || String(predicted)
    : hasResultProbs
      ? `П1 ${probHome ?? '—'} / X ${probDraw ?? '—'} / П2 ${probAway ?? '—'}`
      : '—';
  const over15 = pick(ou, 'prob_over_15', 'prob_over_1_5', 'over15Probability', 'over1_5');
  const over25 = pick(ou, 'prob_over_25', 'prob_over_2_5', 'over25Probability', 'over2_5');
  const over35 = pick(ou, 'prob_over_35', 'prob_over_3_5', 'over35Probability', 'over3_5');
  const corner85 = pick(corners, 'prob_over_85', 'prob_over_8_5', 'over85Probability', 'over8_5');
  const corner95 = pick(corners, 'prob_over_95', 'prob_over_9_5', 'over95Probability', 'over9_5');
  const corner105 = pick(corners, 'prob_over_105', 'prob_over_10_5', 'over105Probability', 'over10_5');
  const card25 = pick(cards, 'prob_over_25', 'prob_over_2_5', 'over25Probability', 'over2_5');
  const card35 = pick(cards, 'prob_over_35', 'prob_over_3_5', 'over35Probability', 'over3_5');
  const xgHome = first(pick(expected, 'home', 'homeXg', 'xgHome', 'homeExpectedGoals', 'expected_home_goals', 'expectedHomeGoals'), deepPick(sourcePrediction, ['homeXg', 'xgHome', 'homeExpectedGoals']));
  const xgAway = first(pick(expected, 'away', 'awayXg', 'xgAway', 'awayExpectedGoals', 'expected_away_goals', 'expectedAwayGoals'), deepPick(sourcePrediction, ['awayXg', 'xgAway', 'awayExpectedGoals']));
  const eventDate = first(
    pick(sourceEvent, 'eventDate', 'startTime', 'kickoff', 'date', 'dateTime', 'matchDate', 'start'),
    pick(sourcePrediction, 'eventDate', 'startTime', 'kickoff', 'date', 'dateTime', 'matchDate', 'start')
  );
  const home = first(pick(sourceEvent, 'homeTeam', 'home', 'teamHome', 'localTeam', 'homeTeamName'), pick(sourcePrediction, 'homeTeam', 'home', 'teamHome'));
  const away = first(pick(sourceEvent, 'awayTeam', 'away', 'teamAway', 'visitorTeam', 'awayTeamName'), pick(sourcePrediction, 'awayTeam', 'away', 'teamAway'));
  const cornerParts = [
    corner85 !== null ? `8.5: ${percent(corner85)}` : null,
    corner95 !== null ? `9.5: ${percent(corner95)}` : null,
    corner105 !== null ? `10.5: ${percent(corner105)}` : null
  ].filter(Boolean);
  const lambda = xgHome !== null && xgAway !== null ? Number(xgHome) + Number(xgAway) : null;
  const goalParts = [
    over15 !== null ? `ТБ 1.5: ${percent(over15)}` : lambda !== null ? `ТБ 1.5 Poisson: ${percent(poissonOver(lambda, 1))}` : null,
    over25 !== null ? `ТБ 2.5: ${percent(over25)}` : lambda !== null ? `ТБ 2.5 Poisson: ${percent(poissonOver(lambda, 2))}` : null,
    over35 !== null ? `ТБ 3.5: ${percent(over35)}` : lambda !== null ? `ТБ 3.5 Poisson: ${percent(poissonOver(lambda, 3))}` : null
  ].filter(Boolean);
  const underGoalParts = [
    over15 !== null ? `ТМ 1.5: ${percentUnder(over15)}` : lambda !== null ? `ТМ 1.5 Poisson: ${percent(1 - poissonOver(lambda, 1))}` : null,
    over25 !== null ? `ТМ 2.5: ${percentUnder(over25)}` : lambda !== null ? `ТМ 2.5 Poisson: ${percent(1 - poissonOver(lambda, 2))}` : null,
    over35 !== null ? `ТМ 3.5: ${percentUnder(over35)}` : lambda !== null ? `ТМ 3.5 Poisson: ${percent(1 - poissonOver(lambda, 3))}` : null
  ].filter(Boolean);
  
  const cardParts = [
    card25 !== null ? `ТБ 2.5: ${percent(card25)}` : null,
    card35 !== null ? `ТБ 3.5: ${percent(card35)}` : null
  ].filter(Boolean);
  return {
    source: 'BSD',
    eventId: first(pick(sourceEvent, 'id', 'eventId', 'matchId'), pick(sourcePrediction, 'eventId', 'matchId'), pick(sourcePrediction.event || {}, 'id')),
    time: eventDate,
    league: leagueNameFor(sourceEvent, leagueNames),
    home: teamName(home),
    away: teamName(away),
    outcome,
    probabilityOutcome,
    totalGoals: goalParts.join(' / ') || (xgHome !== null || xgAway !== null ? `xG ${xgHome ?? '—'}–${xgAway ?? '—'}` : '—'),
    underGoals: underGoalParts.join(' / ') || '—',
    individualTotals: xgHome !== null || xgAway !== null ? `Х ${xgHome ?? '—'} / Г ${xgAway ?? '—'} xG` : '—',
    corners: cornerParts.length ? `ТБ угл. ${cornerParts.join(' / ')}` : '—',
    yellowCards: cardParts.length ? cardParts.join(' / ') : '—'
  };
}
function normalizeSstats(game, glicko = null, leagueNames = new Map()) {
  const detail = glicko?.data || glicko?.result || glicko || {};
  const prediction = first(game.prediction, game.predictions, game.Prediction, detail.prediction, detail.predictions, detail, game) || game;
  const markets = first(prediction.markets, prediction.Markets, prediction.predictions, prediction.Predictions, {}) || {};
  const dateTime = first(pick(game, 'Date', 'DateTime', 'eventDate', 'startTime', 'Kickoff', 'MatchDate', 'gameDate', 'start', 'timestamp', 'date_start'));
  const home = first(pick(game, 'HomeTeamName', 'homeTeamName', 'homeTeam', 'home', 'HomeTeam', 'teamHome'), pick(game.HomeTeam || {}, 'name', 'Name', 'teamName'));
  const away = first(pick(game, 'AwayTeamName', 'awayTeamName', 'awayTeam', 'away', 'AwayTeam', 'teamAway'), pick(game.AwayTeam || {}, 'name', 'Name', 'teamName'));
  const homeProb = first(
    pick(markets.match_result || markets.matchResult || {}, 'prob_home', 'probHome', 'homeProbability', 'homeWinProbability'),
    deepPick(detail, ['prob_home', 'probHome', 'homeProbability', 'homeWinProbability', 'homeWinProb'])
  );
  let drawProb = first(
    pick(markets.match_result || markets.matchResult || {}, 'prob_draw', 'probDraw', 'drawProbability'),
    deepPick(detail, ['prob_draw', 'probDraw', 'drawProbability', 'drawProb'])
  );
  const awayProb = first(
    pick(markets.match_result || markets.matchResult || {}, 'prob_away', 'probAway', 'awayProbability', 'awayWinProbability', 'awayWinProb'),
    deepPick(detail, ['prob_away', 'probAway', 'awayProbability', 'awayWinProbability', 'awayWinProb'])
  );
  if (drawProb === null && homeProb !== null && awayProb !== null) {
    const homeN = Number(homeProb);
    const awayN = Number(awayProb);
    const scale = homeN <= 1 && awayN <= 1 ? 1 : 100;
    const residual = scale - homeN - awayN;
    if (residual >= 0 && residual <= scale) drawProb = residual / scale <= 1 ? residual / scale : residual;
  }
  const winner = first(
    pick(prediction, 'predictedWinner', 'winner', 'prediction', 'recommendedOutcome'),
    deepPick(detail, ['predictedWinner', 'winner', 'recommendedOutcome'])
  );
  const hasProbs = [homeProb, drawProb, awayProb].some(v => v !== null && Number.isFinite(Number(v)));
  const outcome = winner
    ? ({ home: 'П1', homewin: 'П1', h: 'П1', '1': 'П1', draw: 'X', tie: 'X', d: 'X', away: 'П2', awaywin: 'П2', a: 'П2', '2': 'П2' })[String(winner).toLowerCase()] || String(winner)
    : hasProbs ? `П1 ${percent(homeProb) ?? '—'} / X ${percent(drawProb) ?? '—'} / П2 ${percent(awayProb) ?? '—'}` : '—';
  const probabilityOutcome = hasProbs
    ? `П1 ${percent(homeProb) ?? '—'} / X ${percent(drawProb) ?? '—'} / П2 ${percent(awayProb) ?? '—'}`
    : '—';
  const xgHome = first(
    deepPick(detail, ['homeXg', 'xgHome', 'homeExpectedGoals', 'expectedGoalsHome', 'homeXG', 'xGHome']),
    deepPick(game, ['homeXg', 'xgHome', 'homeExpectedGoals', 'expectedGoalsHome'])
  );
  const xgAway = first(
    deepPick(detail, ['awayXg', 'xgAway', 'awayExpectedGoals', 'expectedGoalsAway', 'awayXG', 'xGAway']),
    deepPick(game, ['awayXg', 'xgAway', 'awayExpectedGoals', 'expectedGoalsAway'])
  );
  const over15 = deepPick(detail, ['prob_over_15', 'prob_over_1_5', 'over15Probability', 'over1_5Probability']);
  const over25 = deepPick(detail, ['prob_over_25', 'prob_over_2_5', 'over25Probability', 'over2_5Probability']);
  const over35 = deepPick(detail, ['prob_over_35', 'prob_over_3_5', 'over35Probability', 'over3_5Probability']);
  const corners85 = deepPick(detail, ['prob_corners_over_85', 'cornersOver85Probability', 'prob_over_corners_8_5']);
  const corners95 = deepPick(detail, ['prob_corners_over_95', 'cornersOver95Probability', 'prob_over_corners_9_5']);
  const cards25 = deepPick(detail, ['prob_yellow_cards_over_25', 'yellowCardsOver25Probability', 'prob_cards_over_2_5']);
  const cards35 = deepPick(detail, ['prob_yellow_cards_over_35', 'yellowCardsOver35Probability', 'prob_cards_over_3_5']);
  const lambda = xgHome !== null && xgAway !== null ? Number(xgHome) + Number(xgAway) : null;
  const goalParts = [
    over15 !== null ? `ТБ 1.5: ${percent(over15)}` : lambda !== null ? `ТБ 1.5 Poisson: ${percent(poissonOver(lambda, 1))}` : null,
    over25 !== null ? `ТБ 2.5: ${percent(over25)}` : lambda !== null ? `ТБ 2.5 Poisson: ${percent(poissonOver(lambda, 2))}` : null,
    over35 !== null ? `ТБ 3.5: ${percent(over35)}` : lambda !== null ? `ТБ 3.5 Poisson: ${percent(poissonOver(lambda, 3))}` : null
  ].filter(Boolean);
  const underGoalParts = [
    over15 !== null ? `ТМ 1.5: ${percentUnder(over15)}` : lambda !== null ? `ТМ 1.5 Poisson: ${percent(1 - poissonOver(lambda, 1))}` : null,
    over25 !== null ? `ТМ 2.5: ${percentUnder(over25)}` : lambda !== null ? `ТМ 2.5 Poisson: ${percent(1 - poissonOver(lambda, 2))}` : null,
    over35 !== null ? `ТМ 3.5: ${percentUnder(over35)}` : lambda !== null ? `ТМ 3.5 Poisson: ${percent(1 - poissonOver(lambda, 3))}` : null
  ].filter(Boolean);
  const leagueId = first(pick(game, 'LeagueId', 'leagueId', 'LeagueID'), pick(game.League || {}, 'id', 'Id'));
  let league = leagueNameFor(game, leagueNames);
  if (league === '—' && leagueId !== null && leagueNames.has(String(leagueId))) league = leagueNames.get(String(leagueId));
  const cornerParts = [
    corners85 !== null ? `8.5: ${percent(corners85)}` : null,
    corners95 !== null ? `9.5: ${percent(corners95)}` : null
  ].filter(Boolean);
  const cardParts = [
    cards25 !== null ? `ТБ 2.5: ${percent(cards25)}` : null,
    cards35 !== null ? `ТБ 3.5: ${percent(cards35)}` : null
  ].filter(Boolean);
  return {
    source: 'SStats',
    eventId: first(pick(game, 'Id', 'GameId', 'gameId', 'id')),
    time: dateTime,
    league,
    home: teamName(home),
    away: teamName(away),
    outcome,
    probabilityOutcome,
    totalGoals: goalParts.join(' / ') || (xgHome !== null || xgAway !== null ? `xG сумма: ${(Number(xgHome || 0) + Number(xgAway || 0)).toFixed(2)}` : '—'),
    underGoals: underGoalParts.join(' / ') || '—',
    individualTotals: xgHome !== null || xgAway !== null ? `Х ${xgHome ?? '—'} / Г ${xgAway ?? '—'} xG` : '—',
    corners: cornerParts.length ? `ТБ угл. ${cornerParts.join(' / ')}` : '—',
    yellowCards: cardParts.length ? cardParts.join(' / ') : '—'
  };
}
async function fetchBSD() {
  const token = process.env.BSD_TOKEN || '';
  if (!token) throw new Error('Не задан BSD_TOKEN в Environment Variables Vercel');
  const headers = { Authorization: `Token ${token}`, Accept: 'application/json' };
  const params = new URLSearchParams({ date_from: date, date_to: date, limit: '200', offset: '0' });
  const [eventsResult, predictionsResult, leaguesResult] = await Promise.allSettled([
    getJson(`${BSD_BASE}/events/?${params}`, headers, 4500),
    getJson(`${BSD_BASE}/predictions/?${params}`, headers, 4500),
    getJson(`${BSD_BASE}/leagues/?limit=200&offset=0`, headers, 3500)
  ]);
  if (eventsResult.status === 'rejected' && predictionsResult.status === 'rejected') {
    throw new Error(`events: ${safeError(eventsResult.reason)}; predictions: ${safeError(predictionsResult.reason)}`);
  }
  const events = eventsResult.status === 'fulfilled' ? arr(eventsResult.value) : [];
  const predictions = predictionsResult.status === 'fulfilled' ? arr(predictionsResult.value) : [];
  const leagueNames = new Map();
  if (leaguesResult.status === 'fulfilled') {
    for (const league of arr(leaguesResult.value)) {
      const id = pick(league, 'id', 'leagueId', 'competitionId', 'tournamentId');
      const name = pick(league, 'name', 'leagueName', 'competitionName', 'title', 'displayName');
      if (id !== null && name !== null) leagueNames.set(String(id), String(name));
    }
  }
  const predictionByEvent = new Map();
  const predictionByTeams = new Map();
  const nameKey = value => String(teamName(value) || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, ' ').trim();
  const eventTeamsKey = event => {
    const home = first(pick(event, 'home_team', 'homeTeam', 'home', 'HomeTeam', 'homeTeamName'), pick(event?.event || {}, 'home_team', 'homeTeam', 'home'));
    const away = first(pick(event, 'away_team', 'awayTeam', 'away', 'AwayTeam', 'awayTeamName'), pick(event?.event || {}, 'away_team', 'awayTeam', 'away'));
    return home && away ? `${nameKey(home)}|${nameKey(away)}` : null;
  };
  for (const prediction of predictions) {
    const nested = first(prediction.event, prediction.match, prediction.fixture, {}) || {};
    const eventId = first(pick(prediction, 'event_id', 'eventId', 'match_id', 'matchId'), pick(nested, 'id', 'eventId', 'matchId'));
    if (eventId !== null) predictionByEvent.set(String(eventId), prediction);
    const teamsKey = eventTeamsKey(nested.home_team || nested.homeTeam ? nested : prediction);
    if (teamsKey) predictionByTeams.set(teamsKey, prediction);
  }
  if (events.length) {
    const matchedPredictions = events.map(event => {
      const id = first(pick(event, 'id', 'event_id', 'eventId', 'matchId'));
      return predictionByEvent.get(String(id)) || predictionByTeams.get(eventTeamsKey(event)) || null;
    });
    const missingUpcoming = [];
    events.forEach((event, index) => {
      const status = String(first(pick(event, 'status', 'matchStatus', 'match_status'), '')).toLowerCase();
      const kickoff = first(pick(event, 'event_date', 'start_time', 'kickoff', 'date', 'dateTime', 'matchDate'));
      const isFuture = kickoff && Date.parse(kickoff) > Date.now();
      const upcoming = !status || ['upcoming', 'scheduled', 'not_started', 'not started', 'prematch', 'pre-match', 'ns'].includes(status);
      if (!matchedPredictions[index] && kickoff && dateKey(kickoff) === date && missingUpcoming.length < 53) {
        missingUpcoming.push({ event, index });
      }
    });
    // Query the documented per-event endpoint for missing forecasts too; /predictions/ can be empty while events exist.
    // Bound concurrency to avoid rate spikes and keep the whole refresh within the serverless budget.
    let cursor = 0;
    const workers = Array.from({ length: 18 }, async () => {
      while (cursor < missingUpcoming.length) {
        const item = missingUpcoming[cursor++];
        await fetchEventPrediction(item);
      }
    });
    async function fetchEventPrediction({ event, index }) {
      const id = pick(event, 'id', 'event_id', 'eventId', 'matchId');
      if (id === null) return;
      try {
        const payload = await getJson(`${BSD_BASE}/events/${encodeURIComponent(id)}/prediction/`, headers, 2500);
        const candidate = first(payload?.prediction, payload?.data?.prediction, payload?.data, payload);
        const unwrapped = first(candidate?.prediction, candidate?.data?.prediction, candidate?.data, candidate) || candidate;
        const hasProbabilityFields = pick(unwrapped, 'prob_home', 'prob_home_win', 'prob_draw', 'prob_away', 'prob_away_win', 'predicted_result', 'expected_home_goals') !== null;
        if (unwrapped && (unwrapped.markets || unwrapped.Markets || unwrapped.predictions || unwrapped.Predictions || unwrapped.recommendations || hasProbabilityFields)) {
          matchedPredictions[index] = unwrapped;
        }
      } catch { /* Some events do not have a prediction yet. */ }
    }
    await Promise.all(workers);
    const matched = matchedPredictions.filter(Boolean).length;
    const rows = events.map((event, index) => normalizeBsd(event, matchedPredictions[index], leagueNames));
    sourceStatus.bsd.diagnostic = `Прогнозы BSD сопоставлены: ${matched} из ${events.length} матчей`;
    if (predictionsResult.status === 'rejected') {
      sourceStatus.bsd.message = `Расписание получено, прогнозы BSD недоступны: ${safeError(predictionsResult.reason)}`;
    } else if (predictions.length && matched === 0) {
      sourceStatus.bsd.message = `Получено ${events.length} матчей и ${predictions.length} прогнозов BSD, но сопоставить прогнозы не удалось`;
    } else if (matched === 0) {
      sourceStatus.bsd.message = `BSD вернул расписание (${events.length} матчей), но не вернул распознаваемые прогнозы; проверьте ответ /predictions/ и права токена`;
    }
    return rows;
  }
  return predictions.map(prediction => {
    const event = first(prediction.event, prediction.match, prediction.fixture, prediction) || prediction;
    return normalizeBsd(event, prediction, leagueNames);
  });
}
async function fetchSStats() {
  const token = process.env.SSTATS_TOKEN || '';
  if (!token) throw new Error('Не задан SSTATS_TOKEN в Environment Variables Vercel');
  const apiKey = `apikey=${encodeURIComponent(token)}`;
  // Try the documented single-date filter first; some API deployments respond more reliably to From/To.
  let gamesPayload;
  let firstError;
  try {
    const params = new URLSearchParams({ Date: date, Limit: '200', Offset: '0', apikey: token });
    gamesPayload = await getJson(`${SSTATS_BASE}/games/list?${params}`, {}, 4300);
  } catch (error) {
    firstError = error;
    try {
      const params = new URLSearchParams({ From: date, To: date, Limit: '200', Offset: '0', apikey: token });
      gamesPayload = await getJson(`${SSTATS_BASE}/games/list?${params}`, {}, 4000);
      sourceStatus.sstats.diagnostic = `SStats: основной фильтр Date не ответил, сработал запасной From/To (${safeError(firstError)})`;
    } catch (fallbackError) {
      throw new Error(`games/list Date: ${safeError(firstError)}; From/To: ${safeError(fallbackError)}`);
    }
  }
  const games = arr(gamesPayload);
  let leaguesPayload = null;
  try {
    leaguesPayload = await getJson(`${SSTATS_BASE}/leagues?${apiKey}`, {}, 1800);
  } catch { /* League names are optional; match data should still load. */ }
  const leaguesResult = { status: leaguesPayload ? 'fulfilled' : 'rejected', value: leaguesPayload };
  const leagueNames = new Map();
  if (leaguesResult.status === 'fulfilled') {
    for (const league of arr(leaguesResult.value)) {
      const id = pick(league, 'Id', 'LeagueId', 'leagueId');
      const name = pick(league, 'Name', 'LeagueName', 'leagueName', 'Title', 'title');
      if (id !== null && name !== null) leagueNames.set(String(id), String(name));
    }
  }
  const todayGames = games.filter(game => {
    const raw = pick(game, 'Date', 'DateTime', 'eventDate', 'StartTime', 'Kickoff', 'MatchDate', 'gameDate', 'start', 'timestamp', 'date_start');
    return !raw || dateKey(raw) === date;
  });
  // Glicko/xG is a separate documented endpoint, not part of /games/list.
  // Query it concurrently so the table gets actual model fields instead of empty placeholders.
  const glickoTargets = firstError ? [] : todayGames.slice(0, 10); // Skip optional enrichment after a slow fallback, preserving time for the data response.
  const glickoPairs = await Promise.all(glickoTargets.map(async game => {
    const id = pick(game, 'Id', 'GameId', 'gameId', 'id');
    if (id === null) return [String(id), null];
    try {
      const result = await getJson(`${SSTATS_BASE}/games/glicko/${encodeURIComponent(id)}?apikey=${encodeURIComponent(token)}`, {}, 2600);
      return [String(id), result];
    } catch (error) {
      return [String(id), null];
    }
  }));
  const glickoById = new Map(glickoPairs);
  const rows = todayGames.map(game => {
    const id = pick(game, 'Id', 'GameId', 'gameId', 'id');
    const detail = id === null ? null : glickoById.get(String(id));
    return normalizeSstats(game, detail, leagueNames);
  });
  const enriched = glickoPairs.filter(([, value]) => value !== null).length;
  sourceStatus.sstats.diagnostic = `${sourceStatus.sstats.diagnostic ? sourceStatus.sstats.diagnostic + '; ' : ''}SStats: получено ${todayGames.length} матчей, Glicko/xG доступны для ${enriched}`;
  return rows;
}
async function runSource(name, fn) {
  try {
    const rows = await fn();
    const priorMessage = sourceStatus[name].message;
    const diagnostic = sourceStatus[name].diagnostic || '';
    sourceStatus[name] = {
      ok: true,
      count: rows.length,
      message: priorMessage || (rows.length ? '' : `API ответил, но матчи за ${date} не найдены или формат ответа не распознан`),
      diagnostic
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
  sourceStatus.bsd = { ok: false, count: 0, message: '', diagnostic: '' };
  sourceStatus.sstats = { ok: false, count: 0, message: '', diagnostic: '' };
  const [bsd, sstats] = await Promise.all([runSource('bsd', fetchBSD), runSource('sstats', fetchSStats)]);
  const teamKey = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const bsdProbabilities = new Map();
  for (const row of bsd) {
    if (row.probabilityOutcome && row.probabilityOutcome !== '—') {
      bsdProbabilities.set(`${teamKey(row.home)}|${teamKey(row.away)}`, row.probabilityOutcome);
    }
  }
  for (const row of sstats) {
    const bsdProbability = bsdProbabilities.get(`${teamKey(row.home)}|${teamKey(row.away)}`);
    if (bsdProbability) row.probabilityOutcome = bsdProbability;
  }
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

module.exports = { buildData, normalizeBsd, normalizeSstats, arr, dateKey };
