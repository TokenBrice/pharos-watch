# Scripts

## Overview

Operational and CI helper scripts live in `scripts/`. They support build integrity, smoke checks, data sync, and targeted maintenance tasks.

## Script Inventory

| Script                                          | Purpose                                                                                                                               | Inputs                                                                                                                                                                                                                                                                                                     | Output / Side Effects                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `scripts/sync-digests.ts`                       | Fetch digest archive before frontend build                                                                                            | `https://api.pharos.watch/api/digest-archive`                                                                                                                                                                                                                                                              | Writes `data/digests.json`                                                                              |
| `scripts/generate-redirects.ts`                 | Regenerate Cloudflare Pages redirects for legacy stablecoin IDs before frontend build                                                 | Existing `public/_redirects` + embedded ID mapping tables                                                                                                                                                                                                                                                  | Idempotently updates `public/_redirects`                                                                |
| `scripts/check-seo-static.mjs`                  | Validate static-export SEO/meta/link integrity                                                                                        | `out/` build output                                                                                                                                                                                                                                                                                        | Fails non-zero on SEO/crawlability issues                                                               |
| `scripts/serve-static-export.mjs`               | Serve the built static export locally and proxy `/api/*` to the configured public API base for pre-deploy browser smoke               | `STATIC_EXPORT_ROOT`, `STATIC_EXPORT_HOST`, `STATIC_EXPORT_PORT`, `STATIC_EXPORT_API_BASE`                                                                                                                                                                                                                | Starts a local HTTP server for the exported app + API proxy                                             |
| `scripts/smoke-api.mjs`                         | HTTP smoke checks for strict API contract paths                                                                                       | `--base-url`, `--timeout-ms`, `--retry-count`, `--retry-delay-ms`, or `SMOKE_API_BASE` / `API_BASE_URL`, optional `SMOKE_API_TIMEOUT_MS`, `SMOKE_API_RETRY_COUNT`, `SMOKE_API_RETRY_DELAY_MS`                                                                                                              | Exits non-zero on shape/range/status failures                                                           |
| `scripts/smoke-ops.mjs`                         | Private post-deploy smoke for the Access-protected ops UI and ops API                                                                 | `SMOKE_OPS_UI_URL`, `SMOKE_OPS_API_BASE`, `OPS_SMOKE_CF_ACCESS_CLIENT_ID`, `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET`                                                                                                                                                                                             | Exits non-zero on ops-host shell or admin API failures                                                  |
| `scripts/smoke-ui.mjs`                          | Browser smoke check for live homepage data state + mobile overflow regression routes                                                  | `--url`, `--skip-overflow`, `SMOKE_UI_URL`, optional `SMOKE_UI_WAIT_TIMEOUT_MS`, `SMOKE_UI_RETRY_COUNT`, `SMOKE_UI_RETRY_DELAY_MS`, `SMOKE_UI_OVERFLOW_ROUTES`, `SMOKE_UI_OVERFLOW_WAIT_MS`, `SMOKE_UI_OVERFLOW_SETTLE_SAMPLES`, `SMOKE_UI_OVERFLOW_SAMPLE_INTERVAL_MS`, `SMOKE_UI_STYLE_READY_TIMEOUT_MS` | Exits non-zero on homepage outage/empty state or sustained horizontal overflow on tracked mobile routes |
| `scripts/check-worker-import-boundary.mjs`      | Enforce the shared boundary: `worker/src/**` may not import `src/**`, and `src` / `shared` / `scripts` may not import `worker/src/**` | `worker/src/**`, `src/**`, `shared/**`, `scripts/**`                                                                                                                                                                                                                                                       | Exits non-zero with offending import locations                                                          |
| `scripts/check-cron-schedule-sync.ts`           | Verify `shared/lib/cron-jobs.ts` stays aligned with `worker/wrangler.toml` cron declarations                                           | `shared/lib/cron-jobs.ts`, `worker/wrangler.toml`                                                                                                                                                                                                                                                          | Exits non-zero on cron trigger mismatches                                                               |
| `scripts/check-worker-migrations.mjs`           | Replay every worker SQL migration against a throwaway SQLite database                                                                 | `worker/migrations/*.sql`, Node 22+ `node:sqlite` or local `sqlite3` fallback                                                                                                                                                                                                                              | Exits non-zero on invalid migration SQL / ordering issues                                               |
| `scripts/check-critical-coverage.mjs`           | Enforce line coverage floor for critical files                                                                                        | `coverage/lcov.info`, `CRITICAL_COVERAGE_THRESHOLD`                                                                                                                                                                                                                                                        | Exits non-zero if critical files are below threshold                                                    |
| `scripts/test-merge-gate.mjs`                   | Delta-aware local gate for merged worktree changes                                                                                    | Local git diff + npm scripts                                                                                                                                                                                                                                                                               | Runs targeted lint/test/coverage/type-check commands                                                    |
| `scripts/update-critical-coverage-baseline.mjs` | Refresh `.ci/critical-coverage-baseline.json` from current report                                                                     | `coverage/lcov.info`                                                                                                                                                                                                                                                                                       | Updates baseline coverage ratchet file                                                                  |
| `scripts/fetch-logos.ts`                        | Refresh logo map from DefiLlama + CoinGecko                                                                                           | Public APIs                                                                                                                                                                                                                                                                                                | Writes `data/logos.json`                                                                                |
| `scripts/backfill-gold-depegs.sh`               | Batch-run depeg backfill for gold coins                                                                                               | `WORKER_URL`, `OPS_API_SERVICE_TOKEN_ID`, `OPS_API_SERVICE_TOKEN_SECRET`                                                                                                                                                                                                                                   | Calls `/api/backfill-depegs?stablecoin=...` per gold coin                                               |
| `scripts/register-telegram-webhook.sh`          | One-time Telegram webhook registration                                                                                                | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, optional `WEBHOOK_BASE_URL`                                                                                                                                                                                                                              | Calls Telegram `setWebhook` for `${WEBHOOK_BASE_URL:-https://api.pharos.watch}/api/telegram-webhook?secret=...` |
| `scripts/check-duplicate-exports.mjs`           | Detect duplicate export names across shared/lib, src/lib, and worker/src/lib                                                          | `shared/lib/**`, `src/lib/**`, `worker/src/lib/**`                                                                                                                                                                                                                                                         | Exits non-zero on duplicate export names (catches post-merge conflicts from parallel worktrees)          |
| `scripts/check-doc-counts.mjs`                  | Detect stale hardcoded counts (stablecoins, adapters, bluechip slugs, live-enabled coins) in primary docs | `shared/lib/stablecoins/index.ts`, `shared/lib/shadow-stablecoins.ts`, `worker/src/cron/reserve-adapters/index.ts`, `worker/src/lib/bluechip-slugs.ts`, `shared/lib/stablecoins/*.ts`, primary doc files | Exits non-zero listing files with stale counts                                                          |
| `scripts/screenshot-og.mjs`                     | Capture OG images for public pages                                                                                                    | System Playwright install (`/usr/lib/node_modules/playwright/index.mjs`) + live `pharos.watch`                                                                                                                                                                                                           | Writes `public/og-*.png`                                                                                |

