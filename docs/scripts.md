# Scripts

## Overview

Operational and CI helper scripts live in `scripts/`. They support build integrity, smoke checks, data sync, and targeted maintenance tasks.

## Script Inventory

| Script | Purpose | Inputs | Output / Side Effects |
|--------|---------|--------|------------------------|
| `scripts/sync-digests.ts` | Fetch digest archive before frontend build | `https://api.pharos.watch/api/digest-archive` | Writes `data/digests.json` |
| `scripts/check-seo-static.mjs` | Validate static-export SEO/meta/link integrity | `out/` build output | Fails non-zero on SEO/crawlability issues |
| `scripts/smoke-api.mjs` | HTTP smoke checks for strict API contract paths | `--base-url` or `SMOKE_API_BASE` / `API_BASE_URL` | Exits non-zero on shape/range/status failures |
| `scripts/smoke-ui.mjs` | Browser smoke check for live homepage data state + mobile overflow regression routes | `--url`, `--skip-overflow`, `SMOKE_UI_URL`, optional `SMOKE_UI_OVERFLOW_ROUTES`, `SMOKE_UI_OVERFLOW_WAIT_MS` | Exits non-zero on homepage outage/empty state or horizontal overflow on tracked mobile routes |
| `scripts/check-critical-coverage.mjs` | Enforce line coverage floor for critical files | `coverage/lcov.info`, `CRITICAL_COVERAGE_THRESHOLD` | Exits non-zero if critical files are below threshold |
| `scripts/test-merge-gate.mjs` | Delta-aware local gate for merged worktree changes | Local git diff + npm scripts | Runs targeted lint/test/coverage/type-check commands |
| `scripts/update-critical-coverage-baseline.mjs` | Refresh `.ci/critical-coverage-baseline.json` from current report | `coverage/lcov.info` | Updates baseline coverage ratchet file |
| `scripts/fetch-logos.ts` | Refresh logo map from DefiLlama + CoinGecko | Public APIs | Writes `data/logos.json` |
| `scripts/backfill-gold-depegs.sh` | Batch-run depeg backfill for gold coins | `WORKER_URL`, `ADMIN_KEY` (or `worker/.dev.vars`) | Calls `/api/backfill-depegs?stablecoin=...` per gold coin |
| `scripts/screenshot-og.mjs` | Capture OG images for public pages | Playwright + live `pharos.watch` | Writes `public/og-*.png` |

## CI-Critical Scripts

These are wired into deploy workflow (`.github/workflows/deploy-cloudflare.yml`):

- `sync-digests.ts` before `npm run build`
- `check-seo-static.mjs` via `npm run seo:check`
- `smoke-api.mjs` via `npm run test:smoke-api`
- `smoke-ui.mjs` via `npm run test:smoke-ui`
- `check-critical-coverage.mjs` via `npm run coverage:critical`

## Operational Notes

### `backfill-gold-depegs.sh`

- Reads `ADMIN_KEY` from environment first; falls back to `worker/.dev.vars`.
- Defaults `WORKER_URL` to `https://api.pharos.watch`.
- Uses `POST` requests (admin mutating endpoint contract).
- Backfills only configured gold IDs in the script (`gold-xaut`, `gold-paxg`, etc.).

### `fetch-logos.ts`

- Designed to run locally (CoinGecko blocks Worker-origin access patterns).
- Pulls DefiLlama stablecoin list, maps `gecko_id` to internal IDs, then fetches CoinGecko market data in batches.

### `screenshot-og.mjs`

- Uses Playwright directly.
- Captures fixed 1200×630 screenshots for selected routes and writes them into `public/`.

### `smoke-ui.mjs`

- Uses Playwright CLI in a temporary session.
- Verifies homepage is not in outage/empty state (`Failed to load data`, missing table rows, etc.).
- Runs mobile overflow checks at `390x844` on a default critical route set:
  - `/`, `/dependency-map/`, `/flows/`, `/yield/`, `/liquidity/`, `/depeg/`, `/blacklist/`, `/stability-index/`, `/safety-scores/`
- Override checked routes via `SMOKE_UI_OVERFLOW_ROUTES` (comma-separated), or skip overflow checks with `--skip-overflow`.

## Safe Usage Guidelines

- Treat `backfill-*` scripts as admin operations: run against staging/dev first when possible.
- Run smoke scripts against explicit URLs during incident debugging (avoid relying on default env fallback).
- Keep script-owned generated artifacts (`data/digests.json`, `data/logos.json`, `public/og-*.png`) under version control policy used by this repo.
