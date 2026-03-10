# Testing & Linting

## Overview

The project uses **Vitest** for unit tests and **ESLint** (via `eslint-config-next`) for linting. Both run in CI before every deploy.

## Commands

```bash
npm test              # Run all tests once (CI mode)
npm run test:watch    # Watch mode — re-runs on file changes
npm run lint          # ESLint across frontend + worker code
npm run seo:check     # Static SEO audit against built `out/` HTML
npm run check:worker-boundary # Enforce worker/src import boundary (no src/lib/* imports)
npm run check:migrations # Replay worker D1 migrations against a throwaway SQLite DB
npm run lint -- --fix # Auto-fix fixable warnings (stale directives, etc.)
npm test -- --coverage # Run tests with V8 coverage report
npm run test:critical-contracts # Critical endpoint contract suite
npm run test:invariants # Critical numerical/schema invariant suite
npm run coverage:critical # Full coverage + critical-path line-coverage gate
npm run test:merge-gate # Delta-aware local gate before pushing merged worktree changes
npm run test:smoke-api -- --base-url https://api.pharos.watch # HTTP smoke checks for critical API endpoints
npm run test:smoke-ui -- --url https://pharos.watch # Browser-level UI smoke check + mobile overflow route checks
```

## CI Pipeline

Defined in `.github/workflows/deploy-cloudflare.yml`. Deploys now run in five jobs:

For deployment/worktree operating procedure (including the local merge gate before pushing `main`), see `docs/deployment-process.md`.

1. `validate` (runs before any deployment):
   - `npm run lint`
   - `npm run check:worker-boundary`
   - `npm run check:migrations`
   - `npm test`
   - `npm run coverage:critical`
   - `cd worker && npx tsc --noEmit`
2. `deploy-worker` (needs `validate`):
   - Apply D1 migrations
   - Deploy worker
   - Sync routes/domains/cron triggers with `wrangler triggers deploy`
3. `smoke-api` (needs `deploy-worker`):
   - Run `npm run test:smoke-api`
   - Uses `SMOKE_API_BASE` from `vars.SMOKE_API_BASE_URL` (preferred) or `vars.API_BASE_URL`
   - Runs strict API checks sequentially with bounded transient retry behavior (`SMOKE_API_RETRY_COUNT` default `1`, `SMOKE_API_TIMEOUT_MS` default `12000`)
4. `deploy-pages` (needs `smoke-api`):
   - `npx tsx scripts/sync-digests.ts`
   - `npm run build`
   - `npm run seo:check`
   - Deploy to Cloudflare Pages
5. `smoke-ui` (needs `deploy-pages`):
   - Run `npm run test:smoke-ui`
   - Uses `SMOKE_UI_URL` from `vars.SMOKE_UI_URL` (fallback: `https://pharos.watch`)
   - Validates homepage data render (with a single timeout retry) and checks for sustained horizontal overflow at `390x844` on critical routes (multi-sample + one retry)

This ordering prevents a frontend deploy if the newly deployed worker fails critical endpoint smoke checks, then runs a fast post-deploy browser sanity check on the live site.

`npm run check:migrations` replays every file in `worker/migrations/` against a throwaway SQLite database before deploy. It uses Node's built-in `node:sqlite` module on Node 22+ and falls back to the `sqlite3` CLI when needed, which catches schema typos in unapplied D1 migrations before `deploy-worker` touches production.

`npm run seo:check` is the static-export SEO gate. It inspects the built `out/` HTML for missing title/description/canonical/OpenGraph/Twitter tags, duplicate or missing `h1`s on indexable pages, CSR bailout markers, sitemap omissions, orphan pages, and indexable routes that are more than three clicks away from `/`.

## Test Setup

**Config:** `vitest.config.ts`

```ts
export default defineConfig({
  test: {
    exclude: [".worktrees/**", "worktrees/**", ".next/**", "out/**", "coverage/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: { lines: 55 }, // Coverage gate — CI fails if lines < 55%
    },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src"), "@shared": path.resolve(__dirname, "shared") } },
});
```

**Locations:**
- `src/lib/__tests__/` — frontend library tests (pure functions)
- `src/components/__tests__/` — component-level pure/helper logic tests
- `src/hooks/__tests__/` — hook utility/state tests
- `src/__tests__/` — frontend component/integration tests
- `worker/src/__tests__/` — worker entrypoint tests (`fetch` request policy + `scheduled` cron dispatch wiring)
- `worker/src/lib/__tests__/` — worker library tests (scoring, parsing)
- `worker/src/api/__tests__/` — API handler contract tests
- `worker/src/cron/__tests__/` — cron job tests (with degraded-mode scenarios)
- `worker/src/cron/dex-discovery/__tests__/` — extracted DEX discovery cron tests
- `worker/src/cron/dex-liquidity/__tests__/` — extracted DEX liquidity merge/staging tests

**Pattern:** `*.test.ts` — Vitest discovers files matching `**/*.{test,spec}.?(c|m)[jt]s?(x)`.

## Test Infrastructure

### Mock D1 (`worker/src/api/__tests__/helpers/mock-d1.ts`)