## CI-Critical Scripts

These are wired into the GitHub Actions CI workflows (`.github/workflows/pull-request-checks.yml` and `.github/workflows/deploy-cloudflare.yml`) directly, or indirectly through `npm run build`:

- `sync-digests.ts` before `npm run build`
- `generate-redirects.ts` via the `prebuild` hook that runs automatically before `npm run build`
- `check-seo-static.mjs` via `npm run seo:check`
- `serve-static-export.mjs` via the pre-deploy `smoke-ui` gate in `.github/workflows/deploy-cloudflare.yml`
- `smoke-api.mjs` via `npm run test:smoke-api`
- `smoke-ops.mjs` via `npm run test:smoke-ops`
- `smoke-ui.mjs` via `npm run test:smoke-ui`
- `check-worker-import-boundary.mjs` via `npm run check:worker-boundary`
- `check-worker-migrations.mjs` via `npm run check:migrations`
- `check-critical-coverage.mjs` via `npm run coverage:critical`
- `check-cron-schedule-sync.ts` via `npm run check:cron-sync`
- `check-doc-counts.mjs` via `npm run check:doc-counts`
- `check-duplicate-exports.mjs` via `npm run check:duplicate-exports`

## Operational Notes

### `backfill-gold-depegs.sh`

- Uses Access service-token auth via `OPS_API_SERVICE_TOKEN_ID` + `OPS_API_SERVICE_TOKEN_SECRET`.
- Defaults `WORKER_URL` to `https://ops-api.pharos.watch`.
- Uses `POST` requests (admin mutating endpoint contract).
- Backfills the tracked gold stablecoins configured in the script (`xaut-tether`, `paxg-paxos`, `kau-kinesis`, `xaum-matrixdock`, `cgo-comtech`, `dgld-gold-token-sa`, `pgold-pleasing`, `ggbr-goldfish-gold`).

