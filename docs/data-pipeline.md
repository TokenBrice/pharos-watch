# Data Pipeline — Price Enrichment, Integrity Guardrails & Blacklist Sync

## Supply Pipeline

Supply data uses a two-source model with automatic fallback:

- **DefiLlama** — primary source for all stablecoins tracked by DefiLlama's stablecoin API
- **CoinGecko market cap** — used for gold/silver/fiat tokens that DefiLlama doesn't track (e.g. XAUT, PAXG, KAU), and as a **full supply fallback** when the DefiLlama stablecoins API is down (circuit breaker triggers `syncViaCoingeckoFallback()`)

No on-chain overrides, no CMC supply patches, no manual supply corrections.

For tracked supplemental assets that are not in DefiLlama's stablecoin list, the worker still prefers DefiLlama's `coins.llama.fi` price proxy when it exists, but it now falls back to CoinGecko `simple/price` for the current token price when DefiLlama omits that `geckoId`, including protocol-backed commodity tokens that also carry a DefiLlama `protocolSlug`. Gold tokens also fall back to CoinGecko market cap when a configured DefiLlama `protocolSlug` returns TVL history but no usable `mcap`, preventing zero-supply rows or dropped rows for otherwise healthy commodity assets. For `detailProvider === "coingecko"` fiat assets, the preferred admission path is still CoinGecko market cap, but tracked assets can also enter the cached `/api/stablecoins` payload through the existing on-chain total-supply fallback when market-cap data is zero/missing or the tracked asset does not yet have a `geckoId`.

If the supplemental CoinGecko market-cap fetch is temporarily unavailable, `syncStablecoins()` now reuses the last known good cached supply snapshot for those supplemental assets instead of emitting zero-supply rows or dropping them from the payload. That preservation rule now covers all tracked `detailProvider === "coingecko"` assets, including ones that currently rely on on-chain supply fallback without a `geckoId`. When a fresh DefiLlama `coins.llama.fi` price is still available, that fresher price is merged onto the restored supply snapshot.

### Circuit Breakers

Most high-risk external integrations are protected by per-source circuit breakers (`worker/src/lib/circuit-breaker.ts`). State is persisted in the D1 `cache` table under keys like `circuit:defillama-stablecoins`. Bounded low-volume fallbacks such as gold-api.com metal spot quotes, the secondary FX mirror, and ExchangeRate-API daily reference snapshots use explicit retry/timeout/cooldown behavior but are not currently circuit-gated.

- **Open threshold**: 3 consecutive failures
- **Probe interval**: 30 minutes (one request allowed to test recovery)
- **Alerts**: Open/close transition alerts are sent when the caller provides a webhook URL to `recordOutcome(...)`
- **Health impact**: 3 or more open circuits degrade `/api/health`; smaller circuit failures still surface in the circuit list without degrading public health on their own

