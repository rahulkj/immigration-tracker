'use strict';

const DAY = 86400000;
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatIsoDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS_SHORT[m - 1]} ${d}, ${y}`;
}

const state = {
  data: null,
  bulletins: [],   // full dataset, all countries
  view: [],        // selected country, shaped for the charts/table
  country: 'IN',
  n400: null,
  office: null,
  tab: 'bulletins',
  charts: {},
  lastFetched: null,
  refreshing: false,
  range: 'all', // 'all' | number of years | { from, to }
};

const UNAVAILABLE = () => ({ status: 'unavailable', date: null, ts: null, label: 'Unavailable' });
const EMPTY_COUNTRY = () => ({
  eb2: { filing: UNAVAILABLE(), final: UNAVAILABLE() },
  eb3: { filing: UNAVAILABLE(), final: UNAVAILABLE() },
});

/** Project the full dataset onto the currently selected chargeability area. */
function setView() {
  const code = state.country;
  state.view = state.bulletins.map((b) => {
    const c = b.countries?.[code] || EMPTY_COUNTRY();
    return {
      id: b.id,
      label: b.label,
      shortLabel: b.shortLabel,
      year: b.year,
      month: b.month,
      eb2: c.eb2,
      eb3: c.eb3,
    };
  });
}

function countryName() {
  return state.data?.meta?.countries?.find((c) => c.code === state.country)?.name || state.country;
}

const $ = (id) => document.getElementById(id);

/* --------------------------------------------------------------- utilities */

function relTime(iso) {
  if (!iso) return 'unknown';
  const diff = Date.now() - Date.parse(iso);
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  let text;
  if (mins < 1) text = 'just now';
  else if (mins < 60) text = `${mins}m`;
  else if (mins < 1440) text = `${Math.round(mins / 60)}h`;
  else text = `${Math.round(mins / 1440)}d`;
  if (diff < 0) return `in ${text}`;
  return mins < 1 ? text : `${text} ago`;
}

function setDot(kind) {
  $('statusDot').className = `status-dot${kind === 'fresh' ? '' : ` ${kind}`}`;
}

function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 5000);
}

function showError(message) {
  const el = $('errorBox');
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideError() { $('errorBox').classList.add('hidden'); }

function movement(cell, prev) {
  if (cell.status !== 'date' || !prev || prev.status !== 'date') return { text: '', cls: '' };
  const d = Math.round((cell.ts - prev.ts) / DAY);
  if (!d) return { text: 'No change', cls: '' };
  const unit = Math.abs(d) === 1 ? 'day' : 'days';
  return d > 0
    ? { text: `Advanced ${d} ${unit}`, cls: 'good' }
    : { text: `Retrogressed ${Math.abs(d)} ${unit}`, cls: 'bad' };
}

/* ----------------------------------------------------------------- render */

function renderRange(bs) {
  $('rangeBadge').textContent = `${countryName()} · ${bs[0].label} — ${bs[bs.length - 1].label}`;
}

function renderCountrySelect() {
  const countries = state.data.meta.countries || [];
  $('countrySelect').innerHTML = countries
    .map((c) => `<option value="${c.code}">${c.name}</option>`).join('');
  $('countrySelect').value = state.country;
  for (const cat of ['eb2', 'eb3']) {
    $(`${cat}CountryName`).textContent = countryName();
  }
}

function renderKpis(bs) {
  const latest = bs[bs.length - 1];
  const prev = bs[bs.length - 2] || null;
  const fields = [
    { cat: 'eb2', key: 'filing', label: 'EB-2 · Dates for Filing', color: 'var(--filing)' },
    { cat: 'eb2', key: 'final', label: 'EB-2 · Final Action', color: 'var(--final)' },
    { cat: 'eb3', key: 'filing', label: 'EB-3 · Dates for Filing', color: 'var(--filing)' },
    { cat: 'eb3', key: 'final', label: 'EB-3 · Final Action', color: 'var(--final)' },
  ];
  $('kpis').innerHTML = fields.map((f) => {
    const cell = latest[f.cat][f.key];
    const prevCell = prev ? prev[f.cat][f.key] : null;
    const m = movement(cell, prevCell);
    const badge = m.text
      ? `<span class="delta ${m.cls}">${m.text}</span>`
      : `<span class="delta">${cell.status === 'date' ? 'First recorded' : cell.label}</span>`;
    return `<article class="kpi" style="--bar:${f.color}">
      <div class="kpi-label">${f.label}</div>
      <div class="kpi-value">${cell.label}</div>
      <div class="kpi-month">${latest.label} bulletin</div>
      ${badge}
    </article>`;
  }).join('');
}

function datasetFor(items, cat, field, label, color) {
  return {
    label,
    data: items.map((b) => b[cat][field].ts),
    cellLabels: items.map((b) => b[cat][field].label),
    borderColor: color,
    backgroundColor: color,
    pointBackgroundColor: '#fff',
    pointBorderColor: color,
    pointBorderWidth: 1.5,
    pointRadius: items.length > 120 ? 1.5 : 2,
    pointHoverRadius: 5,
    borderWidth: 2,
    tension: 0.25,
    spanGaps: false,
  };
}

function cssVar(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Chart colors follow the active theme's CSS variables. */
function chartColors() {
  return {
    muted: cssVar('--muted', '#667089'),
    grid: cssVar('--line-soft', '#eef1f7'),
    elevated: cssVar('--elevated', '#ffffff'),
    ink: cssVar('--ink', '#1f2740'),
    filing: cssVar('--filing', '#0ea5e9'),
    final: cssVar('--final', '#4f46e5'),
  };
}

function buildTimelineChart(canvasId, cat, bs) {
  const colors = chartColors();
  const labels = bs.map((b) => b.shortLabel);
  const values = [
    ...bs.map((b) => b[cat].filing.ts),
    ...bs.map((b) => b[cat].final.ts),
  ].filter((v) => v !== null);
  let min = Math.min(...values);
  let max = Math.max(...values);
  const span = max - min || 30 * DAY;
  min -= span * 0.08;
  max += span * 0.08;

  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [
        datasetFor(bs, cat, 'filing', 'Dates for Filing', colors.filing),
        datasetFor(bs, cat, 'final', 'Final Action', colors.final),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: colors.elevated,
          titleColor: colors.ink,
          bodyColor: colors.muted,
          borderColor: colors.grid,
          borderWidth: 1,
          callbacks: {
            title: (items) => bs[items[0].dataIndex]?.label || '',
            label: (ctx) => ` ${ctx.dataset.label}: ${ctx.dataset.cellLabels[ctx.dataIndex]}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxTicksLimit: 12, maxRotation: 0, autoSkip: true, color: colors.muted, font: { size: 11 } },
        },
        y: {
          type: 'linear',
          min,
          max,
          grid: { color: colors.grid },
          ticks: {
            maxTicksLimit: 8,
            color: colors.muted,
            font: { size: 11 },
            callback: (v) =>
              new Date(v).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
          },
        },
      },
    },
  };

  if (state.charts[canvasId]) state.charts[canvasId].destroy();
  state.charts[canvasId] = new Chart($(canvasId).getContext('2d'), config);
}

