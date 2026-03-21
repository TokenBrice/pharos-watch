# Data Pipeline — Price Enrichment, Integrity Guardrails & Blacklist Sync

## Supply Pipeline

Supply data uses a two-source model with automatic fallback:

- **DefiLlama** — primary source for all stablecoins tracked by DefiLlama's stablecoin API
- **CoinGecko market cap** — used for gold/silver/fiat tokens that DefiLlama doesn't track (e.g. XAUT, PAXG, KAU), and as a **full supply fallback** when the DefiLlama stablecoins API is down (circuit breaker triggers `syncViaCoingeckoFallback()`)

No on-chain overrides, no CMC supply patches, no manual supply corrections.

For tracked supplemental assets that are not in DefiLlama's stablecoin list, the worker still prefers DefiLlama's `coins.llama.fi` price proxy when it exists, but it now falls back to CoinGecko `simple/price` for the current token price when DefiLlama omits that `geckoId`. Gold tokens also fall back to CoinGecko market cap when a configured DefiLlama `protocolSlug` returns TVL history but no usable `mcap`, preventing zero-supply rows for otherwise healthy commodity assets. A positive CoinGecko market cap is still required before CoinGecko-only fiat assets are admitted into the cached `/api/stablecoins` payload.

If the supplemental CoinGecko market-cap fetch is temporarily unavailable, `syncStablecoins()` now reuses the last known good cached supply snapshot for those supplemental assets instead of emitting zero-supply rows or dropping them from the payload. When a fresh DefiLlama `coins.llama.fi` price is still available, that fresher price is merged onto the restored supply snapshot.

### Circuit Breakers

All external data sources are protected by per-source circuit breakers (`worker/src/lib/circuit-breaker.ts`). State is persisted in the D1 `cache` table under keys like `circuit:defillama-stablecoins`.

- **Open threshold**: 3 consecutive failures
- **Probe interval**: 30 minutes (one request allowed to test recovery)
- **Alerts**: Webhook alert fires on open and close transitions
- **Health impact**: Any open circuit triggers `degraded` status on `/api/health`

Sources tracked: `defillama-stablecoins`, `defillama-stablecoin-detail`, `defillama-coins`, `defillama-yields`, `defillama-protocols`, `coingecko-prices`, `coingecko-detail-platforms`, `coingecko-mcap`, `coingecko-discovery`, `coinmarketcap-prices`, `dexscreener-prices`, `pyth-prices`, `binance-prices`, `coinbase-prices`, `redstone-prices`, `curve-onchain`, `curve-liquidity-api`, `fluid-dex-api`, `balancer-api`, `raydium-api`, `orca-api`, `fx-realtime`, `geckoterminal-probe`, `treasury-rates`, `etherscan`, `alchemy`, `twitter-api`, `telegram-api`.

### DefiLlama list vs detail API

The **list** endpoint (`stablecoins.llama.fi/stablecoins`) returns `circulating` values **already in USD** for all peg types — `peggedRUB`, `peggedEUR`, `peggedJPY`, etc. are all denominated in USD despite their key names.

The **detail** endpoint (`stablecoins.llama.fi/stablecoin/{id}`) returns values in **native currency** (e.g. RUB for A7A5, EUR for EURC). The worker's `stablecoin-detail.ts` handler multiplies by `parsed.price` to convert these to USD before caching.

Do **not** multiply list endpoint values by price — that would double-convert and produce wildly wrong numbers (e.g. A7A5: $508M × 0.013 = $6.6M instead of $508M).

## Price Enrichment Pipeline

### Primary Price Fetch

Before the enrichment pipeline runs, `fetchPrimaryPrices()` collects prices from multiple sources and runs N-source weighted consensus to determine the best price for each asset:

**Sources** (each behind its own circuit breaker):

