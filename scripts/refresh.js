'use strict';

/** One-shot manual refresh from the command line. */

const scraper = require('../lib/scraper');

scraper
  .refresh()
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