### `fetch-logos.ts`

- Designed to run locally (CoinGecko blocks Worker-origin access patterns).
- Pulls DefiLlama stablecoin list, maps `gecko_id` to internal IDs, then fetches CoinGecko market data in batches.

### `register-telegram-webhook.sh`

- Requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`.
- Supports `WEBHOOK_BASE_URL` override; defaults to `https://api.pharos.watch`.
- Calls Telegram `setWebhook` for `${WEBHOOK_BASE_URL}/api/telegram-webhook?secret=...`.

### `screenshot-og.mjs`

- Imports Playwright from `/usr/lib/node_modules/playwright/index.mjs`, so it assumes a system-installed package at that path.
- Captures fixed 1200×630 screenshots for selected routes and writes them into `public/`.

### `smoke-ui.mjs`

- Uses Playwright CLI in a temporary session.
- In CI deploys, the browser now targets a locally served `out/` export before Pages production deploy; `scripts/serve-static-export.mjs` proxies `/api/*` to the configured public API base so the smoke still exercises live API responses against the exact built frontend artifact.
- Verifies homepage is not in outage/empty state (`Failed to load data`, `stablecoins:404`, `Data not yet available`, `Connection issue`, `No stablecoin data available`, missing rows/ticker).
- Homepage data wait retries once on timeout by default (configurable via `SMOKE_UI_RETRY_COUNT` / `SMOKE_UI_RETRY_DELAY_MS`) and includes a compact DOM text preview in timeout diagnostics.
- Runs mobile overflow checks at `390x844` on a default critical route set:
  - `/`, `/dependency-map/`, `/flows/`, `/yield/`, `/liquidity/`, `/depeg/`, `/blacklist/`, `/stability-index/`, `/safety-scores/`
- Overflow detection samples layout multiple times and retries once before failing, which filters transient post-deploy layout jitter while still catching sustained overflow regressions.
- Override checked routes via `SMOKE_UI_OVERFLOW_ROUTES` (comma-separated), or skip overflow checks with `--skip-overflow`.

### `serve-static-export.mjs`

- Defaults to serving `out/` on `127.0.0.1:4173`.
- Proxies `GET`/`HEAD` requests under `/api/*` to `STATIC_EXPORT_API_BASE` (default: `https://api.pharos.watch`).
- Exists to keep browser smoke pre-deploy while still exercising the same API-backed UI code paths as production.

### `smoke-api.mjs`

- Validates `/api/health` and every strict contract endpoint derived from `shared/lib/api-endpoints.ts`.
- Executes strict endpoint checks sequentially to avoid post-deploy request fan-out against a freshly deployed worker.
- Retries transient request failures once by default (timeouts/network errors/5xx/429/408); tune with `SMOKE_API_RETRY_COUNT` and `SMOKE_API_RETRY_DELAY_MS`.
- Per-request timeout defaults to `12000ms`; tune with `SMOKE_API_TIMEOUT_MS`.

### `smoke-ops.mjs`

- Uses Cloudflare Access service-token headers (`OPS_SMOKE_CF_ACCESS_CLIENT_ID` / `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET`) rather than raw `ADMIN_KEY`.
- Defaults to `https://ops.pharos.watch/admin/` and `https://ops-api.pharos.watch`, with overrides via `SMOKE_OPS_UI_URL` / `SMOKE_OPS_API_BASE`.
- Verifies the operator UI shell plus `/api/status`, `/api/status-history?limit=5`, and the safe dry-run `audit-depeg-history` admin path.

## Safe Usage Guidelines

- Treat `backfill-*` scripts as admin operations: run against staging/dev first when possible.
- Run smoke scripts against explicit URLs during incident debugging (avoid relying on default env fallback).
- Keep script-owned generated artifacts (`data/digests.json`, `data/logos.json`, `public/og-*.png`) under version control policy used by this repo.