Lightweight substring-based D1 mock. Returns canned data based on SQL query substring matching.

```ts
import { mockD1 } from "./helpers/mock-d1";

const db = mockD1([
  { match: "COUNT", rows: [{ total: 5 }] },
  { match: "blacklist_events", rows: [row1, row2] },
]);
```

- `match` — substring to look for in the SQL query
- `rows` — array of row objects for `.all()` results
- `first` — optional single object for `.first()` results
- `batch()` — executes each statement's `.all()` and returns array of results

### Mock Fetch (`worker/src/api/__tests__/helpers/mock-fetch.ts`)

Stubs global `fetch` for testing cron jobs that make HTTP requests.

```ts
import { mockFetch } from "./helpers/mock-fetch";

const spy = mockFetch([
  { match: "frankfurter.app", body: { rates: { EUR: 0.925 } } },
  { match: "gold-api.com", body: { price: 2900 }, status: 200 },
]);
```

- `match` — substring to match against the request URL
- `body` — response body (auto-serialized to JSON)
- `status` — HTTP status code (default: 200)
- `headers` — additional response headers
- Unmatched URLs return 404
- Call `vi.restoreAllMocks()` in `afterEach` to clean up

### Shared Fixtures (`worker/src/api/__tests__/helpers/fixtures.ts`)

Factory functions that return complete DB rows with sensible defaults. Pass `overrides` for specific values.

| Factory | Returns |
|---------|---------|
| `makeAsset()` | DL pegged asset (id, symbol, price, pegType, circulating, chainCirculating) |
| `makeBlacklistRow()` | blacklist_events row |
| `makeDepegRow()` | depeg_events row |
| `makeSupplyRow()` | supply_history row |
| `makeMintBurnRow()` | mint_burn_events row |
| `makeDexLiquidityRow()` | dex_liquidity row (with v2 fields) |
| `makeYieldHistoryRow()` | yield_history row |
| `makeDexLiquidityHistoryRow()` | dex_liquidity_history row |
| `makeDigestRow()` | daily_digest row |

Example:
```ts
import { makeBlacklistRow } from "./helpers/fixtures";

const row = makeBlacklistRow({ stablecoin: "USDC", event_type: "freeze" });
```

### Shared Auth Helpers (`worker/src/api/__tests__/helpers/auth.ts`)

Use these helpers in worker API contract tests that exercise admin auth and URL/request plumbing.

```ts
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "./helpers/auth";

stubCryptoForAuth();

const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
const url = makeApiUrl("/api/status?limit=5");
```

- `stubCryptoForAuth()` — shared `crypto.subtle` stub for `requireAdmin`-based handlers.
- `makeApiRequest(path, options)` — creates requests with optional `method`, `adminKey`, `headers`, and `body`.
- `makeApiUrl(path)` — normalizes relative API paths into `https://x/...` URLs.

Use these helpers instead of duplicating per-file `vi.stubGlobal("crypto", ...)` or repetitive request builders.

## Test File Inventory

This inventory is representative, not exhaustive. For the full current list, run:

```bash
find src/lib/__tests__ worker/src -path '*/__tests__/*' -type f | sort
```

### Frontend Library Tests (`src/lib/__tests__/`)

| File | Module Under Test | What It Covers |
|------|-------------------|----------------|
| `format.test.ts` | `shared/lib/format.ts` | `formatCurrency`, `formatBps`, `formatPegDeviation`, `formatPercentChange`, `formatSupply`, `formatAddress`, `formatDuration`, `formatNativePrice`, `formatPegStability`, `formatDeathDate`, `formatDeathDateShort` |
| `supply.test.ts` | `shared/lib/supply.ts` | `sumPegBuckets`, `getCirculatingRaw`, `getPrevDayRaw`, `getPrevWeekRaw`, `getPrevMonthRaw` |
| `classification.test.ts` | `shared/lib/classification.ts` | Label maps, short label consistency, color map integrity, `PEG_CURRENCY_COUNT` |
| `report-cards.test.ts` | `shared/lib/report-cards.ts` | Grade computation, dimension scorers, peg multiplier, dependency risk, stress test |
| `reserve-templates.test.ts` | `shared/lib/reserve-templates.ts` | Reserve composition templates, `getReserves()`, `deriveDependencies()` |
| `reserve-coinid-validation.test.ts` | `shared/lib/reserve-templates.ts` | Reserve slice `coinId` references match tracked stablecoin IDs |
| `liquidity-coverage.test.ts` | `src/lib/dex-constants.ts` | DEX pool configs cover all stablecoins with DEX presence |
| `api-endpoints.test.ts` | `shared/lib/api-endpoints.ts` | Endpoint registry invariants: probe groups, status actions, cache/method flags, strict contract path uniqueness, smoke assertion alignment |
| `api-fetch-contracts.test.ts` | `shared/types/index.ts` + `src/lib/api.ts` | Shared Zod contracts and frontend API helpers stay aligned on critical endpoints |
| `critical-invariants.test.ts` | Shared methodology constants and schema invariants | Cross-surface invariants for contracts, methodology metadata, and route-critical defaults |
| `blacklist-api.test.ts` | `src/lib/blacklist-api.ts` | Query param encoding and API path generation for blacklist filters |
| `methodology-version.test.ts` | `shared/lib/methodology-version.ts` | Version-window resolution, labels, and changelog selection logic |
| `mint-burn-timeframes.test.ts` | `src/lib/mint-burn-timeframes.ts` | Timeframe presets and label semantics for flow views |
| `peg-scoring.test.ts` | `shared/lib/peg-score.ts` + `src/lib/peg-stability.ts` | Peg score computation helpers plus UI-facing peg-stability formatting |
| `stablecoin-detail-derive.test.ts` | `src/lib/stablecoin-detail-derive.ts` | Stablecoin detail pure derivations: supply fallback, deviation guards, 90d reference tolerance, peg-reference fallback |
| `stablecoin-schema-compat.test.ts` | `shared/lib/stablecoins.ts` + schemas | Tracked stablecoin metadata remains compatible with shared schemas |
| `yield-scatter.test.ts` | `src/lib/yield-scatter.ts` | Scatterplot point derivation and label bucketing for yield views |
| `severity-colors.test.ts` | `src/lib/severity-colors.ts` | Deviation threshold classes/icons/hex mapping, score-tier thresholds, peg/durability color helpers |

