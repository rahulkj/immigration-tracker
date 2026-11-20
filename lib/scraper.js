'use strict';

/**
 * Data acquisition for Immigration Tracker.
 *
 * Two sources are used:
 *
 * 1. Primary (always): the openly-licensed, machine-readable Visa Bulletin
 *    dataset maintained by armanckeser/visa-bulletin-data (CC0). A GitHub
 *    Action refreshes it daily from the official bulletins. This is what
 *    makes the site reliably dynamic even when travel.state.gov blocks
 *    automated traffic with Cloudflare.
 *
 * 2. Opportunistic (best effort): a direct scrape of the official
 *    travel.state.gov bulletin page for the newest month. If it succeeds it
 *    can surface a brand-new bulletin before the upstream mirror updates.
 *    Failures (403, timeouts, layout changes) are swallowed and logged.
 */

const cheerio = require('cheerio');
const store = require('./store');

const UPSTREAM_CSV =
  'https://raw.githubusercontent.com/armanckeser/visa-bulletin-data/main/data/visa_bulletin.csv';
const SOURCE_NAME = 'armanckeser/visa-bulletin-data (CC0 public-domain mirror)';
const OFFICIAL_ENABLED = process.env.OFFICIAL_SCRAPE !== 'false';
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 12000);

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3));

/** Chargeability areas published in the bulletin (codes used by the upstream CSV). */
const COUNTRY_NAMES = {
  IN: 'India',
  CN: 'China (mainland born)',
  MX: 'Mexico',
  PH: 'Philippines',
  ROW: 'All Chargeability Areas (Rest of World)',
  SV_GT_HN: 'El Salvador / Guatemala / Honduras',
  VN: 'Vietnam',
};

/* ------------------------------------------------------------------ helpers */