The source-name registry is maintained in `worker/src/lib/constants.ts` under `CIRCUIT_SOURCE`. Current keys span the main data and delivery lanes, including DefiLlama (`defillama-*` plus `defillama-confirm` for pending depeg confirmation), CoinGecko (`coingecko-prices`, `coingecko-detail-platforms`, `coingecko-mcap`, `coingecko-discovery`, `coingecko-ticker`, `coingecko-confirm`), CoinMarketCap, DexScreener (`dexscreener-prices` for exact token-address lookups and `dexscreener-search` for the last-resort symbol-search path), Jupiter, Pyth, Binance, Kraken, Bitstamp, Coinbase, RedStone, Curve (`curve-onchain`, `curve-oracle`, `curve-liquidity-api`), the protocol-native DEX lanes (Fluid, Balancer, Raydium, Orca, Meteora, PancakeSwap, Aerodrome Slipstream, Velodrome Slipstream), FX (`fx-frankfurter`, `fx-realtime`, `chainlink-feeds`), treasury rates, Etherscan, Alchemy, Bluechip, Anthropic, Twitter, Telegram, TronGrid, and the Kinesis Horizon sources. dRPC is an upstream RPC provider for some blacklist balance reads, but it is not a `CIRCUIT_SOURCE` key today.

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
| CoinGecko ticker | 2 | `worker/src/lib/cg-ticker.ts` | Curated ticker corroboration surface for tracked exchange pairs |
| DefiLlama stablecoins list | 1 | built-in | Independent typed DL-list quote with explicit freshness provenance |
| Pyth Network Hermes | 2 | `worker/src/lib/pyth.ts` | Oracle prices with confidence intervals; coverage is driven by curated `pythFeedId` entries in the stablecoin metadata assets (`shared/data/stablecoins/*.json` via `shared/lib/stablecoins/index.ts`) |
| Binance spot tickers | 2 | `worker/src/lib/cex-tickers.ts` | Direct CEX prices (single batch call) |
| Kraken spot tickers | 2 | `worker/src/lib/cex-tickers.ts` | Alias-safe explicit pair mapping |
| Bitstamp spot tickers | 1 | `worker/src/lib/cex-tickers.ts` | Lower-weight all-tickers corroboration venue |
| Coinbase spot tickers | 2 | `worker/src/lib/cex-tickers.ts` | Direct CEX prices (per-symbol) |
| RedStone oracle | 1 | `worker/src/lib/redstone.ts` | Per-venue breakdown + agreement % for exact-case tracked symbols in `REDSTONE_TRACKED_SYMBOL_ALLOWLIST` |
| Curve on-chain `get_dy()` | 3 | `worker/src/lib/curve-onchain.ts` | StableSwap implied prices |
| Curve oracle (`crvusd-curve`) | 3 | `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` | Additional primary-consensus voice for crvUSD |
| DEX promoted prices | 1 | `worker/src/lib/depeg-helpers.ts` | Aggregate DEX voice when no overlapping promoted protocol-level DEX source exists |
| Promoted protocol-level DEX prices | 2-3 | `worker/src/lib/depeg-helpers.ts` | One aggregated source per protocol; freshness now preserved per source from `price_sources_json` |

Dead or explicitly blocked DEX ids are removed upstream from DEX crawl intake, pool scoring, challenger publication, and `dex_prices` publication. The current runtime blocklist includes Retro variants and Bunni variants, so those venues cannot leak into primary consensus through the DEX bridge or pool challenge.

**Consensus algorithm** (`worker/src/lib/price-consensus.ts`):

- Collects all available source prices for each asset
- Groups sources into agreement clusters within a configurable threshold (default 50 bps for pegged tokens, 500 bps for NAV tokens)
- Picks the largest agreeing cluster; for 2+ source winners, publishes the cluster median and keeps the best member internally for provenance
- If no 2+ cluster forms, picks the best trusted fallback source for publication
- **≥2 sources agree** → `priceConfidence: "high"`
- **Single source only** → `priceConfidence: "single-source"`
- **Sources disagree** → `priceConfidence: "low"`, best trusted fallback source used
- **All sources down** → skip, falls through to enrichment pipeline

Cluster selection breaks ties by size, then total cluster weight, then tighter spread, then peg proximity. The internal selected source inside the winning cluster is chosen by weight, trust tier, reference proximity, and finally source key, but that selected source is no longer forced to be the published high-confidence price.

Each asset gets tagged with `priceConfidence` (high/single-source/low/fallback) and `supplySource` (`defillama`, `coingecko-fallback`, or `onchain-total-supply`). The `onchain-total-supply` path is used for supplemental assets whose circulating supply is derived from an on-chain total-supply probe instead of an upstream market-cap field; preview-only fiat CoinGecko assets can use that path with the existing FX reference for USD normalization while still keeping `price = null`. Solana total-supply fallback now reuses the same shared multi-endpoint probe used by the reserve-adapter path, so supplemental Solana assets do not depend on a narrower RPC list than the rest of the worker.

#### Consensus source provenance
After N-source consensus, each asset receives a `consensusSources: string[]` field listing all source names that returned a valid price for that coin during the sync cycle. For enrichment-pass fallbacks, this is a single-element array. Protocol-redeem overrides replace it with `["protocol-redeem"]`.

### Provider-Specific Normalization

Primary pricing also includes a few source-specific normalization rules that are easy to miss when reading the high-level algorithm:

- **Pyth Hermes feed IDs** are normalized to lowercase with any leading `0x` stripped before matching back to tracked assets. Hermes can return feed IDs in either form.
- **Pyth confidence weighting** now degrades smoothly as confidence intervals widen instead of dropping medium-confidence quotes abruptly.
- **Coinbase** uses uppercased product symbols.
- **RedStone** uses exact-case tracked symbols only. The worker filters requests through `REDSTONE_TRACKED_SYMBOL_ALLOWLIST`, sends them in sequential batches of 10, and retries any batch-dropped symbol individually once.
- **RedStone admission** now requires at least 2 venues and at least 60% venue agreement before the quote can enter primary consensus.
- **Breaker accounting for sparse responses** is data-aware: Pyth and RedStone only count as successful breaker outcomes when they return at least one usable price, not merely a 200 transport response.
- **CEX freshness semantics** are explicit: Binance and Kraken use local-fetch observation times; Bitstamp and Coinbase publish upstream-observed timestamps when the upstream response provides them. Registry metadata records whether each feed is last-trade-only or exposes bid/ask-style spot data.

These rules live in `worker/src/lib/pyth.ts`, `worker/src/lib/redstone.ts`, and the `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` module.

### Authoritative Price Source Registry

After the CG/DL primary pass is applied, `syncStablecoins()` can still replace market-derived prices for specific redeemable assets when a shared authoritative-price provider exposes a better executable mark than secondary-market liquidity.

The registry lives in `worker/src/lib/authoritative-price-sources.ts` and supports two capabilities:

- **Live override** — used by `syncStablecoins()` to replace the current cached price
- **Historical replay** — used by `backfill-depegs.ts` so historical rebuilds can consult the same authoritative provider instead of drifting back to CoinGecko/DefiLlama for those assets

- **Current scope:** `cusd-cap`, `iusd-infinifi`, `usdai-usd-ai`, `usdk-kast`, `xo-exodus`, `usdnr-nerona` (crvUSD was migrated out of the authoritative override registry and into primary consensus as a `curve-oracle` source at weight 3; see [Pricing Pipeline](./pricing-pipeline.md))
- **Source:** either direct Ethereum `eth_call` redemption quotes or tracked-base inheritance when a redeemable wrapper should shadow another tracked asset:
  - Cap `getBurnAmount(address,uint256)` for `cUSD -> USDC`
  - infiniFi `RedeemController.receiptToAsset(uint256)` for `iUSD -> USDC`
  - USDAI inherits the tracked `PYUSD` live price and historical market replay because the base token is treated as an instantly redeemable PYUSD wrapper rather than a free-floating market-priced asset
  - USDK, XO, and USDnr inherit the tracked `wM` live price and historical market replay because Pharos models them as M0 extension units rather than as independently discovered secondary-market price surfaces
- **Reason:** CG/DL can overweight thin secondary-market liquidity for wrapper-style assets whose real executable value is set by direct protocol redemption or by an instantly redeemable base asset
- **Result:** the final cached asset keeps `priceSource = "protocol-redeem"` and `priceConfidence = "high"` when the quote validates against peg bounds

### Enrichment Pipeline

`enrichMissingPrices()` in `worker/src/cron/sync-stablecoins/enrich-prices.ts` now delegates to the ordered fallback-pass manifest in `worker/src/cron/sync-stablecoins/enrich-prices-fallback.ts` for assets still missing prices after primary fetch. The sequence is unchanged, but the orchestration is centralized in one pass list instead of one ad hoc block per provider:

1. **Pass 1:** Canonical tracked contract identity -> DefiLlama coins API, but only quotes that pass peg-aware validation can claim the asset
2. **Pass 1b:** Tracked alternate deployment fallback (tries exact tracked deployment ids via DefiLlama coins API under the same validation gate)
3. **Pass 2:** CoinMarketCap category batch (`cryptocurrency/category?id=604f2753ebccdd50cd175fc1&limit=300&convert=USD`) — prefers per-asset `cmcSlug` matching before symbol fallback, covering all CMC-listed stablecoins in one call (rate-limited to 1 call/hour via D1 cache timestamp, single 10s attempt)
4. **Pass 3:** Jupiter Price API for tracked Solana mints (liquidity-gated and peg-aware; V3 responses are not rejected solely because optional `createdAt` metadata is old)
5. **Pass 4:** DexScreener exact token-address pool lookups when a resolvable chain+address exists. Symbol search is reserved for addressless assets with a unique tracked symbol under the same >$50K liquidity and peg-aware validation gates; capped at 10 total requests per run, no retries, 5s per-request timeout, 45s total pass budget. Under that cap, exact-target assets and larger circulating names are prioritized first.