### Frontend Component Tests (`src/__tests__/`)

| File | What It Covers |
|------|----------------|
| `depeg-tracker-sort.test.ts` | Depeg event sorting logic |
| `page-metadata.test.ts` | Metadata generation and canonical route wiring for indexable pages |
| `portfolio-categorize.test.ts` | Portfolio upstream exposure categorization |

### Component / Hook Utility Tests

| File | What It Covers |
|------|----------------|
| `src/components/__tests__/cron-card.test.tsx` | Status cron-card server-render summaries for self-check, DEX discovery, and scoring runs |
| `src/components/__tests__/cron-config.test.ts` | Status cron config labeling and schedule presentation |
| `src/components/__tests__/dews-summary.test.ts` | DEWS radar tap/click interaction resolver logic |
| `src/components/__tests__/liquidity-stats.test.ts` | Liquidity headline stat formatting and NR handling |
| `src/components/__tests__/liquidity-table.test.ts` | Liquidity row comparator behavior and filter-driven pagination reset flow |
| `src/components/__tests__/safety-score-history-section.test.tsx` | Safety Score detail timeline seed/transition labeling and conditional suppression when loading/error/empty |
| `src/hooks/__tests__/use-count-up.test.ts` | Opt-in jsdom hook test for count-up animation timing and reduced-motion behavior |
| `src/hooks/__tests__/use-entrance-sequence.test.ts` | Opt-in jsdom hook test for staged reveal sequencing |
| `src/hooks/__tests__/use-url-filters.test.ts` | URL param state helpers and encoding rules |
| `src/hooks/__tests__/query-polling-policy.test.ts` | Shared polling policy wiring (`staleTime`, `refetchInterval`, `retry`) for status-page hooks |
| `src/hooks/__tests__/use-safety-score-history.test.ts` | Safety Score history hook query-key scoping, daily polling policy, and endpoint path wiring |
| `src/hooks/__tests__/use-sort.test.ts` | Table sort state transitions and keyboard activation key gating |
| `src/hooks/__tests__/use-sorted-table-rows.test.ts` | Pure table row sorting helper behavior and immutability |
| `src/hooks/__tests__/use-table-pagination.test.ts` | Pagination derivation + persisted page reset semantics when row totals change |

### Worker Library Tests (`worker/src/lib/__tests__/`)

