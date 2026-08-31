# CS-Outdated-Content-Alerts

Detect outdated documentation using product signals is a Launch-ready one-page app for identifying documentation drift, generating scoped review reports, assigning flagged docs to technical writers, and tracking review progress in one place.

## What it does

A weekly, autonomous docs-QA agent:

- **refreshes its own inputs** — live-scans the corpus for broken internal links (verified over HTTP)
- **scans** the live Contentstack docs corpus (`llms-full.txt`, ~1,570 pages) for staleness signals
- **reasons** — Claude reviews the top flagged pages and returns a verdict + suggested fix, filtering false positives
- **drafts fixes** (propose-only) — concrete link corrections + AI suggestions a writer applies by hand
- **delivers** — posts a weekly digest to Slack; assigns each doc to a mapped owner
- scores each row with confidence and priority; tracks review progress in the dashboard

## How detection works

`scripts/detect-staleness.mjs` fetches the corpus, scans every docs page, and writes
`functions/generated-inventory.js` (the data the `/report` function serves). It emits only
signals the available data can actually support — no fabricated signals:

| Signal | What it detects | Source |
| --- | --- | --- |
| `content_age` | Page not updated in a long time; threshold weighted by `doc_type` (API/SDK/reference decay faster) | `last_updated` in the corpus |
| `deprecated_reference` / `version_reference` | Body still documents deprecated/removed features, or aging "coming soon / beta" language | page body scan |
| `broken_link` / `orphan` | Page contains links that actually 404 (verified over HTTP), or is orphaned/stale in navigation | `data/known-issues.json`, refreshed live by `scripts/scan-links.mjs` (orphans carried from the curated snapshot) |

Confidence and priority are derived in `functions/report.js` — e.g. a broken link on an
otherwise-stale page is `Critical`; a single medium signal is `Normal`.

### AI review layer

After the rule-based pass, Claude reviews the top flagged pages (priority-ordered): it reads
the page + detected signals and returns a `verdict` (`outdated` / `needs-review` /
`likely-current`), `confidence`, a short `summary`, and a `suggested_fix`. This catches
false positives the rules can't — e.g. a changelog that mentions "deprecated" as normal
history, or a stale broken-link snapshot whose target now resolves.

Reviews are cached in `data/ai-analysis.json` (keyed by page id + a content fingerprint) and
reused across runs, so they render with no API cost. Set `ANTHROPIC_API_KEY` to have the
weekly run review *newly* flagged pages live (`AI_MODEL` and `AI_LIMIT` are optional
overrides). Without a key, the pipeline still runs and serves the cached reviews. Each row in
the UI has an expandable **Details** view showing the AI review and suggested fix.

## Weekly pipeline

The agent runs this pipeline once a week:

1. `scripts/scan-links.mjs` → refresh `data/known-issues.json` (live broken-link scan, HTTP-verified).
2. `scripts/detect-staleness.mjs` → `functions/generated-inventory.js` (rule-based flags).
3. **AI review** → Claude reviews the top newly-flagged pages into `data/ai-analysis.json`.
4. `scripts/build-fixes-report.mjs` → `reports/fixes-proposal.md` (propose-only; no CMS writes).
5. `scripts/build-digest.mjs` → `reports/weekly-digest.md` + `.slack.json`.
6. Post the digest to Slack; commit generated data + push → Launch redeploys the dashboard.

**Runner — cloud Claude routine (preferred):** the routine *is* Claude with tools, so step 3
needs no API key — it reasons natively over new pages. Requires the Claude GitHub app installed
on the repo (clone + push) and a Slack connector attached. Drafted content follows
`data/style-guide.md`.

**Runner — local launchd (fallback):** `~/docs-staleness-agent/weekly-refresh.sh` runs the same
pipeline on a Mac each Monday; set `ANTHROPIC_API_KEY` for live AI review (the script's API path).

## Local development

```bash
node scripts/scan-links.mjs          # refresh broken-link data (HTTP-verified)
node scripts/detect-staleness.mjs    # regenerate the inventory from the live corpus
node scripts/build-fixes-report.mjs  # propose-only fix report -> reports/fixes-proposal.md
node scripts/build-digest.mjs        # weekly digest -> reports/weekly-digest.*
node scripts/dev-server.mjs          # serve the app + functions at http://localhost:4310
```

## Current data model

Each flagged item returned by `/report` includes:

- `doc_title`
- `doc_url`
- `doc_type`
- `doc_section`
- `product_area`
- `owners`
- `last_updated`
- `reason_flagged`
- `signals_detected`
- `confidence`
- `priority`
- `optional_changelog_reference`

## Launch deployment shape

This repo is structured to work well with Contentstack Launch:

- `index.html` / `app.js` / `styles.css`: one-page dashboard (rendering, status tracking, expandable AI reviews)
- `functions/report.js`: Launch Cloud Function that scores docs and serves the generated inventory
- `scripts/*.mjs`: the weekly pipeline (see **Weekly pipeline**)
- `data/`: `known-issues.json` (link-health), `ai-analysis.json` (AI review cache), `style-guide.md` (drafting rules)

Status tracking is stored in browser `localStorage`, which keeps the app lightweight and deployable without a database. (`functions/send-email.js` remains for optional owner emails but is not wired into the UI.)

## Notes

- **Propose-only.** The agent never writes to the CMS. Fix proposals in `reports/fixes-proposal.md` are applied by a writer after review.
- `scripts/scan-links.mjs` verifies each candidate link over HTTP, so it reports only links that actually 404 (no false positives from corpus gaps). Orphan detection needs the nav tree the corpus lacks, so orphan data is carried from the curated snapshot pending a nav-based scan.
- Future signals (UI-label drift, API-schema diff) are intentionally not implemented — they need a product UI feed / OpenAPI diff that isn't wired up.