| Source | Weight | Module | Notes |
|--------|--------|--------|-------|
| CoinGecko `/simple/price` | 2 | built-in | Primary market data |
| DefiLlama `coins.llama.fi` | 1 | built-in | Cross-validation |
| Pyth Network Hermes | 2 | `worker/src/lib/pyth.ts` | Oracle prices with confidence intervals; coverage is driven by curated `pythFeedId` entries in the stablecoin metadata assets (`shared/data/stablecoins/*.json` via `shared/lib/stablecoins/index.ts`) |
| Binance spot tickers | 2 | `worker/src/lib/cex-tickers.ts` | Direct CEX prices (single batch call) |
| Coinbase spot tickers | 2 | `worker/src/lib/cex-tickers.ts` | Direct CEX prices (per-symbol) |
| RedStone oracle | 1 | `worker/src/lib/redstone.ts` | Per-venue breakdown + agreement % for exact-case tracked symbols in `REDSTONE_TRACKED_SYMBOL_ALLOWLIST` |
| Curve on-chain `get_dy()` | 3 | `worker/src/lib/curve-onchain.ts` | StableSwap implied prices |
| DEX promoted prices | 1 | `worker/src/lib/depeg-helpers.ts` | Promoted from depeg-only to primary voice |

**Consensus algorithm** (`worker/src/lib/price-consensus.ts`):

- Collects all available source prices for each asset
- Groups sources into agreement clusters within a configurable threshold (default 50 bps for pegged tokens, 500 bps for NAV tokens)
- Picks the largest agreeing cluster; within that cluster, selects the highest-weight source
- If no cluster forms, picks the source closest to the asset's canonical peg reference
- **≥2 sources agree** → `priceConfidence: "high"`
- **Single source only** → `priceConfidence: "single-source"`
- **Sources disagree** → `priceConfidence: "low"`, closest to peg reference used
- **All sources down** → skip, falls through to enrichment pipeline

Each asset gets tagged with `priceConfidence` (high/single-source/low/fallback) and `supplySource` (defillama/coingecko-fallback).

#### Consensus source provenance
After N-source consensus, each asset receives a `consensusSources: string[]` field listing all source names that returned a valid price for that coin during the sync cycle. For enrichment-pass fallbacks, this is a single-element array. Protocol-redeem overrides replace it with `["protocol-redeem"]`.

### Provider-Specific Normalization

Primary pricing also includes a few source-specific normalization rules that are easy to miss when reading the high-level algorithm:

- **Pyth Hermes feed IDs** are normalized to lowercase with any leading `0x` stripped before matching back to tracked assets. Hermes can return feed IDs in either form.
- **Coinbase** uses uppercased product symbols.
- **RedStone** uses exact-case tracked symbols only. The worker filters requests through `REDSTONE_TRACKED_SYMBOL_ALLOWLIST`, sends them in sequential batches of 10, and retries any batch-dropped symbol individually once.
- **Breaker accounting for sparse responses** is data-aware: Pyth and RedStone only count as successful breaker outcomes when they return at least one usable price, not merely a 200 transport response.

These rules live in `worker/src/lib/pyth.ts`, `worker/src/lib/redstone.ts`, and `worker/src/cron/enrich-prices.ts`.

### Authoritative Price Source Registry

After the CG/DL primary pass is applied, `syncStablecoins()` can still replace market-derived prices for specific redeemable assets when a shared authoritative-price provider exposes a better executable mark than secondary-market liquidity.

The registry lives in `worker/src/lib/authoritative-price-sources.ts` and supports two capabilities:

- **Live override** — used by `syncStablecoins()` to replace the current cached price
- **Historical replay** — used by `backfill-depegs.ts` so historical rebuilds can consult the same authoritative provider instead of drifting back to CoinGecko/DefiLlama for those assets

- **Current scope:** `cusd-cap`, `iusd-infinifi` (crvUSD was migrated out of the authoritative override registry and into primary consensus as a `curve-oracle` source at weight 3; see [Pricing Pipeline](./pricing-pipeline.md))
- **Source:** direct Ethereum `eth_call` against protocol redemption paths:
  - Cap `getBurnAmount(address,uint256)` for `cUSD -> USDC`
  - infiniFi `RedeemController.receiptToAsset(uint256)` for `iUSD -> USDC`
- **Reason:** CG/DL can overweight thin secondary-market liquidity for wrapper-style assets whose real executable value is set by direct protocol redemption
- **Result:** the final cached asset keeps `priceSource = "protocol-redeem"` and `priceConfidence = "high"` when the quote validates against peg bounds

### Enrichment Pipeline