/** Bulletins currently selected for the charts (quick range or custom years). */
function visibleBulletins() {
  const bs = state.view;
  const r = state.range;
  if (r === 'all') return bs;
  if (typeof r === 'number') {
    const lastYear = bs[bs.length - 1].year;
    return bs.filter((b) => b.year > lastYear - r);
  }
  return bs.filter((b) => b.year >= r.from && b.year <= r.to);
}

/** Keep the year pickers in sync with the active chart range. */
function renderYearRangeControls() {
  const bs = state.view;
  const years = [...new Set(bs.map((b) => b.year))].sort((a, b) => a - b);
  const opts = years.map((y) => `<option value="${y}">${y}</option>`).join('');
  for (const id of ['fromYear', 'toYear']) $(id).innerHTML = opts;

  const r = state.range;
  const lastYear = bs[bs.length - 1].year;
  const from = r === 'all' ? years[0] : typeof r === 'number' ? Math.max(years[0], lastYear - r + 1) : r.from;
  const to = r === 'all' ? lastYear : typeof r === 'number' ? lastYear : r.to;
  $('fromYear').value = String(from);
  $('toYear').value = String(to);
}

/** Two cumulative charts: EB-2 and EB-3, each with Filing and Final Action lines. */
function renderCharts() {
  const shown = visibleBulletins();
  buildTimelineChart('chartEB2', 'eb2', shown);
  buildTimelineChart('chartEB3', 'eb3', shown);
  $('rangeHint').textContent =
    `${shown[0]?.label || '—'} – ${shown[shown.length - 1]?.label || '—'} · ` +
    `${shown.length} of ${state.view.length} bulletins shown. ` +
    'The full history remains in the table and CSV download.';
}

