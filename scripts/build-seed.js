'use strict';

/**
 * Build (or rebuild) the bundled historical seed dataset.
 *
 * Usage:
 *   npm run seed                       # downloads the latest upstream CSV
 *   node scripts/build-seed.js my.csv  # uses a local CSV copy
 */

const fs = require('fs');
const path = require('path');
const scraper = require('../lib/scraper');
const store = require('../lib/store');

async function main() {
  const local = process.argv[2];
  let csv;
  if (local) {
    csv = fs.readFileSync(path.resolve(local), 'utf8');
    console.log(`Reading local CSV: ${local}`);
  } else {
    console.log('Downloading upstream dataset...');
    csv = await fetch(scraper.UPSTREAM_CSV, { signal: AbortSignal.timeout(30000) }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });
  }

  const rows = scraper.parseUpstreamCsv(csv);
  const dataset = scraper.buildDataset(rows);
  const countries = scraper.countriesIn(rows);
  store.save(dataset, {
    fetchedAt: new Date().toISOString(),
    source: scraper.SOURCE_NAME,
    sourceUrl: scraper.UPSTREAM_CSV,
    official: { enabled: false, attempted: [], errors: [], used: null },
    countries,
  });

  console.log(`Wrote ${dataset.length} monthly bulletins (${dataset[0].id} -> ${dataset[dataset.length - 1].id})`);
  console.log(`Countries: ${countries.map((c) => c.code).join(', ')}`);
  console.log(`Data file: ${store.DATA_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