const norm = (s) =>
  String(s ?? '')
    .replace(/[\u00a0\u2000-\u200b\u202f\u2060\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const key = (s) => norm(s).toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();

function parseBulletinId(id) {
  const [year, month] = String(id).split('-').map(Number);
  return { year, month };
}

function formatMonthLabel(id) {
  const { year, month } = parseBulletinId(id);
  return `${MONTH_ABBR[month - 1]} ${year}`;
}

function formatShortMonth(id) {
  const { year, month } = parseBulletinId(id);
  return `${MONTH_ABBR[month - 1]} '${String(year).slice(2)}`;
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTH_ABBR[m - 1]} ${d}, ${y}`;
}

function cellFromRow(row) {
  const status = row.status === 'date' ? 'date' : row.status === 'current' ? 'current' : 'unavailable';
  const date = status === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(row.date || '') ? row.date : null;
  const ts = date ? Date.parse(`${date}T00:00:00Z`) : null;
  const label = status === 'date' ? formatDate(date) : status === 'current' ? 'Current' : 'Unavailable';
  return { status, date, ts, label };
}

const EMPTY_CELL = () => ({ status: 'unavailable', date: null, ts: null, label: 'Unavailable' });

/* --------------------------------------------------------------- CSV source */

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Filter the upstream long-format CSV down to EB-2 / EB-3 rows for all countries. */
function parseUpstreamCsv(csv) {
  const lines = String(csv).trim().split(/\r?\n/);
  if (!lines.length) throw new Error('Upstream CSV is empty');
  const header = splitCsvLine(lines.shift());
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const need = ['bulletin', 'chart', 'kind', 'category', 'country', 'status', 'date'];
  for (const n of need) if (!(n in idx)) throw new Error(`Upstream CSV missing column: ${n}`);

  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const c = splitCsvLine(line);
    const bulletin = (c[idx.bulletin] || '').trim();
    const chart = (c[idx.chart] || '').trim();
    const kind = (c[idx.kind] || '').trim();
    const category = (c[idx.category] || '').trim();
    const country = (c[idx.country] || '').trim();
    if (kind !== 'employment') continue;
    if (!(country in COUNTRY_NAMES)) continue;
    if (category !== 'EB2' && category !== 'EB3') continue;
    if (chart !== 'final_action' && chart !== 'dates_for_filing') continue;
    if (bulletin < '2020-01') continue;
    rows.push({
      bulletin,
      chart,
      category,
      country,
      status: (c[idx.status] || '').trim(),
      date: (c[idx.date] || '').trim(),
    });
  }
  if (!rows.length) throw new Error('Upstream CSV contained no EB-2/EB-3 rows since 2020');
  return rows;
}

/** Countries present in a set of rows, India first. */
function countriesIn(rows) {
  const present = new Set(rows.map((r) => r.country));
  const order = Object.keys(COUNTRY_NAMES);
  return [...present]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((code) => ({ code, name: COUNTRY_NAMES[code] || code }));
}

const emptyCountry = () => ({
  eb2: { filing: EMPTY_CELL(), final: EMPTY_CELL() },
  eb3: { filing: EMPTY_CELL(), final: EMPTY_CELL() },
});

/**
 * Turn flat rows into a per-month dataset with every chargeability area
 * nested under `countries`, so the UI can switch countries instantly.
 */
function buildDataset(rows) {
  const allCountries = [...new Set(rows.map((r) => r.country))];
  const byMonth = new Map();
  for (const row of rows) {
    if (!byMonth.has(row.bulletin)) {
      byMonth.set(row.bulletin, {
        id: row.bulletin,
        label: formatMonthLabel(row.bulletin),
        shortLabel: formatShortMonth(row.bulletin),
        year: parseBulletinId(row.bulletin).year,
        month: parseBulletinId(row.bulletin).month,
        countries: Object.fromEntries(allCountries.map((c) => [c, emptyCountry()])),
      });
    }
    const entry = byMonth.get(row.bulletin);
    const group = row.category === 'EB2'
      ? entry.countries[row.country].eb2
      : entry.countries[row.country].eb3;
    group[row.chart === 'final_action' ? 'final' : 'filing'] = cellFromRow(row);
  }
  return [...byMonth.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Merge one bulletin entry into a dataset, keeping it sorted. */
function mergeBulletin(dataset, entry) {
  const i = dataset.findIndex((e) => e.id === entry.id);
  if (i >= 0) dataset[i] = entry;
  else dataset.push(entry);
  dataset.sort((a, b) => a.id.localeCompare(b.id));
}

/* --------------------------------------------------------- official scraper */

// Keyed by key()-normalised header / row text, mirroring the bulletin layout.
const COUNTRY_HEADERS = {
  'all chargeability areas except those listed': 'ROW',
  'all chargeability areas': 'ROW',
  china: 'CN',
  'china mainland born': 'CN',
  'china mainland': 'CN',
  india: 'IN',
  mexico: 'MX',
  philippines: 'PH',
  'el salvador guatemala honduras': 'SV_GT_HN',
  'central america': 'SV_GT_HN',
  vietnam: 'VN',
  'viet nam': 'VN',
};

function employmentCategory(label) {
  const k = key(label);
  if (k === '1st' || k === 'eb 1' || k === 'eb1') return 'EB1';
  if (k === '2nd' || k === 'eb 2' || k === 'eb2') return 'EB2';
  if (k === '3rd' || k === 'professionals' || k === 'skilled workers professionals') return 'EB3';
  if (k === 'other workers') return 'EW';
  if (k === '4th' || k === 'certain special immigrants') return 'EB4';
  if (k === 'certain religious workers') return 'EB4_RW';
  if (/^5th\b/.test(k) || /^(eb ?5)\b/.test(k)) {
    if (/set aside rural|rural/.test(k)) return 'EB5_RURAL';
    if (/high unemployment/.test(k)) return 'EB5_HIGH_UNEMPLOYMENT';
    if (/infrastructure/.test(k)) return 'EB5_INFRASTRUCTURE';
    if (/unreserved/.test(k) && /\bi5\b.*\br5\b/.test(k)) return 'EB5_UNRESERVED_I5_R5';
    if (/unreserved/.test(k)) return 'EB5_UNRESERVED';
    if (/non regional center/.test(k)) return 'EB5_NON_REGIONAL_CENTER';
    if (/targeted employment/.test(k)) return 'EB5_TEA_REGIONAL_PILOT';
    if (/regional center/.test(k)) return 'EB5_REGIONAL_CENTER';
    if (k === '5th') return 'EB5_UNRESERVED';
  }
  return undefined;
}

/** Parse a bulletin cell such as "01NOV13", "C" or "U". */
function parseCell(raw) {
  const t = norm(raw).replace(/[*†‡¹²³]/g, '').replace(/\s+/g, '').toUpperCase();
  if (t === 'C' || t === 'CURRENT') return { status: 'current', date: '' };
  if (t === 'U' || t === 'UNAVAILABLE' || t === 'UNAUTHORIZED') return { status: 'unavailable', date: '' };
  const m = /^(\d{1,2})([A-Z]{3})(\d{2}|\d{4})$/.exec(t);
  if (!m) throw new Error(`Unparseable bulletin cell: ${JSON.stringify(raw)}`);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const mi = months.indexOf(m[2]);
  if (mi < 0) throw new Error(`Bad month in bulletin cell: ${JSON.stringify(raw)}`);
  let y = Number(m[3]);
  if (m[3].length === 2) y = y >= 50 ? 1900 + y : 2000 + y;
  const iso = `${y}-${String(mi + 1).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
    throw new Error(`Invalid date ${iso} from ${JSON.stringify(raw)}`);
  }
  return { status: 'date', date: iso };
}

/** Port of the upstream parser: locate the four bulletin tables by header. */
function parseBulletinHtml(html, bulletinId) {
  const $ = cheerio.load(html);
  const tables = $('table').filter((_, el) => $(el).parents('table').length === 0).toArray();
  if (!tables.length) throw new Error('No tables found in bulletin HTML');

  tables.forEach((el, i) => $(el).replaceWith(`\n@@TABLE${i}@@\n`));
  const fullText = $.root().text().replace(/\u00a0/g, ' ');
  const segments = [];
  let last = 0;
  tables.forEach((_, i) => {
    const at = fullText.indexOf(`@@TABLE${i}@@`);
    segments.push(fullText.slice(last, at));
    last = at + `@@TABLE${i}@@`.length;
  });

  const rows = [];
  tables.forEach((el, i) => {
    const trs = $(el).find('tr').toArray();
    if (!trs.length) return;
    const grid = trs.map((tr) =>
      $(tr).children('td,th').toArray().map((c) => norm($(c).text()))
    );
    const first = key(grid[0][0] ?? '');
    if (!/^employment/.test(first)) return; // only employment tables matter here

    const seg = norm(segments[i]).toUpperCase();
    let chart;
    for (const m of seg.matchAll(/FINAL\s+ACTION|DATES?\s+FOR\s+FILING/g)) {
      chart = /FINAL/.test(m[0]) ? 'final_action' : 'dates_for_filing';
    }
    if (!chart) throw new Error(`Cannot determine chart for employment table #${i}`);

    const countries = grid[0].slice(1).map((h) => {
      const c = COUNTRY_HEADERS[key(h)];
      if (!c) throw new Error(`Unknown country header ${JSON.stringify(h)}`);
      return c;
    });

    for (const r of grid.slice(1)) {
      if (r.length < 2) continue;
      const category = employmentCategory(r[0]);
      if (!category) throw new Error(`Unknown employment row label ${JSON.stringify(r[0])}`);
      if (r.length - 1 !== countries.length) {
        throw new Error(`Row ${r[0]} has ${r.length - 1} cells, header has ${countries.length}`);
      }
      countries.forEach((country, ci) => {
        if (category !== 'EB2' && category !== 'EB3') return;
        const { status, date } = parseCell(r[ci + 1]);
        rows.push({ bulletin: bulletinId, chart, category, country, status, date });
      });
    }
  });
  if (!rows.length) throw new Error('No EB-2/EB-3 rows found in bulletin HTML');
  return rows;
}

function officialUrl(bulletinId) {
  const { year, month } = parseBulletinId(bulletinId);
  const folder = month >= 10 ? year + 1 : year; // FY folders start in October
  const monthName = MONTHS[month - 1].toLowerCase();
  return `https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin/${folder}/visa-bulletin-for-${monthName}-${year}.html`;
}

async function scrapeOfficial(bulletinId) {
  const url = officialUrl(bulletinId);
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36', // sdg:ignore public-ip (browser version in UA, not an address)
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`Official bulletin returned HTTP ${res.status}`);
  const html = await res.text();
  if (/Attention Required|Cloudflare|cf-error/i.test(html.slice(0, 4000))) {
    throw new Error('Official bulletin blocked by Cloudflare');
  }
  const rows = parseBulletinHtml(html, bulletinId);
  const entry = buildDataset(rows).find((e) => e.id === bulletinId);
  if (!entry) throw new Error(`Official bulletin for ${bulletinId} produced no entry`);
  return { entry, url };
}