function applyRange(range) {
  state.range = range;
  document.querySelectorAll('.seg').forEach((b) => {
    b.classList.toggle('active', String(b.dataset.range) === String(range));
  });
  renderYearRangeControls();
  renderCharts();
}

function cellHtml(cell, prev) {
  if (cell.status === 'date') {
    const m = movement(cell, prev);
    const move = m.text ? `<span class="cell-move ${m.cls}">${m.text}</span>` : '';
    return `<span class="cell-date">${cell.label}</span>${move}`;
  }
  const cls = cell.status === 'current' ? 'current' : 'unavailable';
  return `<span class="badge ${cls}">${cell.label}</span>`;
}

function renderYearFilter(bs) {
  const select = $('yearFilter');
  const years = [...new Set(bs.map((b) => b.year))].sort((a, b) => b - a);
  const current = select.value;
  select.innerHTML = '<option value="all">All years</option>' +
    years.map((y) => `<option value="${y}">${y}</option>`).join('');
  select.value = years.includes(Number(current)) ? current : 'all';
}

function renderTable() {
  const bs = state.view;
  const reversed = [...bs].reverse();
  const year = $('yearFilter').value;
  const shown = reversed.filter((b) => year === 'all' || String(b.year) === year);
  $('historyTable').querySelector('tbody').innerHTML = shown.map((b) => {
    const idx = reversed.indexOf(b);
    const p = reversed[idx + 1] || null;
    return `<tr>
      <td>${b.label}</td>
      <td>${cellHtml(b.eb2.filing, p?.eb2.filing)}</td>
      <td>${cellHtml(b.eb2.final, p?.eb2.final)}</td>
      <td>${cellHtml(b.eb3.filing, p?.eb3.filing)}</td>
      <td>${cellHtml(b.eb3.final, p?.eb3.final)}</td>
    </tr>`;
  }).join('');
  $('tableNote').textContent = `Showing ${shown.length} of ${bs.length} bulletins.` +
    (year === 'all' ? '' : ` Filtered to ${year}.`);
}

function renderSourceNote() {
  const m = state.data.meta;
  const official = m.official?.used;
  $('sourceNote').innerHTML =
    `Data source: <strong>${m.source || 'U.S. Department of State Visa Bulletin'}</strong>` +
    (official ? ` · newest bulletin verified directly at travel.state.gov (${official.id})` : '') +
    `. Last refreshed ${relTime(m.fetchedAt)}.`;
}

function renderAll() {
  state.bulletins = state.data.bulletins;
  setView();
  const bs = state.view;
  renderCountrySelect();
  renderRange(bs);
  renderKpis(bs);
  renderYearFilter(bs);
  renderYearRangeControls();
  renderCharts();
  renderTable();
  renderSourceNote();
}

/* ------------------------------------------------------------------ loading */

async function loadData() {
  const res = await fetch('/api/data');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  state.data = await res.json();
  state.lastFetched = state.data.meta.fetchedAt;
  renderAll();
  hideError();
}

async function pollStatus() {
  let s;
  try {
    s = await fetch('/api/status').then((r) => r.json());
  } catch (_) { return; }
  const stale = Date.now() - Date.parse(s.fetchedAt || 0) > 12 * 3600 * 1000;
  setDot(s.isRefreshing ? 'busy' : stale ? 'stale' : 'fresh');
  $('statusText').textContent = s.isRefreshing
    ? 'Refreshing latest bulletin…'
    : `Updated ${relTime(s.fetchedAt)} · next check ${relTime(s.nextRefreshAt)}`;
  if (s.fetchedAt && s.fetchedAt !== state.lastFetched) {
    try { await loadData(); } catch (e) { /* keep showing existing data */ }
  }
  if (s.n400?.fetchedAt && s.n400.fetchedAt !== state.n400Fetched) {
    try { await loadN400(); } catch (e) { /* keep showing saved N-400 data */ }
  }
}

async function doRefresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  const btn = $('refreshBtn');
  btn.disabled = true;
  btn.querySelector('.btn-label').textContent = 'Refreshing…';
  setDot('busy');
  toast('Checking for new visa bulletins and N-400 dates…');
  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'Refresh failed');
    await loadData();
    try { await loadN400(); } catch (e) { /* keep the saved N-400 snapshot */ }
    const official = out.official?.used ? ` · verified ${out.official.used.id} officially` : '';
    const nat = out.n400?.ok ? ` · N-400 release ${out.n400.releaseTag}` : '';
    toast(`Up to date: ${out.total} bulletins through ${out.lastBulletin}${official}${nat}`);
  } catch (e) {
    showError(`Could not refresh data: ${e.message}. Showing the last saved dataset.`);
    toast(`Refresh failed: ${e.message}`, true);
  } finally {
    state.refreshing = false;
    btn.disabled = false;
    btn.querySelector('.btn-label').textContent = 'Refresh data';
    pollStatus();
  }
}