| File | Module Under Test | What It Covers |
|------|-------------------|----------------|
| `alerts.test.ts` | `worker/src/lib/alerts.ts` | Webhook transport semantics, non-2xx failure handling, return-value contract |
| `api-utils.test.ts` | `worker/src/lib/api-utils.ts` | `parseIntParam`, `parseStablecoinHistoryQuery`, `jsonResponse`, `errorResponse`, `withErrorHandler`, `createCacheHandler` |
| `mint-burn-scoring.test.ts` | `worker/src/lib/mint-burn-scoring.ts` | `computeFlowIntensity`, `computeGaugeScore`, `detectFlightToQuality`, `getGaugeBand` |
| `evm-logs.test.ts` | `worker/src/lib/evm-logs.ts` | `buildTopicParams`, `decodeAddress`, `decodeUint256`, `createBudget`, `budgetExhausted`, `createRateLimiter`, `fetchEvmLogsForTopics` |
| `resolve-market-cap.test.ts` | `worker/src/lib/resolve-market-cap.ts` | `resolveMarketCap` — CG vs computed mcap agreement, frozen data detection |
| `dews.test.ts` | `worker/src/lib/dews.ts` | `computeDEWS` — DEWS scoring, sub-signal computation, threat band assignment |
| `circuit-breaker.test.ts` | `worker/src/lib/circuit-breaker.ts` | Circuit state machine: closed/open/half-open transitions, probe intervals, alerts |
| `stability-index.test.ts` | `worker/src/lib/stability-index.ts` | PSI computation and component scoring |
| `safety-scores.test.ts` | `worker/src/lib/safety-scores.ts` | Shared safety score snapshot helper parity modes (`map` vs `full-grades`) |
| `report-cards-snapshot.test.ts` | `worker/src/lib/report-cards-snapshot.ts` | Shared report-card snapshot parity with `/api/report-cards` and cache-unavailable behavior |
| `peg-analytics.test.ts` | `worker/src/lib/peg-analytics.ts` | Shared peg analytics derivation (`eventsByCoin`, `pegDataById`) |
| `stablecoins-cache.test.ts` | `worker/src/lib/stablecoins-cache.ts` | Strict/lenient cache loading, missing cache behavior, malformed payloads, legacy array compatibility, FX fallback-rate filtering |
| `abort.test.ts` | `worker/src/lib/abort.ts` | Abort reason normalization, `throwIfAborted`, timed sleep resolution, abort-driven sleep rejection |
| `coingecko-onchain.test.ts` | `worker/src/lib/coingecko-onchain.ts` | API-key availability flag, request pacing, token/pool fetch response handling, volume parsing |
| `auth.test.ts` | `worker/src/lib/auth.ts` | Timing-safe admin auth guards, header parsing, and unauthorized responses |
| `db-utils.test.ts` | `worker/src/lib/db.ts` helpers | SQL helper composition and pagination/query utility behavior |
| `idempotency.test.ts` | `worker/src/lib/idempotency.ts` | Idempotency-key dedupe, replay semantics, and conflict handling |
| `log-cron-run.test.ts` | `worker/src/lib/db.ts` cron wrapper | Success/error/skipped logging and prune fallback behavior |
| `mint-burn-bridge-classifier.test.ts` | `worker/src/lib/mint-burn-pipeline/classification.ts` | CCIP bridge-burn classification and review fallbacks |
| `mint-burn-contracts.test.ts` | `worker/src/lib/mint-burn-contracts.ts` | Contract config invariants, decimals, and event definition coverage |
| `twitter.test.ts` | `worker/src/lib/twitter.ts` | Digest tweet text building, first-mention cashtag injection, truncation, OAuth posting/error handling |
| `status-reliability.test.ts` | `worker/src/lib/status-reliability.ts` | Hysteresis transitions, state snapshot staleness, transition listing, probe persistence, discrepancy streak/alert state |
| `cron-leases.test.ts` | `worker/src/lib/db.ts` | `acquireCronLease`, `renewCronLease`, `releaseCronLease`, `runCronWithLease` |
| `mint-burn-pipeline.test.ts` | `worker/src/lib/mint-burn-pipeline/*` | Shared ingestion helpers: inserted/ignored accounting, burn counters, affected-hour aggregation, sync-state upsert modes |
| `mint-burn-price-heal.test.ts` | `worker/src/lib/mint-burn-pipeline/price-heal.ts` | NULL-price auto-heal path, 48h cutoff, and affected-hour collection |
| `mint-burn-roundtrip.test.ts` | `worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts` | Same-transaction roundtrip tagging semantics |
| `psi-recompute.test.ts` | `worker/src/lib/psi-recompute.ts` | PSI recomputation triggers and rebuild selection logic |
| `telegram-alerts.test.ts` | `worker/src/lib/telegram-alerts.ts` | Alert subscription filters and message rendering |
| `telegram.test.ts` | `worker/src/lib/telegram.ts` | Telegram Bot API send/reply behavior and error handling |

### API Contract Tests (`worker/src/api/__tests__/`)