Note: DexScreener's **batch token API** (`/tokens/v1/{chainId}/{addresses}`) is also used in `syncDexLiquidity()` for DEX-implied price observations. Price enrichment now reuses the same exact-address surface before falling back to search.

**Price validation ordering:** sync-time price validation runs **before** `savePriceCache()` so that unreasonable enriched prices never enter the 24-hour cache. This prevents a single bad API response from poisoning the cache across multiple sync cycles. The worker now distinguishes between authoritative primary validation, fallback enrichment validation, DEX observation validation, and historical-backfill validation instead of using one identical rule for every context. The DefiLlama-down CoinGecko full-supply fallback path now follows the same price guardrails: authoritative live overrides run before enrichment, invalid CoinGecko spot prices are pre-rejected, valid fallback-run prices refresh `price_cache`, cached-price fallback can heal newly missing prices, and pending-depeg confirmation still runs after fallback detection.

## Data Integrity Guardrails

The sync pipeline includes multiple layers of validation to prevent bad data from reaching users:

1. **Structural validation**: DefiLlama response must contain `MIN_VALID_ASSET_COUNT` (50) assets with valid `id`, `name`, `symbol`, and `circulating` fields. Malformed objects are dropped before caching
2. **Price validation ordering**: sync-time validation rejects prices before `savePriceCache()`, not after. Fixed pegs use canonical tracked metadata (`pegType`, `navToken`, `commodityOunces`) during validation, NAV tokens still use broad positive-price checks, and fractional commodity tokens are always scaled by `commodityOunces`
3. **Concurrent cron guard**: `setCacheIfNewer()` uses a compare-and-swap pattern — a slow sync run can't overwrite a newer run's data. Uses `syncStartSec` as CAS guard. Applied to cache-writing crons such as stablecoins, stablecoin-charts, FX rates, bluechip ratings, and USDS status.
4. **Detail JSON validation**: `stablecoin-detail.ts` parses response JSON before caching; skips cache on parse failure
5. **Detail history freshness guard**: `/api/stablecoin/:id` rejects CoinGecko-derived history whose latest point is more than 72 hours old and falls back to D1 `supply_history` instead of caching stale chart data
6. **fetchWithRetry**: Default 15s timeout prevents hanging Workers. `404` is not passed through by default; callers must opt in via `{ passthrough404: true }`. Timeout and passthrough behavior are configurable per call (`{ timeoutMs: N }`, `{ passthroughStatuses: [...] }`)
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
19. **Cron history pruning**: `logCronRun()` no longer prunes old rows inline. The daily `prune-cron-history` job on `0 3 * * *` deletes `cron_runs` rows older than 7 days and `cron_slot_executions` rows older than 14 days.
20. **Security headers**: Worker adds `X-Content-Type-Options: nosniff` to all responses
21. **Admin cache bypass**: cache bypass is declared by each endpoint's `cacheBypass` flag in `shared/lib/api-endpoints/definitions.ts` and exposed through `isCacheBypassPath()`. This covers admin status/API-key/action-log reads plus mutating repair, backfill, and control endpoints; use the shared endpoint registry instead of maintaining a hand-copied route list.
22. **Fail-closed schema guard (stablecoins)**: `syncStablecoins()` validates both main and fallback payloads against `StablecoinListResponseSchema` before `setCacheIfNewer()`. On schema failure, it does **not** overwrite the canonical `stablecoins` cache; instead it writes the rejected payload to `stablecoins:invalid-last`, returns cron `status: "degraded"`, and alerts with validation context (`main`/`fallback`) plus last-known-good cache age
23. **Strict cache payload validation (yield rankings)**: `syncYieldData()` validates the `yield-rankings` cache payload against `YieldRankingsResponseSchema` before `setCache()`. On schema failure, cache write is skipped, `validationFailures` is incremented in cron metadata, and the run returns `status: "degraded"` so status surfaces do not mark it healthy
24. **Fail-closed transformed cache reads**: cache-backed endpoints that must parse and reshape stored JSON now return HTTP `503` when the cached payload is malformed instead of serving a `200` with raw cached bytes. This currently applies to `/api/yield-rankings` and the cached fallback path in `/api/mint-burn-flows`.
25. **Safety snapshot coverage guard (yield)**: `syncYieldData()` treats empty/low-coverage safety snapshots as degraded input. In degraded mode, it still writes a fresh `yield-rankings` cache when the rankings payload is schema-valid and returns `status: "degraded"` so the public API stays available while operators still see the degraded condition. The shared `report_card_cache` used by Chain Health is no longer owned by yield sync; it is refreshed by the DB-only `publish-report-card-cache` job on the quarter-hourly lane after a safe stablecoins cache write, with the daily safety-grade history snapshot as a fallback writer.
26. **Shared stablecoins cache loader**: Consumers that read `stablecoins` (`/api/status`, `/api/peg-summary`, `/api/mint-burn-flows`, `daily-digest`, `compute-dews`, `stability-index`, `backfill-depegs`) use `worker/src/lib/stablecoins-cache.ts` instead of ad-hoc `JSON.parse` logic. The loader supports strict mode (typed error reason) and lenient mode (safe empty defaults + warning reason), with optional legacy array-shape compatibility.
27. **DEWS source-failure accounting**: `computeAndStoreDEWS()` records upstream read failures as structured `sourceFailures` metadata and emits `status: "degraded"` when non-bootstrap-critical inputs fail. Metadata now includes source coverage and validation-failure counts.
28. **Stage-structured stablecoins sync**: `syncStablecoins()` keeps the same output contract but now delegates intake/fallback gating to `worker/src/cron/sync-stablecoins/intake.ts`, shared post-enrichment/cache/depeg steps to `worker/src/cron/sync-stablecoins/post-enrichment.ts`, final run metadata shaping to `worker/src/cron/sync-stablecoins/metadata.ts`, helper contracts to `worker/src/cron/sync-stablecoins/shared.ts`, and normalization/filtering/staleness/supply-history fill to `worker/src/cron/sync-stablecoins/stages.ts`, while `supplemental-assets.ts` owns commodity and CG-only overlay fetches.
29. **DefiLlama ID remap before enrichment/cache writes**: in `syncStablecoins()`, assets are remapped via `REGISTRY_BY_LLAMA_ID` immediately after `normalizeChainCirculating()` and before supplemental merges/`applyTrackedAssetOverrides()`. This ensures downstream maps and keys (`primaryPriceResults.get(asset.id)`, `savePriceCache`, cached-price fallback lookups, supply-history fill inputs, and final stablecoins cache payload) consistently use canonical IDs.
30. **Post-remap canonical dedupe**: if DefiLlama emits duplicate rows that collapse onto the same canonical Pharos ID, `syncStablecoins()` now keeps a single preferred row before caching or enrichment. This prevents duplicate canonical assets from double-counting supply in the final `stablecoins` payload.
31. **Stage-structured yield sync**: `syncYieldData()` now delegates source evaluation and previous-best normalization to `worker/src/cron/yield-sync/evaluation.ts`, rankings/cache publication and persistence helpers to `worker/src/cron/yield-sync/publication.ts`, and batched history preload plus stale/orphan cleanup to `worker/src/cron/yield-sync/history.ts`, keeping resolution logic separate from D1 housekeeping and payload assembly.
32. **Stage-structured mint/burn run-state**: `syncMintBurn()` now delegates disabled-config normalization, lane rotation, and run-state persistence to `worker/src/cron/mint-burn/run-state.ts`; the two 30-minute scheduled handlers already share `worker/src/handlers/scheduled/mint-burn-slot.ts` for slot-specific dispatch.
33. **Stage-structured blacklist EVM ingestion**: `syncBlacklist()` now delegates EVM event fetch/parsing, RPC fallback target selection, and shared explorer URL helpers to `worker/src/cron/blacklist/evm-source.ts` and `worker/src/cron/blacklist/shared.ts`, isolating the Tron path and downstream balance enrichment from the source-ingest stage.
35. **Stablecoins stale-publication guard**: `syncStablecoins()` now emits stage-level progress and compares fresh prices against the previous published cache before writing. If at least 50 comparable prices exist and >=98% are identical, the run returns `status: "degraded"`, records `staleWriteBlocked=true`, and skips the canonical `stablecoins` cache write instead of republishing a stale snapshot as fresh.
36. **Fail-closed PSI dependency handling**: `computeAndStoreStabilityIndex()` no longer treats an unavailable `depeg_events` query as "no active depegs". The run now degrades and skips publication so PSI remains anchored to the last valid sample.
37. **DEWS bootstrap + freshness guard**: `computeAndStoreDEWS()` now uses a dedicated `dews:bootstrap-complete` sentinel to end bootstrap grace after the first successful publication, and stale `dex_liquidity` inputs (>2 hours old) now count as a hard degraded source failure.
38. **Yield publication guardrails**: `syncYieldData()` now degrades on invalid/empty direct DeFiLlama payloads, on total deterministic on-chain failure, and blocks `yield-rankings` cache writes when the new rankings payload shrinks severely versus the last published cache.
39. **DEWS blacklist coverage parity**: `computeAndStoreDEWS()` now derives blacklist-signal coverage from the shared `BLACKLIST_STABLECOINS` set instead of a local hardcoded subset, so `PYUSD` and `USD1` receive the same `blacklist_events`-driven stress input as the other live blacklist-tracked coins.
40. **DEWS thin-peg FX parity**: `computeAndStoreDEWS()` now passes cached `fxFallbackRates` into `derivePegRates()`, matching live depeg detection and peg-summary behavior for thin non-USD peg groups.
41. **Recent-only chart FX repair**: `syncStablecoinCharts()` still corrects obvious recent `totalCirculatingUSD` corruption with the live FX cache, but it no longer rewrites deep historical points with today's FX reference.