/* --------------------------------------------------------------- public API */

async function fetchUpstream() {
  const res = await fetch(UPSTREAM_CSV, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'immigration-tracker/1.0 (+local dashboard)', Accept: 'text/plain' },
  });
  if (!res.ok) throw new Error(`Upstream dataset returned HTTP ${res.status}`);
  return res.text();
}

let inFlight = null;

/** Refresh the store. Concurrent callers share the same promise. */
function refresh() {
  if (inFlight) return inFlight;
  inFlight = doRefresh().finally(() => { inFlight = null; });
  return inFlight;
}

async function doRefresh() {
  const startedAt = new Date().toISOString();
  const previous = store.read();
  const result = {
    ok: false,
    fetchedAt: startedAt,
    source: SOURCE_NAME,
    sourceUrl: UPSTREAM_CSV,
    added: 0,
    updated: 0,
    official: { enabled: OFFICIAL_ENABLED, attempted: [], errors: [], used: null },
  };

  // 1. Primary, reliable source ------------------------------------------------
  const csv = await fetchUpstream();
  const rows = parseUpstreamCsv(csv);
  const dataset = buildDataset(rows);

  // 2. Best-effort direct official scrape for the newest bulletin(s) ----------
  if (OFFICIAL_ENABLED) {
    const lastId = dataset[dataset.length - 1].id;
    const { year, month } = parseBulletinId(lastId);
    const nextDate = new Date(Date.UTC(year, month, 1)); // month is 1-based -> next month
    const nextId = `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const candidates = [...new Set([nextId, lastId])];
    for (const id of candidates) result.official.attempted.push(id);

    const attempts = await Promise.allSettled(candidates.map((id) => scrapeOfficial(id)));
    // Prefer the newest candidate that succeeded.
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      if (a.status === 'fulfilled') {
        mergeBulletin(dataset, a.value.entry);
        result.official.used = { id: candidates[i], url: a.value.url };
        break;
      }
      result.official.errors.push({ id: candidates[i], message: String(a.reason?.message || a.reason) });
    }
  }

  const prevIds = new Set(previous.bulletins.map((b) => b.id));
  for (const b of dataset) {
    if (!prevIds.has(b.id)) result.added++;
    else if (JSON.stringify(b) !== JSON.stringify(previous.bulletins.find((x) => x.id === b.id))) {
      result.updated++;
    }
  }

  store.save(dataset, {
    fetchedAt: result.fetchedAt,
    source: result.source,
    sourceUrl: result.sourceUrl,
    official: result.official,
    countries: countriesIn(rows),
  });

  result.ok = true;
  result.total = dataset.length;
  result.lastBulletin = dataset[dataset.length - 1].id;
  return result;
}

/** Compute the next scheduled refresh time (informational). */
function nextRefreshAt() {
  const hours = Number(process.env.REFRESH_INTERVAL_HOURS || 6);
  const last = new Date(store.read().meta.fetchedAt || 0).getTime();
  return new Date(last + hours * 3600 * 1000).toISOString();
}

module.exports = {
  refresh,
  nextRefreshAt,
  officialUrl,
  parseBulletinHtml,
  parseUpstreamCsv,
  buildDataset,
  countriesIn,
  COUNTRY_NAMES,
  SOURCE_NAME,
  UPSTREAM_CSV,
};

// Allow: node -e "require('./lib/scraper').refresh()..."
if (require.main === module) {
  refresh()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e); process.exit(1); });
}