`enrichMissingPrices()` in `worker/src/cron/enrich-prices.ts` uses a 5-pass system for assets still missing prices after primary fetch:

1. **Pass 1:** Contract address -> DefiLlama coins API
2. **Pass 1b:** Multi-chain contract address fallback (tries alternate chain addresses via DefiLlama coins API)
3. **Pass 2:** CoinMarketCap category batch (`cryptocurrency/category?id=604f2753ebccdd50cd175fc1&limit=300&convert=USD`) — prefers per-asset `cmcSlug` matching before symbol fallback, covering all CMC-listed stablecoins in one call (rate-limited to 1 call/hour via D1 cache timestamp, single 10s attempt)
4. **Pass 3:** Jupiter Price API for tracked Solana mints (liquidity-gated and peg-aware; V3 responses are not rejected solely because optional `createdAt` metadata is old)
5. **Pass 4:** DexScreener exact token-address pool lookups when a resolvable chain+address exists, falling back to symbol search under the same >$50K liquidity and peg-aware validation gates; capped at 10 total requests per run, no retries, 5s per-request timeout, 45s total pass budget

Note: DexScreener's **batch token API** (`/tokens/v1/{chainId}/{addresses}`) is also used in `syncDexLiquidity()` for DEX-implied price observations. Price enrichment now reuses the same exact-address surface before falling back to search.

**Price validation ordering:** sync-time price validation runs **before** `savePriceCache()` so that unreasonable enriched prices never enter the 24-hour cache. This prevents a single bad API response from poisoning the cache across multiple sync cycles. The worker now distinguishes between authoritative primary validation, fallback enrichment validation, DEX observation validation, and historical-backfill validation instead of using one identical rule for every context. The DefiLlama-down CoinGecko full-supply fallback path now follows the same price guardrails: authoritative live overrides run before enrichment, invalid CoinGecko spot prices are pre-rejected, valid fallback-run prices refresh `price_cache`, cached-price fallback can heal newly missing prices, and pending-depeg confirmation still runs after fallback detection.

## Data Integrity Guardrails

The sync pipeline includes multiple layers of validation to prevent bad data from reaching users:

1. **Structural validation**: DefiLlama response must contain `MIN_VALID_ASSET_COUNT` (50) assets with valid `id`, `name`, `symbol`, and `circulating` fields. Malformed objects are dropped before caching
2. **Price validation ordering**: sync-time validation rejects prices before `savePriceCache()`, not after. Fixed pegs use canonical tracked metadata (`pegType`, `navToken`, `commodityOunces`) during validation, NAV tokens still use broad positive-price checks, and fractional commodity tokens are always scaled by `commodityOunces`
3. **Concurrent cron guard**: `setCacheIfNewer()` uses a compare-and-swap pattern — a slow sync run can't overwrite a newer run's data. Uses `syncStartSec` as CAS guard. Applied to cache-writing crons such as stablecoins, stablecoin-charts, FX rates, bluechip ratings, and USDS status.
4. **Detail JSON validation**: `stablecoin-detail.ts` parses response JSON before caching; skips cache on parse failure
5. **Detail history freshness guard**: `/api/stablecoin/:id` rejects CoinGecko-derived history whose latest point is more than 72 hours old and falls back to D1 `supply_history` instead of caching stale chart data
6. **fetchWithRetry**: Default 15s timeout prevents hanging Workers. Retries on 404 by default (configurable via `{ passthrough404: true }`, `{ timeoutMs: N }`)
7. **Depeg dedup**: `UNIQUE INDEX (stablecoin_id, started_at, source)` prevents duplicate depeg events. Partial index on `ended_at IS NULL` speeds up open-event queries
8. **Depeg interval merge**: `computePegScore()` and `computePegStability()` merge overlapping depeg intervals before summing duration
9. **Depeg direction handling**: If a coin flips from below-peg to above-peg (or vice versa) without recovering, the old event is closed and a new one opened with the correct direction
10. **Peg score consistency**: Both the detail page and peg-summary API use the same tracking-window start helper: `coinTrackingStart(...)`, which applies `max(firstSeen, fourYearsAgo)` when first-seen data exists
11. **Backfill batch safety**: `backfill-depegs.ts` chunks depeg INSERT statements into groups of 100 and executes them sequentially after the per-coin DELETE to stay within D1 batch limits
12. **OFFSET/LIMIT safety**: SQL queries use `LIMIT -1` when offset > 0 but no limit is set (bare OFFSET is invalid SQLite). Values are parameterized, not interpolated
13. **Freshness header**: `/api/stablecoins` returns `X-Data-Age` (seconds since last cache write)
14. **Cloudflare Access admin auth**: Admin endpoints are gated by the `ops-api.pharos.watch` origin lane. When `CF_ACCESS_OPS_API_AUD` is configured, the worker cryptographically verifies the Cloudflare Access JWT (`worker/src/lib/auth.ts`). Timing-safe HMAC comparison (`timingSafeCompare`) is used for the Telegram webhook secret, not for admin endpoints.
15. **Pagination defaults**: `/api/depeg-events` defaults `limit` to 100 and caps at 1000; `/api/blacklist` defaults `limit` to 1000, caps at 1000, and treats `limit=0` as "use default". The blacklist frontend hook (`src/lib/blacklist-api.ts`) hydrates additional pages in 3-request batches with retry/backoff when it needs the full history for charting and summary stats.
16. **Unbounded query guard**: `/api/peg-summary` bounds via the 4-year `started_at >` filter on the depeg_events query
17. **Cache-empty 503**: `/api/peg-summary` returns HTTP 503 (not 200) when cache is empty, signaling data unavailability
18. **Orphan depeg cleanup**: `detectDepegEvents()` closes open depeg events whose stablecoin was not processed during the current run (removed from tracked list, failed validation, etc.)
19. **Cron prune resilience**: `logCronRun()` wraps old-entry pruning in try/catch so prune failures don't crash the cron after successful completion. The error-logging catch block is also protected — if logging the error to D1 fails, the original error is still re-thrown
20. **Security headers**: Worker adds `X-Content-Type-Options: nosniff` to all responses
21. **Admin cache bypass**: mutating/backfill endpoints skip edge response caching (`/api/backfill-depegs`, `/api/backfill-supply-history`, `/api/backfill-cg-prices`, `/api/backfill-stability-index`, `/api/backfill-mint-burn-prices`, `/api/backfill-mint-burn`, `/api/audit-depeg-history`, `/api/backfill-dews`) alongside `/api/health` and `/api/status`
22. **Fail-closed schema guard (stablecoins)**: `syncStablecoins()` validates both main and fallback payloads against `StablecoinListResponseSchema` before `setCacheIfNewer()`. On schema failure, it does **not** overwrite the canonical `stablecoins` cache; instead it writes the rejected payload to `stablecoins:invalid-last`, returns cron `status: "degraded"`, and alerts with validation context (`main`/`fallback`) plus last-known-good cache age
23. **Strict cache payload validation (yield rankings)**: `syncYieldData()` validates the `yield-rankings` cache payload against `YieldRankingsResponseSchema` before `setCache()`. On schema failure, cache write is skipped, `validationFailures` is incremented in cron metadata, and the run returns `status: "degraded"` so status surfaces do not mark it healthy
24. **Fail-closed transformed cache reads**: cache-backed endpoints that must parse and reshape stored JSON now return HTTP `503` when the cached payload is malformed instead of serving a `200` with raw cached bytes. This currently applies to `/api/yield-rankings` and the cached fallback path in `/api/mint-burn-flows`.
25. **Safety snapshot coverage guard (yield)**: `syncYieldData()` treats empty/low-coverage safety snapshots as degraded input. In degraded mode, it still writes a fresh `yield-rankings` cache when the rankings payload is schema-valid, but it skips `report_card_cache` writes and returns `status: "degraded"` so the public API stays available while operators still see the degraded condition
26. **Shared stablecoins cache loader**: Consumers that read `stablecoins` (`/api/status`, `/api/peg-summary`, `/api/mint-burn-flows`, `daily-digest`, `compute-dews`, `stability-index`, `backfill-depegs`) use `worker/src/lib/stablecoins-cache.ts` instead of ad-hoc `JSON.parse` logic. The loader supports strict mode (typed error reason) and lenient mode (safe empty defaults + warning reason), with optional legacy array-shape compatibility.
27. **DEWS source-failure accounting**: `computeAndStoreDEWS()` records upstream read failures as structured `sourceFailures` metadata and emits `status: "degraded"` when non-bootstrap-critical inputs fail. Metadata now includes source coverage and validation-failure counts.
28. **Stage-structured stablecoins sync**: `syncStablecoins()` keeps the same output contract but now delegates intake/fallback gating to `worker/src/cron/sync-stablecoins/intake.ts`, shared post-enrichment/cache/depeg steps to `worker/src/cron/sync-stablecoins/post-enrichment.ts`, final run metadata shaping to `worker/src/cron/sync-stablecoins/metadata.ts`, helper contracts to `worker/src/cron/sync-stablecoins/shared.ts`, and normalization/filtering/staleness/supply-history fill to `worker/src/cron/sync-stablecoins/stages.ts`, while `supplemental-assets.ts` owns commodity and CG-only overlay fetches.
29. **DefiLlama ID remap before enrichment/cache writes**: in `syncStablecoins()`, assets are remapped via `REGISTRY_BY_LLAMA_ID` immediately after `normalizeChainCirculating()` and before supplemental merges/`applyTrackedAssetOverrides()`. This ensures downstream maps and keys (`primaryPriceResults.get(asset.id)`, `savePriceCache`, cached-price fallback lookups, supply-history fill inputs, and final stablecoins cache payload) consistently use canonical IDs.
30. **Post-remap canonical dedupe**: if DefiLlama emits duplicate rows that collapse onto the same canonical Pharos ID, `syncStablecoins()` now keeps a single preferred row before caching or enrichment. This prevents duplicate canonical assets from double-counting supply in the final `stablecoins` payload.
31. **Stage-structured yield sync**: `syncYieldData()` now delegates source evaluation and previous-best normalization to `worker/src/cron/yield-sync/evaluation.ts`, rankings/cache publication and persistence helpers to `worker/src/cron/yield-sync/publication.ts`, and batched history preload plus stale/orphan cleanup to `worker/src/cron/yield-sync/history.ts`, keeping resolution logic separate from D1 housekeeping and payload assembly.
32. **Stage-structured mint/burn run-state**: `syncMintBurn()` now delegates disabled-config normalization, lane rotation, and run-state persistence to `worker/src/cron/mint-burn/run-state.ts`; the two 20-minute scheduled handlers already share `worker/src/handlers/scheduled/mint-burn-slot.ts` for slot-specific dispatch.
33. **Stage-structured blacklist EVM ingestion**: `syncBlacklist()` now delegates EVM event fetch/parsing, RPC fallback target selection, and shared explorer URL helpers to `worker/src/cron/blacklist/{evm-source,shared}.ts`, isolating the Tron path and downstream balance enrichment from the source-ingest stage.
34. **Shared DEX-source normalization**: DEX discovery and DEX liquidity now keep GeckoTerminal parsing in `worker/src/cron/dex-liquidity/geckoterminal-shared.ts`, CoinGecko onchain parsing/classification in `worker/src/cron/dex-liquidity/coingecko-onchain-shared.ts`, CoinGecko tickers aggregation in `worker/src/cron/dex-liquidity/coingecko-tickers-shared.ts`, and GT/CG token-batch observation mapping in `worker/src/cron/dex-liquidity/token-price-observations.ts`.