| File | Handler | Modes Tested |
|------|---------|--------------|
| `router-contract.test.ts` | `route` + strict frontend contract paths | All strict paths resolve in `worker/src/router.ts`, unknown paths return null, mutating admin GET guards hold (with audit dry-run exception) |
| `backfill-depegs.test.ts` | `handleBackfillDepegs` | Auth guard, unknown stablecoin 404, out-of-range batch no-op |
| `backfill-depegs-helpers.test.ts` | `backfill-depegs` helper logic | Supply parsing/nearest-snapshot lookup, historical secondary-FX caching, FX lookup fallback/nearest selection, large-cap depeg confirmation behavior |
| `backfill-supply-history.test.ts` | `handleBackfillSupplyHistory` | Auth guard, unknown stablecoin 404, out-of-range batch no-op, USD insertion path |
| `backfill-cg-prices.test.ts` | `handleBackfillCgPrices` | Auth guard, unknown stablecoin 404, out-of-range batch no-op, NULL-price fill |
| `backfill-stability-index.test.ts` | `handleBackfillStabilityIndex` | Auth guard, no-events 404, rebuild success shape |
| `audit-depeg-history.test.ts` | `handleAuditDepegHistory` | GET dry-run vs POST behavior, auth guard, and audit summary shape |
| `backfill-dews.test.ts` | `handleBackfillDEWS` | Admin auth, query parsing, and DEWS backtest response shape |
| `blacklist.test.ts` | `handleBlacklist` | 200 with events, empty results, 400 invalid params, camelCase mapping, X-Data-Age |
| `depeg-events.test.ts` | `handleDepegEvents` | 200 with events, empty results, 400 invalid params, camelCase mapping |
| `supply-history.test.ts` | `handleSupplyHistory` | 200 with history, empty, 400 missing/invalid stablecoin |
| `dex-liquidity-history.test.ts` | `handleDexLiquidityHistory` | 200 with history, empty, 400 missing/invalid stablecoin, coverage-confidence fields |
| `yield-history.test.ts` | `handleYieldHistory` | 200 with history, empty, 400 missing/invalid stablecoin, camelCase |
| `safety-score-history.test.ts` | `handleSafetyScoreHistory` | 200 with history/empty, 400 missing/invalid stablecoin, freshness headers |
| `mint-burn-events.test.ts` | `handleMintBurnEvents` | 200 with events, camelCase mapping, invalid stablecoin/direction/chain/burnType guards, freshness headers |
| `cache-passthrough.test.ts` | stablecoins, charts, usds, bluechip, yield-rankings | 503 cache miss, 200 with _meta, X-Data-Age |
| `dex-liquidity.test.ts` | `handleDexLiquidity` | 200 with liquidity map, empty map, coverage-confidence fields, degraded Warning header, X-Data-Age |
| `peg-summary.test.ts` | `handlePegSummary` | 503 cache miss, 200 with coins + summary, X-Data-Age |
| `report-cards.test.ts` | `handleReportCards` | 503 cache miss, 200 with cards/methodology/dependencyGraph |
| `stablecoin-detail.test.ts` | `handleStablecoinDetail` | Upstream retry/timeout fallback behavior, stale-cache fallback, parse-failure diagnostics |
| `stablecoin-summary.test.ts` | `handleStablecoinSummary` | 503 cache-miss/corrupt-cache handling, 404 unknown coin, 200 compact supply/price summary + freshness headers |
| `stablecoin-detail-commodity.test.ts` | `fetchCommodityTokens` helper | DefiLlama-empty fallback to CoinGecko market-chart + failure fallback to empty |
| `stablecoin-detail-defillama.test.ts` | `normalizeDefiLlamaDetailBody` helper | Non-USD normalization branches, USD no-op behavior, invalid JSON throw path |
| `daily-digest.test.ts` | `handleDailyDigest` | 200 with null digest, 200 with digest text, X-Data-Age |
| `digest-archive.test.ts` | `handleDigestArchive` | 200 empty, 200 with digests, PSI/mcap from input_data, null input_data |
| `digest-snapshot.test.ts` | `handleDigestSnapshot` | 400 missing/invalid date, 404 no digest, 200 with snapshot |
| `health.test.ts` | `handleHealth` | 200 health status shape, Cache-Control: no-store |
| `feedback.test.ts` | `handleFeedback` | Payload validation, rate limiting, verification routing, and GitHub mode selection |
| `mint-burn-flows.test.ts` | `handleMintBurnFlows` | Aggregate (gauge + coins[]), Per-coin (flat + chains[]), 404 |
| `backfill-mint-burn.test.ts` | `handleBackfillMintBurn` | Auth/validation, chunked ingestion progression, `done/nextFromBlock` semantics |
| `backfill-mint-burn-prices.test.ts` | `handleBackfillMintBurnPrices` | NULL-price backfill aggregation and response summary shape |
| `stability-index.test.ts` | `handleStabilityIndex` | Summary, Detail (with components in history) |
| `status.test.ts` | `handleStatus` | Admin status payload synthesis, cache/cron health aggregation, liquidity health extraction, and probe sections |
| `status-history.test.ts` | `handleStatusHistory` | Timeline/probe history pagination and range filters |
| `stress-signals.test.ts` | `handleStressSignals` | DEWS scores, threat bands, signal components |
| `telegram-webhook.test.ts` | `handleTelegramWebhook` | Command routing, subscription state changes, and webhook auth validation |

### Worker Entrypoint Tests (`worker/src/__tests__/`)

| File | Module Under Test | What It Covers |
|------|-------------------|----------------|
| `index.fetch.test.ts` | `worker.fetch` | CORS preflight, method guards, edge-cache hit/miss behavior, cache-bypass paths |
| `index.scheduled.test.ts` | `worker.scheduled` | Cron fan-out wiring and chained dependencies (`stablecoins -> snapshot/PSI/DEWS`, `dex -> yield`) |

### Cron Tests (`worker/src/cron/__tests__/`)

