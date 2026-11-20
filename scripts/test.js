'use strict';

/** Lightweight offline checks for the parser and the bundled dataset. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const scraper = require('../lib/scraper');
const n400 = require('../lib/n400');

const HTML_FIXTURE = `
<p>A. STATUTORY NUMBERS — Final Action Dates chart follows.</p>
<table>
  <tr><th>Employment-based</th><th>All Chargeability Areas Except Those Listed</th><th>China-mainland born</th><th>India</th><th>Mexico</th></tr>
  <tr><td>1st</td><td>C</td><td>01JAN20</td><td>01FEB20</td><td>C</td></tr>
  <tr><td>2nd</td><td>C</td><td>01JAN18</td><td>01NOV13</td><td>01MAR19</td></tr>
  <tr><td>3rd</td><td>C</td><td>01JAN18</td><td>22JAN14</td><td>01APR19</td></tr>
  <tr><td>Other Workers</td><td>C</td><td>01JAN18</td><td>22JAN14</td><td>01APR19</td></tr>
</table>
<p>B. The Dates for Filing chart follows.</p>
<table>
  <tr><th>Employment-based</th><th>All Chargeability Areas Except Those Listed</th><th>China-mainland born</th><th>India</th><th>Mexico</th></tr>
  <tr><td>1st</td><td>C</td><td>01JAN20</td><td>01FEB20</td><td>C</td></tr>
  <tr><td>2nd</td><td>C</td><td>01JAN20</td><td>15JAN15</td><td>01JAN20</td></tr>
  <tr><td>3rd</td><td>C</td><td>01JAN20</td><td>15JAN15</td><td>01JAN20</td></tr>
  <tr><td>Other Workers</td><td>C</td><td>01JAN20</td><td>15JAN15</td><td>01JAN20</td></tr>
</table>
`;

function testParser() {
  const rows = scraper.parseBulletinHtml(HTML_FIXTURE, '2020-01');
  // 4 countries x 2 categories x 2 charts
  assert.strictEqual(rows.length, 16, 'expected 16 EB-2/EB-3 rows across countries');
  const get = (chart, category, country) =>
    rows.find((r) => r.chart === chart && r.category === category && r.country === country);
  assert.strictEqual(get('final_action', 'EB2', 'IN').date, '2013-11-01');
  assert.strictEqual(get('final_action', 'EB3', 'IN').date, '2014-01-22');
  assert.strictEqual(get('dates_for_filing', 'EB2', 'IN').date, '2015-01-15');
  assert.strictEqual(get('final_action', 'EB2', 'CN').date, '2018-01-01');
  assert.strictEqual(get('final_action', 'EB3', 'MX').date, '2019-04-01');
  assert.strictEqual(get('dates_for_filing', 'EB2', 'ROW').status, 'current');
  console.log('✓ bulletin HTML parser (all countries)');
}

function testDataset() {
  const file = path.join(__dirname, '..', 'data', 'bulletins.json');
  assert.ok(fs.existsSync(file), 'data/bulletins.json missing — run npm run seed');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(data.bulletins.length >= 80, 'expected at least 80 monthly bulletins');
  assert.strictEqual(data.bulletins[0].id, '2020-01');
  assert.ok(data.meta.countries.length >= 5, 'expected multiple countries in meta');

  const last = data.bulletins[data.bulletins.length - 1];
  assert.ok(last.countries.IN, 'missing India data');
  assert.ok(last.countries.CN, 'missing China data');
  assert.strictEqual(last.countries.IN.eb2.final.date, '2013-11-01');
  assert.strictEqual(last.countries.IN.eb3.final.date, '2014-01-22');
  assert.strictEqual(last.countries.IN.eb2.filing.date, '2015-01-15');
  assert.strictEqual(last.countries.CN.eb2.final.date, '2021-10-01');

  for (const b of data.bulletins) {
    for (const [code, country] of Object.entries(b.countries)) {
      for (const cat of ['eb2', 'eb3']) {
        for (const field of ['filing', 'final']) {
          const c = country[cat][field];
          assert.ok(['date', 'current', 'unavailable'].includes(c.status), `${b.id} ${code} ${cat} ${field} status`);
          if (c.status === 'date') assert.ok(Number.isFinite(c.ts), `${b.id} ${code} ${cat} ${field} ts`);
        }
      }
    }
  }
  console.log(`✓ bundled dataset (${data.bulletins.length} bulletins, ${data.meta.countries.length} countries, through ${last.id})`);
}

function testN400() {
  assert.strictEqual(n400.parseUsDate('June 18, 2025'), '2025-06-18');
  assert.strictEqual(n400.parseUsDate('December 1, 2024'), '2024-12-01');
  const file = n400.DATA_FILE;
  assert.ok(fs.existsSync(file), 'data/n400.json missing — run npm run seed:n400');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(d.snapshots.length >= 10, 'expected at least 10 N-400 snapshots');
  assert.ok(d.offices.length >= 80, 'expected at least 80 field offices');
  for (const snap of d.snapshots) {
    assert.match(snap.tag, /^\d{4}-\d{2}-\d{2}$/, 'snapshot tag');
    for (const v of Object.values(snap.values)) {
      assert.ok(v.inquiry && 'date' in v.inquiry && 'label' in v.inquiry, 'inquiry cell');
      assert.ok(v.upper >= v.lower, 'processing range');
    }
  }
  const last = d.snapshots[d.snapshots.length - 1];
  assert.ok(last.values.NYC?.inquiry.date, 'missing NYC inquiry date');
  console.log(`✓ N-400 dataset (${d.snapshots.length} snapshots, ${d.offices.length} offices)`);
}

testParser();
testDataset();
testN400();
console.log('All checks passed.');
