# Immigration Tracker

A small, self-hosted website that tracks **EB-2** and **EB-3** employment-based
visa bulletin priority dates — both **Dates for Filing** and **Final Action
Dates** — for every bulletin from **January 2020 to the present**, across **all
chargeability areas** (India, China, Mexico, Philippines, Rest of World,
El Salvador/Guatemala/Honduras, and Vietnam). A country picker switches the
whole dashboard between them.

There are **two cumulative charts**, one for **EB-2** and one for **EB-3**. Each
plots the 2020→present history on a single continuous timeline (every bulletin
month on the horizontal axis, the cutoff date on the vertical axis) with two
lines: **Dates for Filing** and **Final Action**. The chosen country drives the
summary cards, both charts, the history table, and the CSV export.

Because that timeline grows every month, the chart header has **range
controls**: quick `1Y / 3Y / 5Y / All` buttons and a custom `from → to` year
picker. Only the selected window is plotted (point markers thin out
automatically for very long ranges), while the full history always remains
available in the month-by-month table — which has its own year filter — and in
the CSV download. There are also latest-value summary cards, and the data
refreshes automatically, so new bulletins appear without any manual editing.

The **Naturalization** tab has two parts. An **eligibility calculator** estimates
the earliest date you can file Form N-400 from your green-card date, the
5-year or 3-year (marriage-based) rule, and optional trip information. Below it,
USCIS **case inquiry dates** (the receipt dates currently being processed) and
processing-time ranges are shown for ~90 field offices, with an office picker,
a searchable office table, a date-history chart, and CSV export. Switch between
the two sections with the tabs at the top of the page. The N-400 data comes from
daily snapshots of the USCIS processing-times tool and refreshes alongside the
bulletin data.

**Light and dark themes** are both supported. The moon/sun button in the header
toggles them; your choice is saved in local storage, and until you choose one the
site follows your operating system's `prefers-color-scheme` setting. Charts
recolor themselves to match the active theme.

## Quick start

Requires **Node.js 22.5+** (the N-400 reader uses the built-in `node:sqlite`
module).

```bash
npm install
npm run seed       # build the bundled 2020→now visa bulletin dataset
npm run seed:n400  # build the bundled N-400 processing-date snapshots (optional)
npm start
```

Open **http://localhost:3000**.

Both seed commands are only needed for a fresh checkout (or to rebuild the
bundled snapshots). The server serves the committed `data/bulletins.json` and
`data/n400.json`, so the site works immediately, even without network access.

## How the data stays current

On startup, on a timer, and whenever you press **Refresh data**, the server runs
`lib/scraper.js`:

1. **Primary source (always).** It downloads
   [`visa_bulletin.csv`](https://raw.githubusercontent.com/armanckeser/visa-bulletin-data/main/data/visa_bulletin.csv)
   from the openly licensed (CC0) `armanckeser/visa-bulletin-data` mirror. That
   repository is updated daily from the official Department of State bulletins,
   including months retrieved through the Wayback Machine when
   travel.state.gov blocks automated clients. The parser keeps EB-2/EB-3 rows
   for every published chargeability area from 2020 onward.
2. **Official source (best effort).** It also attempts a direct scrape of the
   official [travel.state.gov bulletin](https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html)
   for the newest month(s). This uses the real bulletin HTML tables (the parser
   is a port of the upstream project's parser) and can surface a brand-new
   bulletin before the mirror updates. If the official site returns a
   Cloudflare challenge or the layout changes, the error is logged and ignored —
   the mirror data is still used.

3. **Naturalization.** `lib/n400.js` downloads the latest daily SQLite release
   from [jzebedee/uscis](https://github.com/jzebedee/uscis) (which mirrors the
   USCIS processing-times tool), reads the N-400 rows with Node's built-in
   `node:sqlite`, and keeps ~14 monthly snapshots so the case inquiry date can
   be charted over time. `npm run seed:n400` builds the full history; later
   refreshes only fetch the newest release.

Refresh cadence is controlled by environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `REFRESH_INTERVAL_HOURS` | `6` | How often stale data is auto-refreshed |
| `OFFICIAL_SCRAPE` | `true` | Set to `false` to skip direct travel.state.gov attempts |
| `FETCH_TIMEOUT_MS` | `12000` | Per-request timeout |

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/data` | Full dataset (`meta.countries` + monthly `bulletins`, each with a `countries` map) |
| `GET /api/countries` | Available chargeability areas (`code` + `name`) |
| `GET /api/n400` | N-400 offices and monthly processing-date snapshots |
| `GET /api/latest?country=IN` | Latest bulletin and the previous one for a country |
| `GET /api/status` | Last refresh time, next refresh, source, record count |
| `POST /api/refresh` | Trigger a refresh now (shared with the UI button) |
| `GET /healthz` | Health check |

Each bulletin in `/api/data` looks like:

```json
{
  "id": "2026-11",
  "label": "Nov 2026",
  "countries": {
    "IN": {
      "eb2": {
        "filing": { "status": "date", "date": "2015-01-15", "ts": 1421280000000, "label": "Jan 15, 2015" },
        "final":  { "status": "date", "date": "2013-11-01", "ts": 1383264000000, "label": "Nov 1, 2013" }
      },
      "eb3": { "...": "..." }
    },
    "CN": { "...": "..." }
  }
}
```

`status` is `date`, `current` (`C` in the bulletin) or `unavailable` (`U`).
Only `date` cells have a numeric `ts`; the charts leave gaps for the others.

## Project layout

```
server.js               Express server, API, and background refresh scheduler
lib/scraper.js          Upstream CSV fetch + official bulletin HTML scraper/parser
lib/store.js            Atomic JSON data store
lib/n400.js             N-400 release download, SQLite parse, snapshot store
scripts/build-seed.js   Rebuild the bundled bulletin dataset
scripts/build-n400.js   Rebuild the bundled N-400 snapshot history
scripts/refresh.js      One-shot refresh from the CLI
data/bulletins.json     Bundled dataset for all countries (committed)
data/n400.json          Bundled N-400 snapshots (committed)
public/                 Frontend (HTML/CSS/vanilla JS + vendored Chart.js)
Dockerfile              Node 22 image serving the Express app on port 3000
.github/workflows/      Multi-arch build/push to Harbor + deployment-manifests update
ci/                     Local replicas of the CI steps and deployment manifest
.envrc                  Local Harbor/GitHub credentials from the system keyring
```

## Build, CI, and deployment

The Docker/CI setup mirrors the `recipes` project, adapted for a Node.js server:

- `Dockerfile` builds a `node:22-alpine` image (required for `node:sqlite`),
  installs production dependencies, copies the committed data snapshots, exposes
  port 3000, and health-checks `/healthz`.
- `.github/workflows/docker-image.yml` runs on every push: builds a multi-arch
  (`amd64` + `arm64`) image with Buildx, pushes `:latest` and `:<sha>` to Harbor,
  verifies the manifest, regenerates the VM deployment manifest in the shared
  `deployment-manifests` repo, commits it, then cleans up workflow artifacts.
  Harbor login uses a hand-built auth config because `docker login`'s preflight
  ping is blocked; provenance attestations are disabled for Harbor.
- `ci/deployment.yml` is the envsubst template (Deployment, Service, Traefik
  IngressRoute) using `${VERSION}`, `${IMAGE_NAME}`, `${SITE_NAME}`,
  `${PLATFORM}`, `${DOMAIN_NAME}`, and the Harbor variables. Probes hit
  `/healthz`.
- Local equivalents: `ci/local-build.sh <sha>` (build + push + manifest + commit),
  `ci/local-manifest.sh <dir> <sha>` (manifest only), and
  `ci/build-deploy.sh [build_and_push|deploy|undeploy] [vm|pi]`. They source
  `.envrc` for credentials.
- `.envrc` pulls Harbor and GitHub credentials from the system keyring. It is
  git-ignored. Run `ci/setup-gh-secrets.sh` once to mirror those values into the
  repository's Actions variables/secrets (`HARBOR_*`, `IMAGE_NAME`, `SITE_NAME`,
  `DOMAIN_NAME`, `VM_PLATFORM`, `PI_PLATFORM`, `DEPLOY_PAT`).

## Notes

- Bulletin data is a U.S. government work (public domain). The mirror dataset is
  CC0; Chart.js is MIT (vendored in `public/vendor/`).
- This is an informational tracker, **not legal advice**, and is not affiliated
  with the U.S. Department of State or USCIS. Verify anything you rely on
  against the [official visa bulletin](https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html).
