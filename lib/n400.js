'use strict';

/**
 * Naturalization (Form N-400) processing-date data.
 *
 * Source: jzebedee/uscis publishes a daily SQLite snapshot of USCIS processing
 * times as a GitHub release. For N-400 each office has a "service request date"
 * (the case-inquiry / receipt date USCIS is currently working on) plus a
 * lower/upper processing-time range. We bundle ~14 monthly snapshots so the
 * inquiry date can be charted over time, and refresh the newest one on every
 * data refresh.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const RELEASES_API = 'https://api.github.com/repos/jzebedee/uscis/releases?per_page=100';
const RELEASE_PAGE = (n) => `${RELEASES_API}&page=${n}`;
const SOURCE_NAME = 'jzebedee/uscis (daily USCIS processing-time snapshots)';
const SOURCE_URL = 'https://github.com/jzebedee/uscis';
const DATA_FILE = path.join(__dirname, '..', 'data', 'n400.json');
const HISTORY_MONTHS = 14;
const TIMEOUT_MS = Number(process.env.N400_TIMEOUT_MS || 20000);

const MONTH_NUM = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseUsDate(raw) {
  if (!raw) return null;
  const m = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(String(raw).trim());
  if (!m) return null;
  const mi = MONTH_NUM[m[1].slice(0, 3).toUpperCase()];
  if (!mi) return null;
  return `${m[3]}-${String(mi).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

function formatDate(iso) {
  if (!iso) return 'Unavailable';
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTH_LABELS[m - 1]} ${d}, ${y}`;
}

function cell(iso) {
  return { date: iso || null, label: formatDate(iso), ts: iso ? Date.parse(`${iso}T00:00:00Z`) : null };
}

async function getJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'immigration-tracker/1.0', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`);
  return res.json();
}

/** Collect releases, newest first, until we have enough distinct months. */
async function fetchReleases(pages = 8) {
  const releases = [];
  for (let page = 1; page <= pages; page++) {
    const batch = await getJson(RELEASE_PAGE(page));
    releases.push(...batch);
    if (batch.length < 100) break;
    const months = new Set(releases.map((r) => r.tag_name.slice(0, 7)));
    if (months.size >= HISTORY_MONTHS + 1) break;
  }
  if (!releases.length) throw new Error('No USCIS processing-time releases found');
  return releases;
}

/** One (newest) release per calendar month, oldest first. */
function pickMonthly(releases) {
  const byMonth = new Map();
  for (const rel of releases) {
    const month = rel.tag_name.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, rel);
  }
  return [...byMonth.values()]
    .sort((a, b) => a.tag_name.localeCompare(b.tag_name))
    .slice(-HISTORY_MONTHS);
}

async function downloadDb(release) {
  const asset = release.assets?.find((a) => a.name.endsWith('.db'));
  if (!asset) throw new Error(`Release ${release.tag_name} has no .db asset`);
  const res = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Database download returned HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const file = path.join(os.tmpdir(), `immigration-tracker-n400-${release.tag_name}-${process.pid}.db`);
  fs.writeFileSync(file, buf);
  return file;
}

/** Extract the N-400 rows and office names from one release DB. */
function readSnapshot(file, release) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const offices = db.prepare('SELECT code, description FROM offices').all();
    const rows = db.prepare(
      "SELECT office_code, publication_date, service_request_date, range_lower, range_upper, range_lower_unit " +
      "FROM processing_time WHERE form_name = 'N-400'"
    ).all();

    const values = {};
    let publicationDate = null;
    for (const r of rows) {
      const inquiryDate = parseUsDate(r.service_request_date);
      values[r.office_code] = {
        inquiry: cell(inquiryDate),
        lower: r.range_lower,
        upper: r.range_upper,
        unit: r.range_lower_unit || 'Months',
      };
      if (r.publication_date && !publicationDate) publicationDate = parseUsDate(r.publication_date);
    }
    if (!Object.keys(values).length) throw new Error(`No N-400 rows in release ${release.tag_name}`);

    return {
      snapshot: {
        tag: release.tag_name,
        releasedAt: release.published_at,
        publicationDate,
        values,
      },
      offices: offices.map((o) => ({ code: o.code, name: o.description }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  } finally {
    db.close();
  }
}

async function downloadSnapshot(release) {
  const file = await downloadDb(release);
  try { return readSnapshot(file, release); }
  finally { fs.unlinkSync(file); }
}

function read() {
  if (!fs.existsSync(DATA_FILE)) return { meta: {}, offices: [], snapshots: [] };
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function save(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, DATA_FILE);
  return data;
}

/** Full seed: ~14 monthly snapshots plus the current one. */
async function buildSeed() {
  const releases = await fetchReleases();
  const picked = pickMonthly(releases);
  const snapshots = [];
  let offices = [];
  for (const rel of picked) {
    const { snapshot, offices: list } = await downloadSnapshot(rel);
    snapshots.push(snapshot);
    offices = list; // newest release wins
    console.log(`  snapshot ${rel.tag_name}: ${Object.keys(snapshot.values).length} offices`);
  }
  const newest = snapshots[snapshots.length - 1];
  return save({
    meta: {
      source: SOURCE_NAME,
      sourceUrl: SOURCE_URL,
      fetchedAt: new Date().toISOString(),
      releaseTag: newest.tag,
      publicationDate: newest.publicationDate,
    },
    offices,
    snapshots,
  });
}

let inFlight = null;

/** Refresh: download only the newest release and append/replace its snapshot. */
function refresh() {
  if (inFlight) return inFlight;
  inFlight = doRefresh().finally(() => { inFlight = null; });
  return inFlight;
}

async function doRefresh() {
  const existing = read();
  const releases = await fetchReleases(1);
  const { snapshot, offices } = await downloadSnapshot(releases[0]);
  const snapshots = existing.snapshots?.length ? [...existing.snapshots] : [];
  const last = snapshots[snapshots.length - 1];
  let action = 'unchanged';

  if (!last || snapshot.tag !== last.tag) {
    if (last && snapshot.publicationDate === last.publicationDate) {
      snapshots[snapshots.length - 1] = snapshot; // same USCIS period, newer scrape
      action = 'updated-latest';
    } else {
      snapshots.push(snapshot);
      action = 'added-month';
    }
    while (snapshots.length > HISTORY_MONTHS) snapshots.shift();
  }

  const data = save({
    meta: {
      source: SOURCE_NAME,
      sourceUrl: SOURCE_URL,
      fetchedAt: new Date().toISOString(),
      releaseTag: snapshot.tag,
      publicationDate: snapshot.publicationDate,
    },
    offices: offices.length ? offices : existing.offices,
    snapshots,
  });

  return {
    ok: true,
    action,
    releaseTag: snapshot.tag,
    publicationDate: snapshot.publicationDate,
    offices: data.offices.length,
    snapshots: snapshots.length,
  };
}

module.exports = {
  buildSeed,
  refresh,
  read,
  DATA_FILE,
  parseUsDate,
  pickMonthly,
  SOURCE_NAME,
  SOURCE_URL,
};

if (require.main === module) {
  refresh()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e); process.exit(1); });
}
