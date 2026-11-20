'use strict';

const express = require('express');
const path = require('path');
const scraper = require('./lib/scraper');
const n400 = require('./lib/n400');
const store = require('./lib/store');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const REFRESH_MS = Number(process.env.REFRESH_INTERVAL_HOURS || 6) * 3600 * 1000;
const CHECK_MS = 10 * 60 * 1000; // check staleness every 10 minutes

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function meta() {
  const data = store.read();
  const nat = n400.read();
  return {
    ...data.meta,
    isRefreshing: false,
    nextRefreshAt: scraper.nextRefreshAt(),
    count: data.bulletins.length,
    firstBulletin: data.bulletins[0]?.id,
    lastBulletin: data.bulletins[data.bulletins.length - 1]?.id,
    n400: {
      fetchedAt: nat.meta.fetchedAt,
      releaseTag: nat.meta.releaseTag,
      publicationDate: nat.meta.publicationDate,
      offices: nat.offices?.length || 0,
      snapshots: nat.snapshots?.length || 0,
    },
  };
}

/* ------------------------------------------------------------------ APIs */

app.get('/api/data', (_req, res) => {
  try {
    res.json(store.read());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/countries', (_req, res) => {
  try {
    res.json(store.read().meta.countries || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/latest', (req, res) => {
  try {
    const data = store.read();
    const country = req.query.country || data.meta.countries?.[0]?.code;
    const b = data.bulletins.map((entry) => ({
      id: entry.id,
      label: entry.label,
      eb2: entry.countries[country]?.eb2,
      eb3: entry.countries[country]?.eb3,
    }));
    res.json({ country, latest: b[b.length - 1], previous: b[b.length - 2] || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/n400', (_req, res) => {
  try {
    res.json(n400.read());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/status', (_req, res) => {
  try {
    res.json(meta());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/refresh', async (_req, res) => {
  try {
    const result = await scraper.refresh();
    try {
      result.n400 = await n400.refresh();
    } catch (e) {
      result.n400 = { ok: false, error: e.message };
      console.error('[refresh] N-400 refresh failed:', e.message);
    }
    res.json({ ...result, status: meta() });
  } catch (e) {
    console.error('[refresh] failed:', e.message);
    res.status(502).json({ error: `Refresh failed: ${e.message}` });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* -------------------------------------------------------------- scheduling */

function isStale(fetchedAt) {
  const t = Date.parse(fetchedAt || 0);
  return !Number.isFinite(t) || Date.now() - t > REFRESH_MS;
}

async function refreshIfStale(reason) {
  const bulletinsStale = isStale(store.read().meta.fetchedAt);
  const n400Stale = isStale(n400.read().meta.fetchedAt);
  if (!bulletinsStale && !n400Stale) return;
  console.log(`[scheduler] refreshing (${reason})...`);

  const jobs = [];
  if (bulletinsStale) {
    jobs.push(scraper.refresh()
      .then((r) => console.log(
        `[scheduler] bulletins: ${r.total} months, latest ${r.lastBulletin}` +
        (r.official?.used ? `, official ${r.official.used.id}` : '')
      ))
      .catch((e) => console.error(`[scheduler] bulletin refresh failed: ${e.message}`)));
  }
  if (n400Stale) {
    jobs.push(n400.refresh()
      .then((r) => console.log(`[scheduler] N-400: ${r.action}, release ${r.releaseTag}`))
      .catch((e) => console.error(`[scheduler] N-400 refresh failed: ${e.message}`)));
  }
  await Promise.allSettled(jobs);
}

// Serve immediately using the bundled seed; refresh in the background if stale.
app.listen(PORT, () => {
  console.log(`Immigration Tracker running at http://localhost:${PORT}`);
  refreshIfStale('startup');
});

setInterval(() => refreshIfStale('interval'), CHECK_MS);
