/* Football predictions UI. Vercel serves this static UI and the Node.js /api/data function. */
const $ = (id) => document.getElementById(id);
let allPredictions = [];
let sortKey = 'time';
let sortAscending = true;

function text(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}
function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
function sortPredictions(rows) {
  return [...rows].sort((a, b) => {
    let left = a[sortKey] ?? '';
    let right = b[sortKey] ?? '';
    if (sortKey === 'time') {
      left = Date.parse(left) || 0;
      right = Date.parse(right) || 0;
    } else {
      left = String(left).toLocaleLowerCase('ru');
      right = String(right).toLocaleLowerCase('ru');
    }
    const result = left < right ? -1 : left > right ? 1 : 0;
    return sortAscending ? result : -result;
  });
}
function addCell(row, value, className) {
  const cell = document.createElement('td');
  cell.textContent = text(value);
  if (className) cell.className = className;
  row.appendChild(cell);
}
function renderTable() {
  const tbody = $('table-body');
  tbody.replaceChildren();
  const rows = sortPredictions(allPredictions);
  $('empty-state').classList.toggle('hidden', rows.length > 0);
  for (const item of rows) {
    const tr = document.createElement('tr');
    addCell(tr, formatTime(item.time));
    addCell(tr, item.league);
    addCell(tr, item.home);
    addCell(tr, item.away);
    addCell(tr, item.outcome, 'prediction-cell');
    addCell(tr, item.probabilityOutcome, 'prediction-cell');
    addCell(tr, item.totalGoals, 'prediction-cell');
    addCell(tr, item.individualTotals, 'prediction-cell');
    addCell(tr, item.corners, 'prediction-cell');
    addCell(tr, item.yellowCards, 'prediction-cell');
    addCell(tr, item.source, 'source-cell');
    tbody.appendChild(tr);
  }
}
function setSourceStatus(id, name, status) {
  const el = $(id);
  const count = Number(status?.count || 0);
  if (status?.ok) {
    el.textContent = `${name}: ${count} матчей`;
    el.className = 'status-badge ok';
  } else {
    el.textContent = `${name}: нет данных`;
    el.className = 'status-badge error';
  }
}
async function loadAll(requestRefresh = false) {
  const button = $('refresh-btn');
  const loading = $('loading');
  const errorBox = $('error-container');
  button.disabled = true;
  loading.classList.remove('hidden');
  errorBox.classList.add('hidden');
  $('status-bsd').textContent = 'BSD: загрузка…';
  $('status-sstats').textContent = 'SStats: загрузка…';
  try {
    if (requestRefresh) {
      const refreshResponse = await fetch('/api/data', { method: 'POST' });
      const refreshResult = await refreshResponse.json().catch(() => ({}));
      if (!refreshResponse.ok) throw new Error(refreshResult.message || 'Не удалось обновить прогнозы.');
    }
    const response = await fetch(`/api/data?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Не удалось загрузить data.json (HTTP ${response.status})`);
    const data = await response.json();
    allPredictions = Array.isArray(data.predictions) ? data.predictions : [];
    setSourceStatus('status-bsd', 'BSD', data.sources?.bsd);
    setSourceStatus('status-sstats', 'SStats', data.sources?.sstats);
    const generatedAt = data.generatedAt ? new Date(data.generatedAt) : null;
    $('current-date').textContent = generatedAt && !Number.isNaN(generatedAt.getTime())
      ? `Матчи на ${data.date || 'сегодня'} · обновлено ${generatedAt.toLocaleString('ru-RU')}`
      : `Матчи на ${data.date || 'сегодня'}`;
    if (data.errors?.length) {
      $('error-message').textContent = data.errors.join(' · ');
      errorBox.classList.remove('hidden');
    }
    renderTable();
  } catch (error) {
    $('error-message').textContent = error.message || 'Не удалось загрузить данные.';
    errorBox.classList.remove('hidden');
    allPredictions = [];
    renderTable();
  } finally {
    loading.classList.add('hidden');
    button.disabled = false;
  }
}
document.addEventListener('DOMContentLoaded', () => {
  $('refresh-btn').addEventListener('click', () => loadAll(true));
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortAscending = !sortAscending;
      else { sortKey = key; sortAscending = true; }
      document.querySelectorAll('th[data-sort]').forEach((item) => {
        item.setAttribute('aria-sort', item === th ? (sortAscending ? 'ascending' : 'descending') : 'none');
      });
      renderTable();
    });
  });
  loadAll();
});