function downloadCsv() {
  const header = `bulletin,country,eb2_filing,eb2_final_action,eb3_filing,eb3_final_action`;
  const rows = state.view.map((b) => [
    b.id,
    state.country,
    b.eb2.filing.date || b.eb2.filing.status,
    b.eb2.final.date || b.eb2.final.status,
    b.eb3.filing.date || b.eb3.filing.status,
    b.eb3.final.date || b.eb3.final.status,
  ].join(','));
  const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.country.toLowerCase()}-eb2-eb3-priority-dates.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------- naturalization */

function n400OfficeName(code) {
  return state.n400?.offices?.find((o) => o.code === code)?.name || code;
}

function n400ReleaseLabel(tag) {
  const [year, month] = tag.split('-');
  return `${MONTHS_SHORT[Number(month) - 1]} '${String(year).slice(2)}`;
}

function renderN400Controls() {
  const snap = state.n400.snapshots[state.n400.snapshots.length - 1];
  const offices = state.n400.offices.filter((o) => snap.values[o.code]);
  $('officeSelect').innerHTML = offices
    .map((o) => `<option value="${o.code}">${o.name}</option>`).join('');
  if (!state.office || !snap.values[state.office]) {
    state.office = offices.find((o) => o.code === 'NYC')?.code || offices[0]?.code;
  }
  $('officeSelect').value = state.office;
}

function renderN400Kpis() {
  const snaps = state.n400.snapshots;
  const latest = snaps[snaps.length - 1];
  const current = latest.values[state.office];
  const previous = snaps.length > 1 ? snaps[snaps.length - 2].values[state.office] : null;
  const move = movement(current.inquiry, previous?.inquiry);
  const cards = [
    {
      label: 'Case inquiry date',
      value: current.inquiry.label,
      sub: `${n400OfficeName(state.office)} · ${latest.tag}`,
      badge: move.text ? { text: move.text, cls: move.cls } : null,
      bar: 'var(--final)',
    },
    {
      label: 'Processing time',
      value: `${current.lower} – ${current.upper} ${current.unit}`,
      sub: '80% of completed cases',
      badge: null,
      bar: 'var(--filing)',
    },
    {
      label: 'USCIS data published',
      value: formatIsoDate(latest.publicationDate),
      sub: `${snaps.length} snapshots tracked`,
      badge: null,
      bar: 'var(--accent)',
    },
  ];
  $('n400Kpis').innerHTML = cards.map((c) => `<article class="kpi" style="--bar:${c.bar}">
    <div class="kpi-label">${c.label}</div>
    <div class="kpi-value">${c.value}</div>
    <div class="kpi-month">${c.sub}</div>
    ${c.badge ? `<span class="delta ${c.badge.cls}">${c.badge.text}</span>` : ''}
  </article>`).join('');
}

