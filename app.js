/**
 * Football Predictions Aggregator
 * Получает прогнозы из Bzzoiro Sports Data и SStats.net,
 * объединяет и отображает в таблице.
 *
 * Токены инжектируются во время сборки GitHub Actions
 * через переменные окружения: BSD_TOKEN, SSTATS_TOKEN.
 */

// ─── Конфигурация ───────────────────────────────────────────────
const CONFIG = {
    bsd: {
        baseUrl: 'https://sports.bzzoiro.com/api/v2',
        token: '__BSD_TOKEN__', // заменяется при сборке
    },
    sstats: {
        baseUrl: 'https://api.sstats.net',
        token: '__SSTATS_TOKEN__', // заменяется при сборке
    },
    // CORS-прокси (при необходимости). Можно развернуть свой Cloudflare Worker.
    corsProxy: 'https://corsproxy.io/?',
};

// ─── Утилиты ────────────────────────────────────────────────────
function todayISO() {
    return new Date().toISOString().slice(0, 10);
}

function formatTime(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function proxied(url) {
    // Если API не поддерживает CORS, пропускаем через прокси.
    // Для собственного Cloudflare Worker замените CONFIG.corsProxy.
    return CONFIG.corsProxy ? CONFIG.corsProxy + encodeURIComponent(url) : url;
}

async function fetchJSON(url, headers = {}) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

// ─── Загрузка из Bzzoiro Sports Data ────────────────────────────
async function fetchBSDPredictions(date) {
    const headers = {
        'Authorization': `Token ${CONFIG.bsd.token}`,
        'Accept': 'application/json',
    };

    // 1. Список матчей на дату
    const eventsUrl = `${CONFIG.bsd.baseUrl}/events/?date_from=${date}&date_to=${date}&status=upcoming`;
    const eventsData = await fetchJSON(proxied(eventsUrl), headers);
    const events = eventsData.results || eventsData;

    if (!Array.isArray(events) || events.length === 0) return [];

    // 2. Для каждого матча запрашиваем прогнозы (параллельно, с ограничением)
    const predictions = await Promise.allSettled(
        events.map(async (ev) => {
            const predUrl = `${CONFIG.bsd.baseUrl}/events/${ev.id}/predictions/`;
            try {
                const pred = await fetchJSON(proxied(predUrl), headers);
                return { event: ev, prediction: pred };
            } catch {
                return { event: ev, prediction: null };
            }
        })
    );

    return predictions
        .filter(p => p.status === 'fulfilled' && p.value.prediction)
        .map(p => normalizeBSDPrediction(p.value.event, p.value.prediction));
}

function normalizeBSDPrediction(event, pred) {
    // Извлекаем рынки из ответа. Структура может варьироваться —
    // адаптируйте под реальный формат ответа BSD.
    const markets = pred.markets || pred.predictions || {};

    return {
        source: 'BSD',
        time: event.start_time || event.date,
        league: event.league?.name || event.competition?.name || '—',
        home: event.home_team?.name || event.home?.name || '—',
        away: event.away_team?.name || event.away?.name || '—',
        outcome: extractMarket(markets, ['1x2', 'match_winner', 'outcome']),
        totalGoals: extractMarket(markets, ['total_goals', 'over_under', 'ou', 'goals_total']),
        individualTotals: extractMarket(markets, ['individual_total', 'team_total', 'home_total', 'away_total']),
        corners: extractMarket(markets, ['corners', 'total_corners', 'corner_total']),
        yellowCards: extractMarket(markets, ['yellow_cards', 'cards', 'total_cards']),
    };
}

function extractMarket(markets, keys) {
    for (const key of keys) {
        if (markets[key]) {
            const m = markets[key];
            // Пытаемся извлечь читаемое предсказание
            if (typeof m === 'string') return m;
            if (m.prediction) return m.prediction;
            if (m.pick) return m.pick;
            if (m.value) return m.value;
            if (m.probability) {
                // Если есть только вероятность — берём наиболее вероятный исход
                if (typeof m.probability === 'object') {
                    const best = Object.entries(m.probability).sort((a, b) => b[1] - a[1])[0];
                    return `${best[0]} (${(best[1] * 100).toFixed(0)}%)`;
                }
            }
        }
    }
    return '—';
}

// ─── Загрузка из SStats.net ────────────────────────────────────
async function fetchSStatsPredictions(date) {
    const headers = {
        'Authorization': `ApiKey ${CONFIG.sstats.token}`,
        'Accept': 'application/json',
    };

    // SStats: список игр на сегодня с прогнозами.
    // Эндпоинт может отличаться — уточните в документации sstats.net/api.
    const url = `${CONFIG.sstats.baseUrl}/games?Today=true&Limit=100&IncludePredictions=true`;
    const data = await fetchJSON(proxied(url), headers);

    const games = data.data || data.results || data;
    if (!Array.isArray(games)) return [];

    return games.map(g => normalizeSStatsPrediction(g));
}

function normalizeSStatsPrediction(game) {
    const preds = game.predictions || game.prediction || {};

    return {
        source: 'SStats',
        time: game.date || game.startTime || game.kickoff,
        league: game.leagueName || game.league?.name || '—',
        home: game.homeTeamName || game.homeTeam?.name || '—',
        away: game.awayTeamName || game.awayTeam?.name || '—',
        outcome: extractSStatsPrediction(preds, ['1x2', 'matchResult', 'outcome', 'winner']),
        totalGoals: extractSStatsPrediction(preds, ['totalGoals', 'overUnder', 'goalsTotal']),
        individualTotals: extractSStatsPrediction(preds, ['individualTotal', 'teamTotal']),
        corners: extractSStatsPrediction(preds, ['corners', 'totalCorners']),
        yellowCards: extractSStatsPrediction(preds, ['yellowCards', 'cards']),
    };
}

function extractSStatsPrediction(preds, keys) {
    for (const key of keys) {
        const p = preds[key];
        if (!p) continue;
        if (typeof p === 'string') return p;
        if (p.prediction) return p.prediction;
        if (p.pick) return p.pick;
        if (p.value) return p.value;
        if (p.advice) return p.advice;
        if (p.probability != null) {
            return `${p.name || p.outcome || '—'} (${(p.probability * 100).toFixed(0)}%)`;
        }
    }
    return '—';
}

// ─── Объединение и рендеринг ───────────────────────────────────
let allPredictions = [];

function renderTable(predictions) {
    const tbody = document.getElementById('table-body');
    const emptyState = document.getElementById('empty-state');
    tbody.innerHTML = '';

    if (!predictions.length) {
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    for (const p of predictions) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${formatTime(p.time)}</td>
            <td>${p.league}</td>
            <td>${p.home}</td>
            <td>${p.away}</td>
            <td class="prediction-cell">${p.outcome}</td>
            <td class="prediction-cell">${p.totalGoals}</td>
            <td class="prediction-cell">${p.individualTotals}</td>
            <td class="prediction-cell">${p.corners}</td>
            <td class="prediction-cell">${p.yellowCards}</td>
            <td><span class="status-badge">${p.source}</span></td>
        `;
        tbody.appendChild(tr);
    }
}

function sortPredictions(list, key, asc = true) {
    return [...list].sort((a, b) => {
        let va = a[key] ?? '';
        let vb = b[key] ?? '';
        if (key === 'time') {
            va = new Date(va).getTime() || 0;
            vb = new Date(vb).getTime() || 0;
        }
        if (va < vb) return asc ? -1 : 1;
        if (va > vb) return asc ? 1 : -1;
        return 0;
    });
}

// ─── Основной сценарий ─────────────────────────────────────────
async function loadAll() {
    const loading = document.getElementById('loading');
    const errorContainer = document.getElementById('error-container');
    const errorMessage = document.getElementById('error-message');
    const statusBSD = document.getElementById('status-bsd');
    const statusSStats = document.getElementById('status-sstats');

    loading.classList.remove('hidden');
    errorContainer.classList.add('hidden');
    statusBSD.textContent = 'BSD: загрузка…';
    statusBSD.className = 'status-badge';
    statusSStats.textContent = 'SStats: загрузка…';
    statusSStats.className = 'status-badge';

    const date = todayISO();
    document.getElementById('current-date').textContent =
        new Date().toLocaleDateString('ru-RU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const errors = [];

    // Загружаем оба источника параллельно
    const [bsdResult, sstatsResult] = await Promise.allSettled([
        fetchBSDPredictions(date),
        fetchSStatsPredictions(date),
    ]);

    let bsdData = [];
    let sstatsData = [];

    if (bsdResult.status === 'fulfilled') {
        bsdData = bsdResult.value;
        statusBSD.textContent = `BSD: ${bsdData.length} прогнозов`;
        statusBSD.className = 'status-badge ok';
    } else {
        statusBSD.textContent = 'BSD: ошибка';
        statusBSD.className = 'status-badge error';
        errors.push(`Bzzoiro: ${bsdResult.reason?.message || 'неизвестная ошибка'}`);
    }

    if (sstatsResult.status === 'fulfilled') {
        sstatsData = sstatsResult.value;
        statusSStats.textContent = `SStats: ${sstatsData.length} прогнозов`;
        statusSStats.className = 'status-badge ok';
    } else {
        statusSStats.textContent = 'SStats: ошибка';
        statusSStats.className = 'status-badge error';
        errors.push(`SStats: ${sstatsResult.reason?.message || 'неизвестная ошибка'}`);
    }

    if (errors.length) {
        errorMessage.textContent = errors.join(' | ');
        errorContainer.classList.remove('hidden');
    }

    // Объединяем и сортируем по времени
    allPredictions = [...bsdData, ...sstatsData];
    allPredictions = sortPredictions(allPredictions, 'time', true);

    renderTable(allPredictions);
    loading.classList.add('hidden');
}

// ─── Инициализация ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('refresh-btn').addEventListener('click', loadAll);
    document.querySelectorAll('th[data-sort]').forEach(th => {
        let asc = true;
        th.addEventListener('click', () => {
            const key = th.dataset.sort;
            allPredictions = sortPredictions(allPredictions, key, asc);
            asc = !asc;
            renderTable(allPredictions);
        });
    });
    loadAll();
});