| File | Cron Under Test | What It Covers |
|------|-----------------|----------------|
| `sync-stablecoins.test.ts` | `sync-stablecoins.ts` | Main/fallback validation guards, stale detection, depeg handoff, cache-write invariants |
| `sync-stablecoins-stages.test.ts` | `sync-stablecoins/stages.ts` | Extracted pure stage helpers (structural filtering, chain normalization, staleness summary) |
| `sync-stablecoin-charts.test.ts` | `sync-stablecoin-charts.ts` | Chart sync cache writes, retention, and error handling |
| `detect-depegs.test.ts` | `detect-depegs.ts` | Stable prices, depeg open/close/update, direction change, NAV skip, supply threshold, DEX cross-validation, duplicate merge |
| `compute-dews.test.ts` | `compute-dews.ts` | DEWS cache writes, metadata, and no-data handling |
| `daily-digest.test.ts` | `daily-digest.ts` | Digest generation control flow, posting toggles, and cache persistence |
| `dispatch-telegram-alerts.test.ts` | `dispatch-telegram-alerts.ts` | Snapshot diffs, rate guards, and subscriber fan-out behavior |
| `sync-dex-liquidity.test.ts` | `dex-liquidity/orchestrator.ts` | Catastrophic throw path, degraded status propagation, success path |
| `dex-liquidity-fallbacks.test.ts` | `dex-liquidity/fetch-fallbacks.ts` | DexScreener and CoinGecko ticker fallback ingestion behavior |
| `enrich-prices.test.ts` | `enrich-prices.ts` | `isReasonablePrice` for all peg types (USD, EUR, JPY, IDR, GOLD, SILVER, etc.), FX-rate-aware bounds, `hasMissingPrice` edge cases |
| `fetch-tbill-rate.test.ts` | `fetch-tbill-rate.ts` | FRED parsing, cache updates, and degraded fallback behavior |
| `snapshot-psi.test.ts` | `snapshot-psi.ts` | Daily PSI snapshot writes and methodology-version attribution |
| `snapshot-supply.test.ts` | `snapshot-supply.ts` | Cache missing, stale cache (>1200s), valid insert for PSI-eligible assets, zero supply skip |
| `snapshot-safety-grade-history.test.ts` | `snapshot-safety-grade-history.ts` | Seed rows, grade-change inserts, unchanged-grade idempotent reruns |
| `stability-index.test.ts` | `stability-index.ts` | Cron PSI recomputation and cache/history persistence behavior |
| `status-self-check.test.ts` | `status-self-check.ts` | Probe modes, latency summaries, and hysteresis persistence |
| `sync-blacklist.test.ts` | `sync-blacklist.ts` | Incremental multi-chain sync, enrichment, and state advancement |
| `sync-bluechip.test.ts` | `sync-bluechip.ts` | Bluechip scrape normalization and cache writes |
| `sync-usds-status.test.ts` | `sync-usds-status.ts` | USDS implementation/freeze-module on-chain checks |
| `yield-helpers.test.ts` | `yield-helpers.ts` | `computeApyFromRate`, `computePYS`, `computeYieldStability`, `computeApyVarianceScore`, `detectWarningSignals`, `findBestLendingPool` |
| `sync-fx-rates.test.ts` | `sync-fx-rates.ts` | Normal path (frankfurter + secondary + metals), degraded (frankfurter 503), secondary API for CNH/RUB/UAH/ARS |
| `sync-yield-data.test.ts` | `sync-yield-data.ts` | Yield ranking sync, validation guard, fallback behavior and ranking parity |
| `dex-liquidity-pool-helpers.test.ts` | `dex-liquidity/pool-helpers.ts` | Symbol parsing, pool classification, quality multipliers, chain-map toggles, durability/liquidity scoring branches, protocol normalization, pair/stress helpers |
| `dex-liquidity-process-pools.test.ts` | `dex-liquidity/process-pools.ts` | Pool filtering, address/symbol matching, collision safety, Curve/Uni v3/Aerodrome enrichment, weighted metric accumulation |
| `dex-liquidity-price-sanity.test.ts` | `dex-liquidity/price-sanity.ts` | DEX observation plausibility bounds and anomaly rejection |
| `dex-liquidity-scoring.test.ts` | `dex-liquidity/scoring.ts` | Pool filtering/scaling, per-coin/global aggregate recomputation, confidence-gated depth stability, DEX price median persistence |
| `confirm-pending-depegs.test.ts` | `confirm-pending-depegs.ts` | Pending depeg state-machine decisions, secondary confirmation paths, missing dex table handling, abort propagation |
| `dex-liquidity-persistence.test.ts` | `dex-liquidity/persistence.ts` | Current-score upserts, coverage-confidence persistence, zero-score placeholders, global sentinel row, daily snapshot reconciliation/no-op behavior |
| `sync-mint-burn.test.ts` | `sync-mint-burn.ts` | Incremental event ingestion, burn classification, degraded-mode and sync-state advancement behavior |
| `worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts` | `dex-discovery/orchestrator.ts` | Discovery tiering, backoff cadence, staged-pool writes, and budget exhaustion behavior |
| `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts` | `dex-liquidity/staging-merge.ts` | Staged-pool confidence decay, default filling, and merge-selection semantics |

## Conventions

### What to test

- **Pure `shared/lib/` + `src/lib/` functions** — formatters, supply helpers, classification maps, peg-rate derivation, and frontend derivations. These are the highest-value tests: deterministic, fast, and catch regressions in shared logic.
- **Edge cases** — `NaN`, `Infinity`, `null`, `undefined`, zero, negative values, empty inputs. The existing tests set this standard.
- **Boundary values** — tier boundaries in formatters (e.g., 999 vs 1000 for K suffix).
- **API contract tests** — when a worker handler has multiple response modes (different JSON shapes based on query params), add a contract test for each mode in `worker/src/api/__tests__/`. Use the D1 mock from `helpers/mock-d1.ts`.
- **Degraded-mode scenarios** — for cron jobs, test the normal path plus at least one failure/fallback scenario (e.g., upstream API 503, stale cache, missing data). Use `mockFetch()` to simulate API failures and `vi.useFakeTimers()` for deterministic time.

