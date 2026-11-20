'use strict';

/** Build/refresh the bundled N-400 processing-date dataset. */

const n400 = require('../lib/n400');

n400
  .buildSeed()
  .then((data) => {
    console.log(
      `Wrote ${data.snapshots.length} N-400 snapshots ` +
      `(${data.snapshots[0].tag} -> ${data.snapshots[data.snapshots.length - 1].tag}), ` +
      `${data.offices.length} offices.`
    );
    console.log(`Data file: ${n400.DATA_FILE}`);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
