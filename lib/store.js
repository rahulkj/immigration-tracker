'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'bulletins.json');

let cache = null;

function read() {
  if (!cache) {
    if (!fs.existsSync(DATA_FILE)) {
      cache = { meta: {}, bulletins: [] };
    } else {
      cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  }
  return cache;
}

/** Atomically persist a new dataset and update its metadata. */
function save(bulletins, metaPatch = {}) {
  const previous = read();
  const data = {
    meta: {
      ...previous.meta,
      ...metaPatch,
      generatedAt: new Date().toISOString(),
    },
    bulletins,
  };
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, DATA_FILE);
  cache = data;
  return data;
}

module.exports = { read, save, DATA_FILE };