function buildN400Chart() {
  if (!state.n400 || !state.office) return;
  const snaps = state.n400.snapshots;
  const labels = snaps.map((s) => n400ReleaseLabel(s.tag));
  const values = snaps.map((s) => s.values[state.office]?.inquiry?.ts ?? null);
  const cellLabels = snaps.map((s) => s.values[state.office]?.inquiry?.label ?? 'Unavailable');
  const points = values.filter((v) => v !== null);
  if (!points.length) return;

  let min = Math.min(...points);
  let max = Math.max(...points);
  const span = Math.max(max - min, 30 * DAY);
  min -= span * 0.12;
  max += span * 0.12;
  const colors = chartColors();
  const id = 'chartN400';
  if (state.charts[id]) {
    state.charts[id].destroy();
    delete state.charts[id];
  }

  state.charts[id] = new Chart($(id).getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Case inquiry date',
        data: values,
        cellLabels,
        borderColor: colors.final,
        backgroundColor: colors.final,
        pointBackgroundColor: colors.elevated,
        pointBorderColor: colors.final,
        pointBorderWidth: 1.5,
        pointRadius: 2.5,
        pointHoverRadius: 5,
        borderWidth: 2,
        tension: 0.25,
        spanGaps: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: colors.elevated,
          titleColor: colors.ink,
          bodyColor: colors.muted,
          borderColor: colors.grid,
          borderWidth: 1,
          callbacks: {
            title: (items) => `${n400OfficeName(state.office)} · release ${snaps[items[0].dataIndex].tag}`,
            label: (ctx) => ` Case inquiry date: ${ctx.dataset.cellLabels[ctx.dataIndex]}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxTicksLimit: 12, maxRotation: 0, autoSkip: true, color: colors.muted, font: { size: 11 } },
        },
        y: {
          type: 'linear',
          min,
          max,
          grid: { color: colors.grid },
          ticks: {
            maxTicksLimit: 8,
            color: colors.muted,
            font: { size: 11 },
            callback: (v) =>
              new Date(v).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
          },
        },
      },
    },
  });
}

function renderN400Table() {
  const snap = state.n400.snapshots[state.n400.snapshots.length - 1];
  const query = $('officeSearch').value.trim().toLowerCase();
  const offices = state.n400.offices
    .filter((o) => snap.values[o.code])
    .filter((o) => !query || o.name.toLowerCase().includes(query) || o.code.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));

  $('n400Table').querySelector('tbody').innerHTML = offices.map((o) => {
    const v = snap.values[o.code];
    return `<tr>
      <td>${o.name} <span class="cell-move">(${o.code})</span></td>
      <td class="cell-date">${v.inquiry.label}</td>
      <td>${v.lower} – ${v.upper} ${v.unit}</td>
      <td class="cell-date">${formatIsoDate(snap.publicationDate)}</td>
    </tr>`;
  }).join('');
  $('n400Note').textContent =
    `Showing ${offices.length} of ${state.n400.offices.length} field offices. ` +
    'The case inquiry date is the receipt date USCIS is currently processing for that office.';
}

function renderN400() {
  renderN400Controls();
  renderN400Kpis();
  buildN400Chart();
  renderN400Table();
  const snap = state.n400.snapshots[state.n400.snapshots.length - 1];
  $('n400AsOf').textContent = `USCIS data as of ${formatIsoDate(snap.publicationDate)}`;
  $('n400Source').textContent = `${state.n400.meta.source} · release ${state.n400.meta.releaseTag}`;
}

async function loadN400() {
  const res = await fetch('/api/n400');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  state.n400 = await res.json();
  if (!state.n400.snapshots?.length) throw new Error('No N-400 snapshots available');
  state.n400Fetched = state.n400.meta.fetchedAt;
  renderN400();
}

function downloadN400Csv() {
  const snap = state.n400.snapshots[state.n400.snapshots.length - 1];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['field_office,office_code,case_inquiry_date,processing_lower,processing_upper,unit,publication_date'];
  for (const o of state.n400.offices) {
    const v = snap.values[o.code];
    if (!v) continue;
    lines.push([o.name, o.code, v.inquiry.date, v.lower, v.upper, v.unit, snap.publicationDate].map(esc).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'n400-processing-dates.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/* --------------------------------------------------------------- tabs & calc */

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  $('tab-bulletins').classList.toggle('hidden', tab !== 'bulletins');
  $('tab-naturalization').classList.toggle('hidden', tab !== 'naturalization');
  // Charts created while a panel was hidden need a resize once visible.
  const resize = () => Object.values(state.charts).forEach((c) => c.resize?.());
  if (window.requestAnimationFrame) window.requestAnimationFrame(resize);
  else resize();
}

function isoDate(date) { return date.toISOString().slice(0, 10); }

function addYears(iso, years) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d;
}

function addDays(date, days) { return new Date(date.getTime() + days * DAY); }

function maxDate(...dates) {
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

function calcError(message) {
  $('calcResult').innerHTML = `<p class="calc-empty" style="color:var(--bad)">${message}</p>`;
}

function calculateEligibility() {
  const lpr = $('calcLprDate').value;
  if (!lpr) return calcError('Enter the date you became a permanent resident.');

  const rule = Number($('calcRule').value);
  let anniversary = addYears(lpr, rule);
  if (rule === 3) {
    const marriage = $('calcMarriageDate').value;
    if (!marriage) return calcError('Enter your marriage date for the 3-year rule.');
    const cohabit = $('calcCohabitDate').value || marriage;
    anniversary = maxDate(anniversary, addYears(marriage, 3), addYears(cohabit, 3));
  }

  const earliest = addDays(anniversary, -90);
  const days = Math.ceil((earliest.getTime() - Date.now()) / DAY);
  const trip = Number($('calcTripMonths').value) || 0;
  const requiredMonths = rule === 3 ? 18 : 30;

  let warning = '';
  if (trip >= 12) {
    warning = 'A single trip of 12 months or more generally breaks continuous residence — you may need to re-establish it before filing.';
  } else if (trip > 6) {
    warning = 'A trip longer than 6 months can break continuous residence. Keep evidence that you did not abandon your U.S. residence.';
  }

  const waitText = days > 0 ? `${days.toLocaleString()} days from now` : 'You may be eligible now';
  $('calcResult').innerHTML = `
    <div class="calc-result-label">Earliest you can file Form N-400</div>
    <div class="calc-big-date">${formatIsoDate(isoDate(earliest))}</div>
    <p class="calc-sub">${rule}-year rule · 90 days before your ${formatIsoDate(isoDate(anniversary))} anniversary</p>
    <div class="calc-grid">
      <div class="calc-stat"><span>Full eligibility date</span><strong>${formatIsoDate(isoDate(anniversary))}</strong></div>
      <div class="calc-stat"><span>Earliest filing</span><strong>${waitText}</strong></div>
    </div>
    <p class="calc-note">You must also have been physically present in the U.S. for at least ${requiredMonths} months during the qualifying period.</p>
    ${warning ? `<p class="calc-warn">${warning}</p>` : ''}
  `;
  $('calcResult').dataset.calculated = '1';
}

/* --------------------------------------------------------------------- theme */

function applyTheme(theme, persist = true) {
  document.documentElement.setAttribute('data-theme', theme);
  if (persist) {
    try { localStorage.setItem('vm-theme', theme); } catch (e) { /* ignore */ }
  }
  const dark = theme === 'dark';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  const btn = $('themeBtn');
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
  if (state.data) renderCharts(); // rebuild charts with theme-aware colors
  if (state.n400) buildN400Chart();
}

/* --------------------------------------------------------------------- init */

$('refreshBtn').addEventListener('click', doRefresh);

document.querySelectorAll('.tab-btn').forEach((b) => {
  b.addEventListener('click', () => setTab(b.dataset.tab));
});

$('calcRule').addEventListener('change', () => {
  $('calcMarriageFields').classList.toggle('hidden', $('calcRule').value !== '3');
  if ($('calcResult').dataset.calculated) calculateEligibility();
});
$('calcButton').addEventListener('click', calculateEligibility);
['calcLprDate', 'calcMarriageDate', 'calcCohabitDate', 'calcTripMonths'].forEach((id) => {
  $(id).addEventListener('change', () => {
    if ($('calcResult').dataset.calculated) calculateEligibility();
  });
});

$('yearFilter').addEventListener('change', renderTable);
$('downloadCsv').addEventListener('click', downloadCsv);
$('countrySelect').addEventListener('change', (e) => {
  state.country = e.target.value;
  renderAll();
});

document.querySelectorAll('.seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    const value = btn.dataset.range;
    applyRange(value === 'all' ? 'all' : Number(value));
  });
});

function onYearRangeChange() {
  let from = Number($('fromYear').value);
  let to = Number($('toYear').value);
  if (from > to) [from, to] = [to, from];
  applyRange({ from, to });
}
$('fromYear').addEventListener('change', onYearRangeChange);
$('toYear').addEventListener('change', onYearRangeChange);

$('officeSelect').addEventListener('change', (e) => {
  state.office = e.target.value;
  renderN400Kpis();
  buildN400Chart();
});
$('officeSearch').addEventListener('input', renderN400Table);
$('downloadN400Csv').addEventListener('click', downloadN400Csv);

$('themeBtn').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// Follow the OS theme only while the user hasn't chosen one explicitly.
if (window.matchMedia) {
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemThemeChange = (e) => {
    let saved = null;
    try { saved = localStorage.getItem('vm-theme'); } catch (err) { /* ignore */ }
    if (!saved) applyTheme(e.matches ? 'dark' : 'light', false);
  };
  if (darkQuery.addEventListener) darkQuery.addEventListener('change', onSystemThemeChange);
  else if (darkQuery.addListener) darkQuery.addListener(onSystemThemeChange);
}

applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light', false);

(async function init() {
  try {
    await loadData();
  } catch (e) {
    showError(`Unable to load data: ${e.message}`);
    setDot('stale');
  }
  try {
    await loadN400();
  } catch (e) {
    console.error('N-400 data unavailable:', e.message);
  }
  pollStatus();
  setInterval(pollStatus, 60000);
})();