## Gold & Silver Spot Prices (gold-api.com)

`syncFxRates()` in `worker/src/cron/sync-fx-rates.ts` fetches gold and silver spot prices from the [gold-api.com](https://gold-api.com) API for commodity-pegged stablecoin peg validation (XAUT, PAXG, KAU, KAG, etc.).

### Why gold-api.com?

The previous source (DefiLlama's `coingecko:gold` / `coingecko:silver` coins API) silently returns empty data, producing garbage peg references and phantom trillion-BPS depegs in backfilled events. gold-api.com requires no API key, and the worker only performs two live spot requests when the 30-minute `sync-fx-rates` cooldown allows upstream work.

### Live Sync (sync-fx-rates.ts)

- **Endpoint**: `GET https://api.gold-api.com/price/XAU` (gold), `GET https://api.gold-api.com/price/XAG` (silver)
- **Request volume**: 2 requests per cooldown-eligible `sync-fx-rates` run (gold + silver), with no repo-level rate limiter; the quarter-hourly trigger is internally gated to upstream work every 30 minutes.
- **Validation**: Same `isValidRate()` bounds + delta checks as FX rates (gold: $500-$10,000/oz, silver: $5-$500/oz, max 20% change from previous value).
- **Fallback**: If the gold-api.com live fetch fails, `sync-fx-rates.ts` now derives a fresh commodity reference from the just-written `stablecoins` cache (peer median across tracked gold tokens; single tracked silver token for silver) before inheriting the previous cached metal rate. This keeps `/api/health` anchored to an actually fresh commodity reference when the anonymous metals endpoint is blocked from Workers.

For fiat FX, Frankfurter remains the preferred ECB-backed source for the business-day set. The worker now targets the maintained hosted endpoint at `https://api.frankfurter.dev/v1`, which replaced the retired `frankfurter.app` host. The existing `fawazahmed0/currency-api` mirror still owns CNH/RUB/UAH/ARS, and it can also backstop the wider fiat set when Frankfurter is temporarily unavailable so the cron can keep publishing live dated FX references instead of immediately dropping to a cached-only run. If both Frankfurter and the existing secondary mirrors are unavailable, `sync-fx-rates.ts` falls through to ExchangeRate-API's daily USD reference snapshot as a tertiary full-set fallback before reusing cached rates. If none of those live fetches respond but the previously persisted daily references are still within their expected publish cadence, the cron carries them forward as a live success instead of incrementing the cached-fallback streak. Even after a cached-fallback run begins, the independent OXR, Chainlink, and metals probes still execute; if they restore fresh full-set fiat coverage, the run exits cached fallback immediately instead of waiting for the primary Frankfurter path to recover first.

### Backfill (backfill-depegs.ts)

- `backfill-depegs.ts` now asks the same authoritative-price registry used by live sync for historical series first. If a coin has an authoritative historical provider and that provider cannot return enough coverage, the backfill preserves existing `source='backfill'` rows instead of rebuilding from a known-weaker fallback source.
- Supported non-USD fiat backfills prefer direct CoinGecko native-fiat history and compare it to the native `1.0` peg before they fall back to USD history plus historical FX.
- Commodity backfill does **not** call a gold-api.com timeseries endpoint.
- Instead, it builds daily GOLD/SILVER peg references from CoinGecko historical prices across tracked commodity tokens (`buildCommodityMedianSeriesFromCg()`), normalized to per-troy-ounce and median-aggregated per day.
- The resulting `{ GOLD: FxTimeSeries[], SILVER: FxTimeSeries[] }` series feeds `buildFxLookup()` for time-varying commodity peg references.
- Fiat backfill uses Frankfurter historical ranges from `api.frankfurter.dev/v1` for ECB-covered currencies and date-addressed `fawazahmed0/currency-api` snapshots for non-ECB currencies such as CNH, RUB, UAH, and ARS.
- Secondary historical FX snapshots are cached in D1 by year (`fx-history-secondary:<year>`) so repeated admin backfills do not re-fetch the same daily files.
- Fallback behavior: if series data is sparse/missing for a timestamp, `buildFxLookup()` falls back to the current peg reference derived from live rates.
- Historical depeg extraction validates each price point against the **direct peg reference for that timestamp** (`historical_backfill` mode). That preserves confirmed catastrophic downside moves without weakening the tighter fallback/DEX filters used for noisy live sources.
- Dry-run backfill audits now accept `startDay` / `endDay` plus optional `contextDays`, replay only that UTC window with the requested context pad, and keep long-history non-USD repairs below `ops-api` timeout limits without changing the full-coin mutation path.

### Budget

The live `/price/` endpoint requires no API key and is called only on cooldown-eligible `sync-fx-rates` runs (2 requests: gold + silver), roughly 2,880 requests/month. Backfills source commodity history from CoinGecko market-chart data (via existing CoinGecko integration), so there is no separate gold-api.com historical-request budget.

## Stability Index (PSI) Computation

`computeAndStoreStabilityIndex()` in `worker/src/cron/stability-index.ts` runs every 30 minutes on the half-hourly lane and computes a composite ecosystem health score (0–100). Formula: `Score = 100 − severity − breadth − stressBreadth + trend`. If the DEWS dependency query is unavailable, the run returns `status: "degraded"` with `fallbackMode: "dews-unavailable"` and `preservedCurrentSample: true`, then skips fresh PSI sample publication instead of treating missing stress breadth as zero. If the active-depeg query is unavailable, the run also fails closed and skips publication instead of treating that outage as an empty depeg set. See [Pharos Stability Index](./stability-index.md) for the full algorithm, calibration examples, and band definitions.

**Band classification:** `BEDROCK` (90–100), `STEADY` (75–89), `TREMOR` (60–74), `FRACTURE` (40–59), `CRISIS` (20–39), `MELTDOWN` (0–19)

**Storage:** 30-minute samples go into `stability_index_samples`; daily averages are aggregated by `snapshotPsiDaily()` into `stability_index`. Both tables store `score`, `band`, `components` (JSON), `input_snapshot` (JSON). Schema definitions are in `worker/migrations/0000_baseline.sql`.

## Pending Depeg Confirmation

For stablecoins with >$1B circulating supply, depeg detection uses a two-phase confirmation system:

1. **Phase 1** (`detect-depegs.ts`): When a coin requires confirmation instead of direct mutation, a record is inserted into `depeg_pending` (schema in `worker/migrations/0000_baseline.sql`). This now covers three cases: `>$1B` supply, low-confidence/cached/stale primary prices, and extreme moves (`abs(bps) >= 5000`)
2. **Phase 2** (`confirm-pending-depegs.ts`): On the next cron cycle, pending records are re-checked. If the depeg persists and a secondary source agrees, a real depeg event is opened. If an **authoritative** primary price recovered, the pending record is deleted

This prevents false positive depeg events for systemically important stablecoins during brief price feed glitches.

## Stale Data Monitoring (Frontend)

The `StaleDataBanner` component (`src/components/stale-data-banner.tsx`) warns users when data from any critical query is degraded or stale. Frontend freshness uses the shared `FRESHNESS_RATIOS` thresholds from `shared/lib/status-thresholds.ts`: fresh through `8x staleTime`, degraded through `12x staleTime`, then stale. When a hook uses `apiFetchWithMeta()`, backend freshness metadata (`_meta.status`, `X-Data-Age`, stale `Warning`) takes precedence over browser fetch time so a fresh client refetch cannot mask stale server data. Each page monitors all TanStack Query hooks that feed its content:

| Page                  | Queries monitored                                   | staleTime constants                                                |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| **Homepage**          | Prices, Peg Data, Liquidity, Report Cards           | `CRON_15MIN`, `CRON_15MIN`, `CRON_30MIN`, `CRON_15MIN`             |
| **Stablecoin detail** | Prices, Peg Data, Liquidity, Report Cards           | `CRON_15MIN`, `CRON_15MIN`, `CRON_30MIN`, `CRON_15MIN`             |
| **Depeg**             | Peg Data, DEWS, Depeg Events                        | `CRON_15MIN`, `CRON_30MIN`, `CRON_15MIN`                           |
| **Compare**           | Prices, Peg Data, Liquidity, Report Cards, Bluechip | `CRON_15MIN`, `CRON_15MIN`, `CRON_30MIN`, `CRON_15MIN`, `CRON_24H` |
| **Safety scores**     | Grades, Prices                                      | `CRON_15MIN`, `CRON_15MIN`                                         |
| **Liquidity**         | Liquidity                                           | `CRON_30MIN`                                                       |
| **Yield**             | Yield Rankings                                      | `CRON_YIELD`                                                       |
| **Flows**             | Mint/Burn Flows                                     | `CRON_MINT_BURN`                                                   |
| **Blacklist**         | Blacklist                                           | `CRON_BLACKLIST`                                                   |
| **Portfolio**         | Grades                                              | `CRON_15MIN`                                                       |

Constants defined in `src/lib/cron-intervals.ts`: `CRON_1MIN` (1 min), `CRON_15MIN` (15 min, stablecoins list), `CRON_30MIN` (30 min, DEX liquidity), `CRON_MINT_BURN` (30 min, mint/burn), `CRON_YIELD` (1 hour, yield rankings), `CRON_1H` (1 hour, generic budget), `CRON_RESERVE_SYNC` (4 hours, live reserves + redemption backstops), `CRON_BLACKLIST` (6 hours), `CRON_24H` (24 hours).

The `staleTime` value for each query matches the cron interval of the backend job that produces the data. TanStack Query's `refetchInterval` is always 2x the `staleTime`. Local browser age becomes degraded after `8x staleTime` and stale after `12x staleTime`, while hook-level freshness metadata can mark data degraded/stale sooner when the worker explicitly reports old cache age or stale-table warnings.

## Blacklist Sync State Semantics

The `blacklist_sync_state.last_block` column has different semantics per chain type:

- **EVM chains**: stores actual block numbers
- **Tron**: stores millisecond timestamps (Tron events are ordered by timestamp, not block number)

This is intentional — do not mix these values across chain types.

## Coverage Discovery

Coverage discovery has two ingestion paths:

- quarter-hourly DefiLlama residual upserts inside `worker/src/cron/sync-stablecoins/intake.ts`
- weekly CoinGecko category scan inside `worker/src/cron/discovery-scan.ts` (Mondays on the `5 8 * * *` trigger)

### Source A: DL Residuals (free)

After `syncStablecoins()` filters DL assets against `REGISTRY_BY_LLAMA_ID`, untracked assets with circulating > $5M are upserted into `discovery_candidates`. Zero extra API calls.

### Source B: CG Stablecoin Category (one call/week, Mondays)

`GET /coins/markets?category=stablecoins&vs_currency=usd&per_page=250&order=market_cap_desc`

Untracked coins with market cap > $5M are upserted. Coins found by both sources get `source: "both"`.

### Circuit Breaker

Uses `CG_DISCOVERY` — independent from `CG_PRICES`, but it still follows the shared circuit-breaker defaults: open after 3 consecutive failures and probe again after 30 minutes.

If the breaker is open when the Monday CoinGecko scan would have run, `discovery-scan` now returns `status: "degraded"` with `reason: "circuit-open-no-attempt"` instead of looking like a clean no-op.

### Candidate Lifecycle

- Upserted whenever the quarter-hourly DefiLlama residual pass or Monday CoinGecko scan sees them, with `last_seen` and `market_cap` updates
- Dismissed candidates don't resurface unless market cap crosses 10x the value at dismissal
- Hard-deleted after 90 days dismissed