### What NOT to test (for now)

- **Broad DOM-rendered React integration tests** — jsdom is available only when a test opts in via `// @vitest-environment jsdom` (for example `src/hooks/__tests__/use-count-up.test.ts`). Most existing tests stay pure or use server rendering instead of full browser-like component integration.
- **API/worker handlers (full integration)** — the D1 mock tests response shape, not SQL correctness. Full end-to-end worker testing would need a real D1 instance.
- **React-rendering behavior inside hooks/components** — prefer pure derivation tests and mocked query tests unless there is high-value UI coupling.
- **Full external-service integration for cron orchestrators** — orchestration tests should mock `fetch`/D1 boundaries and assert status/metadata contracts, not live upstream behavior.

### Degraded-mode testing convention

For cron jobs with external dependencies (APIs, RPC nodes), test at least:

1. **Normal path** — all external calls succeed
2. **Primary source failure** — upstream API returns 503 or times out; verify fallback behavior
3. **Stale/missing cache** — handler gets `null` from `getCache()` or data older than threshold
4. **Boundary validation** — rate bounds, supply thresholds, deviation thresholds

Use `vi.mock()` to stub external modules (stablecoin list, peg-rates, supply helpers) and `mockFetch()` to control HTTP responses. Use `vi.useFakeTimers()` when test logic depends on `Date.now()`.

### Test style

- Use `describe` per function, `it` per behavior.
- Test names describe the behavior, not the implementation: `"returns 0 for undefined input"` not `"calls sumPegBuckets with undefined"`.
- Use the `mockCoin()` helper (see `supply.test.ts`) for partial `StablecoinData` mocks — avoids `as any` casts.
- Use shared fixtures from `helpers/fixtures.ts` for DB row mocks.
- Keep tests focused: one assertion per `it` block when possible.

## Coverage

**Threshold:** 55% lines (enforced by `vitest.config.ts` thresholds)

Run `npm test -- --coverage` to generate a detailed report. The V8 provider generates both text output and an `lcov` report for CI integration.

### Critical Coverage Gate

In addition to the global 55% line threshold, CI enforces a critical-path gate via `npm run coverage:critical`:

- Runs coverage for critical suites only (contract + invariant + targeted reliability suites for alerts/detail/dex orchestrator)
- Parses `coverage/lcov.info`
- Fails CI if any critical file falls below `CRITICAL_COVERAGE_THRESHOLD` (default: 40%, currently pinned to 40 in CI)
- For touched critical files, also enforces a no-regression ratchet using `.ci/critical-coverage-baseline.json`

Gate script: `scripts/check-critical-coverage.mjs`