## Gold & Silver Spot Prices (gold-api.com)

`syncFxRates()` in `worker/src/cron/sync-fx-rates.ts` fetches gold and silver spot prices from the [gold-api.com](https://gold-api.com) API for commodity-pegged stablecoin peg validation (XAUT, PAXG, KAU, KAG, etc.).

### Why gold-api.com?

The previous source (DefiLlama's `coingecko:gold` / `coingecko:silver` coins API) silently returns empty data, producing garbage peg references and phantom trillion-BPS depegs in backfilled events. gold-api.com requires no API key, and the worker only performs two live spot requests per 15-minute sync run.

### Live Sync (sync-fx-rates.ts)

- **Endpoint**: `GET https://api.gold-api.com/price/XAU` (gold), `GET https://api.gold-api.com/price/XAG` (silver)
- **Request volume**: 2 requests per 15-minute cron run (gold + silver), with no repo-level rate limiter.
- **Validation**: Same `isValidRate()` bounds + delta checks as FX rates (gold: $500-$10,000/oz, silver: $5-$500/oz, max 20% change from previous value).
- **Fallback**: If the gold-api.com live fetch fails, previously cached rates are used. The peer median serves as a last-resort reference if no cached rates exist.

For fiat FX, Frankfurter remains the preferred ECB-backed source for the business-day set. The existing `fawazahmed0/currency-api` mirror still owns CNH/RUB/UAH/ARS, and it can also backstop the wider fiat set when Frankfurter is temporarily unavailable so the cron can keep publishing live dated FX references instead of immediately dropping to a cached-only run. If both Frankfurter and the existing secondary mirrors are unavailable, `sync-fx-rates.ts` falls through to ExchangeRate-API's daily USD reference snapshot as a tertiary full-set fallback before reusing cached rates. If none of those live fetches respond but the previously persisted daily references are still within their expected publish cadence, the cron carries them forward as a live success instead of incrementing the cached-fallback streak.

### Backfill (backfill-depegs.ts)

- `backfill-depegs.ts` now asks the same authoritative-price registry used by live sync for historical series first. If a coin has an authoritative historical provider and that provider cannot return enough coverage, the backfill preserves existing `source='backfill'` rows instead of rebuilding from a known-weaker fallback source.
- Commodity backfill does **not** call a gold-api.com timeseries endpoint.
- Instead, it builds daily GOLD/SILVER peg references from CoinGecko historical prices across tracked commodity tokens (`buildCommodityMedianSeriesFromCg()`), normalized to per-troy-ounce and median-aggregated per day.
- The resulting `{ GOLD: FxTimeSeries[], SILVER: FxTimeSeries[] }` series feeds `buildFxLookup()` for time-varying commodity peg references.
- Fiat backfill uses Frankfurter historical ranges for ECB-covered currencies and date-addressed `fawazahmed0/exchange-api` snapshots for non-ECB currencies such as CNH, RUB, UAH, and ARS.
- Secondary historical FX snapshots are cached in D1 by year (`fx-history-secondary:<year>`) so repeated admin backfills do not re-fetch the same daily files.
- Fallback behavior: if series data is sparse/missing for a timestamp, `buildFxLookup()` falls back to the current peg reference derived from live rates.
- Historical depeg extraction validates each price point against the **direct peg reference for that timestamp** (`historical_backfill` mode). That preserves confirmed catastrophic downside moves without weakening the tighter fallback/DEX filters used for noisy live sources.

### Budget

The live `/price/` endpoint requires no API key and is called every 15-minute sync run (2 requests: gold + silver), ~5,760/month. Backfills source commodity history from CoinGecko market-chart data (via existing CoinGecko integration), so there is no separate gold-api.com historical-request budget.

## Stability Index (PSI) Computation

`computeAndStoreStabilityIndex()` in `worker/src/cron/stability-index.ts` runs every 15 minutes and computes a composite ecosystem health score (0–100). Formula: `Score = 100 − severity − breadth − stressBreadth + trend`. If the DEWS dependency query is unavailable, the run stores `dewsUnavailable=true` in `input_snapshot` and returns `status: "degraded"` (stress breadth is defaulted to 0 for continuity). See [Pharos Stability Index](./stability-index.md) for the full algorithm, calibration examples, and band definitions.

**Band classification:** `BEDROCK` (90–100), `STEADY` (75–89), `TREMOR` (60–74), `FRACTURE` (40–59), `CRISIS` (20–39), `MELTDOWN` (0–19)

**Storage:** 15-min samples go into `stability_index_samples` (migration 0026); daily averages are aggregated by `snapshotPsiDaily()` into `stability_index` (migration 0022). Both tables store `score`, `band`, `components` (JSON), `input_snapshot` (JSON).

## Pending Depeg Confirmation

For stablecoins with >$1B circulating supply, depeg detection uses a two-phase confirmation system:

1. **Phase 1** (`detect-depegs.ts`): When a coin requires confirmation instead of direct mutation, a record is inserted into `depeg_pending` (migration 0023 + reason column in migration 0061). This now covers three cases: `>$1B` supply, low-confidence/cached/stale primary prices, and extreme moves (`abs(bps) >= 5000`)
2. **Phase 2** (`confirm-pending-depegs.ts`): On the next cron cycle, pending records are re-checked. If the depeg persists and a secondary source agrees, a real depeg event is opened. If an **authoritative** primary price recovered, the pending record is deleted

This prevents false positive depeg events for systemically important stablecoins during brief price feed glitches.

## Stale Data Monitoring (Frontend)

The `StaleDataBanner` component (`src/components/stale-data-banner.tsx`) warns users when data from any critical query exceeds 2x its `staleTime`. When a hook uses `apiFetchWithMeta()`, backend freshness metadata (`X-Data-Age`, stale `Warning`) takes precedence over browser fetch time so a fresh client refetch cannot mask stale server data. Each page monitors all TanStack Query hooks that feed its content:

| Page                  | Queries monitored                                   | staleTime constants                                                |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| **Homepage**          | Prices, Peg Data, Liquidity, Report Cards           | `CRON_15MIN`, `CRON_15MIN`, `CRON_30MIN`, `CRON_15MIN`             |
| **Stablecoin detail** | Prices, Peg Data, Liquidity, Report Cards           | `CRON_15MIN`, `CRON_15MIN`, `CRON_30MIN`, `CRON_15MIN`             |
| **Depeg**             | Peg Data, DEWS, Depeg Events                        | `CRON_15MIN`, `CRON_15MIN`, `CRON_15MIN`                           |
| **Compare**           | Prices, Peg Data, Liquidity, Report Cards, Bluechip | `CRON_15MIN`, `CRON_15MIN`, `CRON_30MIN`, `CRON_15MIN`, `CRON_24H` |
| **Safety scores**     | Grades, Prices                                      | `CRON_15MIN`, `CRON_15MIN`                                         |
| **Liquidity**         | Liquidity                                           | `CRON_30MIN`                                                       |
| **Yield**             | Yield Rankings                                      | `CRON_30MIN`                                                       |
| **Flows**             | Mint/Burn Flows                                     | `CRON_20MIN`                                                       |
| **Blacklist**         | Blacklist                                           | `CRON_20MIN`                                                       |
| **Portfolio**         | Grades                                              | `CRON_15MIN`                                                       |

Constants defined in `src/lib/cron-intervals.ts`: `CRON_1MIN` (1 min), `CRON_15MIN` (15 min), `CRON_20MIN` (20 min), `CRON_30MIN` (30 min), `CRON_1H` (1 hour), `CRON_24H` (24 hours).

The `staleTime` value for each query matches the cron interval of the backend job that produces the data. TanStack Query's `refetchInterval` is always 2x the `staleTime`. The banner triggers at 2x `staleTime` (i.e., 4x the cron interval), but hook-level freshness metadata can mark data degraded/stale sooner when the worker explicitly reports old cache age or stale-table warnings.

## Blacklist Sync State Semantics

The `blacklist_sync_state.last_block` column has different semantics per chain type:

- **EVM chains**: stores actual block numbers
- **Tron**: stores millisecond timestamps (Tron events are ordered by timestamp, not block number)

This is intentional — do not mix these values across chain types.

## Coverage Discovery

`runDiscoveryScan()` in `worker/src/cron/discovery-scan.ts` runs daily and surfaces stablecoins tracked by CoinGecko or DefiLlama that Pharos doesn't yet monitor.

### Source A: DL Residuals (free)

After `syncStablecoins()` filters DL assets against `REGISTRY_BY_LLAMA_ID`, untracked assets with circulating > $5M are upserted into `discovery_candidates`. Zero extra API calls.

### Source B: CG Stablecoin Category (one call/day)

`GET /coins/markets?category=stablecoins&vs_currency=usd&per_page=250&order=market_cap_desc`

Untracked coins with market cap > $5M are upserted. Coins found by both sources get `source: "both"`.

### Circuit Breaker

Uses `CG_DISCOVERY` — independent from `CG_PRICES`, but it still follows the shared circuit-breaker defaults: open after 3 consecutive failures and probe again after 30 minutes.

### Candidate Lifecycle

- Upserted daily with `last_seen` and `market_cap` updates
- Dismissed candidates don't resurface unless market cap crosses 10x the value at dismissal
- Hard-deleted after 90 days dismissed