Current critical file set:
- `src/lib/api.ts`
- `worker/src/lib/api-utils.ts`
- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/sync-yield-data.ts`
- `worker/src/api/peg-summary.ts`
- `worker/src/api/report-cards.ts`
- `worker/src/api/dex-liquidity.ts`
- `worker/src/api/stress-signals.ts`
- `worker/src/api/mint-burn-flows.ts`
- `worker/src/lib/alerts.ts` *(explicit threshold: 80% lines)*
- `worker/src/api/stablecoin-detail.ts` *(explicit threshold: 30% lines)*
- `worker/src/cron/dex-liquidity/orchestrator.ts` *(explicit threshold: 55% lines)*

### Critical Test Suites

- `npm run test:critical-contracts` covers strict contract paths (`stablecoins`, `peg-summary`, `report-cards`, `stability-index`, `dex-liquidity`, `stress-signals`, `mint-burn-flows`) plus router mapping tests to guarantee these paths are wired in `worker/src/router.ts`.
- `npm run test:invariants` covers numerical/schema invariants and cache-write validation guards in critical cron paths.
- `npm run test:merge-gate` runs a delta-aware local gate for merged worktree changes. It selects checks from changed paths (contracts/invariants/coverage, plus lint + worker type-check for TS/JS changes).
- `npm run test:smoke-api` performs HTTP-level smoke checks for `/api/health` plus every strict contract path (`stablecoins`, `peg-summary`, `report-cards`, `stability-index`, `dex-liquidity`, `stress-signals`, `mint-burn-flows`) with shape/range assertions, sequential endpoint execution, and bounded retries for transient failures.
- `npm run test:smoke-ui` performs a fast browser smoke check on the live site; it fails on homepage outage/empty states (`Failed to load data`, `stablecoins:404`, `Data not yet available`, `Connection issue`, `No stablecoin data available`) and on sustained horizontal overflow across tracked mobile routes.

### Tier-3 Structural Refactor Targeted Suites

These are the narrow suites used to lock behavior parity before and after the Tier-3 structural extractions:

- `npm test -- src/lib/__tests__/stablecoin-detail-derive.test.ts` validates pure detail-page derivations independently of React rendering.
- `npm test -- worker/src/lib/__tests__/mint-burn-pipeline.test.ts` validates shared cron/backfill ingestion helpers without endpoint orchestration noise.
- `npm test -- worker/src/cron/__tests__/sync-mint-burn.test.ts worker/src/api/__tests__/backfill-mint-burn.test.ts` validates entrypoint-level progression semantics (`inserted/ignored`, burn counters, `done/nextFromBlock`, sync-state mode differences).

## Adding a New Test

**Frontend library test:**
1. Create `src/lib/__tests__/<module>.test.ts`.
2. Import from the module under test using the canonical boundary:
   - `@shared/*` for runtime-shared modules
   - `@/lib/*` for frontend-only modules
3. Write `describe`/`it` blocks following the conventions above.
4. Run `npm test` to verify, then `npm run lint` to check for issues.

**Worker library test:** Same as above but in `worker/src/lib/__tests__/`. Import via relative paths (no `@/` alias).

**API contract test:** Create in `worker/src/api/__tests__/`. Import the handler and use `mockD1()` from `helpers/mock-d1.ts`. Use shared fixtures from `helpers/fixtures.ts` for row data. Validate response shape against Zod schemas from `shared/types/index.ts`.

**Cron test:** Create in `worker/src/cron/__tests__/`. Mock external dependencies with `vi.mock()` and HTTP calls with `mockFetch()`. Test both normal path and at least one degraded-mode scenario.

Example API contract test:

```ts
import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeBlacklistRow } from "./helpers/fixtures";
import { handleBlacklist } from "../blacklist";

describe("handleBlacklist", () => {
  const row = makeBlacklistRow();
  const db = mockD1([
    { match: "COUNT", rows: [{ total: 1 }] },
    { match: "blacklist_events", rows: [row] },
  ]);

  it("returns 200 with events array", async () => {
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist"));
    expect(res.status).toBe(200);
    const body = await res.json() as { events: unknown[]; total: number };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
  });
});
```

Example cron test with degraded mode:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: async (url: string, opts?: RequestInit) => fetch(url, opts),
}));

import { syncFxRates } from "../sync-fx-rates";

describe("syncFxRates", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("falls back gracefully when frankfurter.app returns 503", async () => {
    mockFetch([{ match: "frankfurter.app", body: {}, status: 503 }]);
    const db = mockD1([{ match: "cache", rows: [], first: null }]);
    const result = await syncFxRates(db);
    expect(result).toBeDefined(); // no throw
  });
});
```

## ESLint Configuration

**Config:** `eslint.config.mjs` (flat config format)

**Extends:** `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript`

**Custom rules** — React Compiler rules are downgraded to warnings since they flag valid patterns that work correctly at runtime:

| Rule | Level | Reason |
|------|-------|--------|
| `react-hooks/preserve-manual-memoization` | warn | Compiler can't optimize `useMemo([data])` when body accesses `data.current.*` sub-properties |
| `react-hooks/set-state-in-effect` | warn | Standard pattern for reading localStorage/sessionStorage on mount |
| `react-hooks/purity` | warn | `Date.now()` in render is intentional for timestamp-based UIs |
| `react-hooks/incompatible-library` | warn | TanStack Virtual `useVirtualizer()` — known library limitation |

**Ignored paths:** `.next/`, `out/`, `build/`, `coverage/`, `.worktrees/`, `worktrees/`, `.codex-autorunner/`, `worker/.wrangler/` (auto-generated build artifacts).

### Zod Runtime Validation

Schema validation in hooks is done via `useApiQuery(..., { schema })`. Current schema-validated response paths include:
- `StablecoinListResponseSchema`
- `DepegEventsResponseSchema`
- `PegSummaryResponseSchema`
- `DexLiquidityMapSchema`
- `StabilityIndexResponseSchema`
- `ReportCardsResponseSchema` (wired with a typed cast in `use-report-cards.ts`)
- `SafetyScoreHistoryResponseSchema` (wired with a typed cast in `use-safety-score-history.ts`)
- `MintBurnFlowsResponseSchema`
- `MintBurnPerCoinResponseSchema`
- `MintBurnEventsResponseSchema`
- `StressSignalsAllResponseSchema`
- `StressSignalDetailResponseSchema`

On validation failure, hooks log warnings and return data in degraded mode rather than hard-crashing the UI.

When adding a new API endpoint:
1. Define the response schema in `shared/types/index.ts` if the response has nested arrays or objects accessed via `.find()` / `.map()`
2. Pass the schema to `useApiQuery` via `{ schema: MyResponseSchema }`
3. Add a contract test in `worker/src/api/__tests__/` if the endpoint has multiple response modes

**Narrow-type gotcha:** If your response type uses string unions or branded types (e.g. `ReportCardGrade`, `DimensionKey`), Zod schemas infer `string`. In those cases, keep hand-written interfaces and cast schema wiring intentionally where needed (see `use-report-cards.ts`).

**Worker CI note:** `shared/types/index.ts` imports `zod`, and the worker type-checks shared modules via the `@shared/*` path alias in the `validate` job (`cd worker && npx tsc --noEmit`) before any deploy step runs. Root deps are installed first (`npm ci`) so shared imports resolve from root `node_modules/`. If you add new npm packages imported at the top level of shared files, they do not need duplication in `worker/package.json` unless the worker uses a worker-local build/runtime path that requires it.
