# DEX Liquidity Score & Price Cross-Validation

## Methodology Versioning

- **Current methodology version:** `v5.84`
- **Runtime/version source:** `shared/lib/liquidity-score-version.ts`
- **Public changelog route:** `/methodology/liquidity-score-changelog/`
- **Structured changelog:** `shared/data/methodology-changelogs/liquidity-score/`

## DEX Liquidity Score

`syncDexLiquidity()` in `worker/src/cron/dex-liquidity/orchestrator.ts` runs every 30 minutes (on the `10,40 * * * *` cron schedule) and computes a composite liquidity score (0-100) per stablecoin from 5 components:

Cron result status semantics:

- `ok`: all required source families succeeded and coverage is within normal range.
- `degraded`: one or more critical non-fatal source families failed (for example DeFiLlama yields/protocol coverage), or coverage falls near the guardrail band.
- throw/error: catastrophic source failure (for example DL+Curve hard failure) still aborts the run.

Direct protocol-native API outages are tracked in `failedSources` / `fallbackMode`, but they do not by themselves flip the cron to `degraded` when the published coverage and value guardrails stay healthy. `failedSources` is reserved for providers that return no usable response; a provider with partial errors and usable output records a `*-partial` fallback signal plus source-warning diagnostics instead. That keeps the run-level status tied to material data loss rather than optional-source turbulence.

When DeFiLlama Protocols is unavailable, protocol TVL caps cannot be computed reliably. The cron still computes diagnostics and returns `degraded`, but it preserves the last source-complete public dataset instead of publishing capless secondary-source liquidity. Value guard comparisons use the latest source-complete guard baseline from cron metadata when the persisted `__global__` row came from a source-incomplete run, so a recovered source-complete run does not fail merely because it returns from a capless degraded baseline to the normal capped range.

When DeFiLlama Yields is unavailable, the cron treats value/coverage guard failures as source-incomplete degradation instead of throwing before metadata can be written. The run returns `degraded`, skips persistence, and keeps the last successful public dataset authoritative until a source-complete run recovers.

Run metadata now includes `failedSources`, `fallbackMode` signals, staged-pool merge counters (`stagedPoolsMerged`, `stagedPoolsSkipped`, `stagedPoolsSkippedByExactIdentity`, `stagedPoolsSkippedByUniqueDerivedIdentity`, `stagedPoolsSkippedByOptionalWildcardIdentity`, `stagedPoolsSkippedByAuthoritativeProtocol`), challenger publish counters, persistence skip state, inactive tracked-asset skip counts, publication-generation diagnostics (`generationId`, expected/candidate/current row counts), and detailed `sourceCoverage` values (`currentCoverage`, `previousCoverage`, `minExpectedCoverage`, `nearCoverageGuard`, `currentGlobalTvl`, `previousGlobalTvl`, `minExpectedGlobalTvl`, `valueBaselineSource`, `valueBaselineGlobalTvl`, `ignoredPersistedGlobalTvl`, `nearValueGuard`, `currentTop10CoveredTvl`, `previousTop10CoveredTvl`, `currentTop10GuardTvl`, `previousTop10GuardTvl`, `nearMajorCoverageGuard`, `currentCoverageClasses`, `previousCoverageClasses`, `priceObservationCoins`, `dsFallbackCoins`, `cgTickerFallbackCoins`).

Current-row publication is generation-gated and active-set scoped. The cron may keep historical rows for inactive tracked assets, but the public `dex_liquidity` current table is rewritten from the current active tracked universe plus the `__global__` aggregate only. Candidate rows are written to `dex_liquidity_run_rows`, the expected active row count is validated, and only then is the candidate generation mirrored into the public table and marked `dex_liquidity_publication_generations.state = 'published'`. Readers accept legacy rows with no generation id during rollout, but generation-tagged rows are consumed only when their generation is published.

| Component           | Weight | Source                     | How Computed                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TVL Depth**       | 30%    | DeFiLlama Yields           | Ratio-based log-scale: `35 * log10(depthRatio / 0.0007)` where `depthRatio = effectiveTvl / circulatingUsd`. ~0.5%->30, ~1.5%->47, ~6%->67, ~14%->80, ~25%+->90+. Falls back to `35 * log10(tvl / 700_000)` (parity with ratio formula at a $1B implied reference mcap) when `circulatingUsd` is unavailable. |
| **Volume Activity** | 20%    | DeFiLlama Yields           | Log-scale V/T ratio: `38 * (log10(vtRatio) + 3)`. ~0.1%->0, ~0.3%->18, ~3.5%->59, ~19%->86, ~43%+->100                                                                                                                                                                                                        |
| **Pool Quality**    | 20%    | Curve API + DeFiLlama      | Venue quality retention ratio: `(qualityAdjustedTvl/totalTvlUsd - 0.15) / 0.65 * 100`, rescaled from 15–80% range to 0–100 (see below). The scoring component uses mechanism and balance-health retention; pair quality affects effective TVL and pool stress.                                                |
| **Durability**      | 20%    | DeFiLlama Yields + History | 35% TVL stability, 25% volume consistency, 25% maturity, 15% organic fraction (sqrt curve)                                                                                                                                                                                                                    |
| **Diversity**       | 10%    | DeFiLlama Yields           | Pool count, diminishing returns: min(100, poolCount x 5)                                                                                                                                                                                                                                                      |

Primary scoring inputs are DeFiLlama Yields API (single request for all ~18K pools) + Curve Finance API (per-chain requests for A-factor, balance data, registry IDs, and metapool structure) + Uniswap V3 Subgraph (4 chains) + Aerodrome Subgraph (Base) + eight direct protocol-native fetchers (Fluid, Balancer, Raydium, Orca, Meteora, PancakeSwap V3, Aerodrome Slipstream, Velodrome Slipstream). The initial DeFiLlama and Curve source-loading requests consume JSON bodies through timeout-covered helpers with a 30-second per-attempt budget; the `defillama-protocols` cache stores only the compact slug/category snapshot needed by the yield coverage audit. Raw Curve response trees are released after their lookup maps are built, and each serialized direct-provider result is reduced to tracked pools plus compact counts and exact-key evidence before the next provider starts. Curve API enrichment is scoped to Curve DeFiLlama rows on native-covered Curve API chains, so non-Curve pools that share a token-symbol pair with a Curve pool keep their own mechanism type, balance metadata, and TVL semantics. Secondary discovery still skips Curve pools on native-covered chains to avoid duplicate Curve API coverage, but can retain Curve pools on chains the native Curve API does not cover (for example Plasma) after the same TVL, price sanity, protocol-cap, and dedupe gates as other fallback pools. The scorer prefers direct-API pools over overlapping DeFiLlama pools via a conservative pool-identity model (exact pool id first, derived token-shape match second) before score computation, but only after those direct-API pools pass the shared TVL sanity gates used elsewhere in the pipeline. Direct-source precedence now also requires measured non-zero 24h volume, which lets pool-state-only sources such as Slipstream expand coverage without replacing stronger overlapping DeFiLlama rows when authoritative volume telemetry is absent. After the primary-source merge, the scoring cron reads fresh rows from `dex_pool_staging` (when present), applies freshness confidence decay to staged TVL/volume, skips staged pools already covered by primary sources, and merges the remaining pools before final scoring.

For protocol families that already have a clean protocol-native direct fetch on that chain, staged discovery now also needs authoritative exact-id confirmation before it can contribute liquidity. That means GT/CG/DS rows cannot invent new Balancer, Fluid, Raydium, Orca, Meteora, PancakeSwap, Aerodrome, or Velodrome pools when the native fetch completed without degradation or parser warnings; the guard deliberately fails open when that direct source is degraded, warning-bearing, or unavailable so staged discovery can still act as recovery coverage during an upstream incident.

Dead or explicitly blocked DEX ids are excluded before they can become pool contributions. The live runtime blocklist currently includes Retro variants and Bunni variants, and those blocked venues are also ignored again during retained-pool filtering, challenger publication, and `dex_prices` publication for defense in depth.

### Direct API Data Sources

Protocol-native DEX sources are fetched directly during the scoring cron (`syncDexLiquidity`), after UniV3/Aerodrome enrichment completes. Results are normalized into a shared `DexApiPool` type (`worker/src/lib/dex-api-common.ts`), token-matched against the stablecoin contract registry via canonical `chain + address` first, and only fall back to chain-scoped unique symbols when the upstream token is addressless. Addressed unknown tokens are dropped instead of being reinterpreted by symbol. These matches are deduplicated against DL via exact or uniquely derived pool identities and merged into the pool scoring pipeline before staged and fallback sources. Source family: `direct_api`.

| Protocol                 | API Endpoint                                                                                                                          | Chains                                                                                                                                                           | Pool Types                             |                                    Quality Multipliers | Fields Extracted                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -----------------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fluid**                | `GET https://api.fluid.instadapp.io/v2/:chainId/dexes/stats/tickers` + official DexReservesResolver on Ethereum/Arbitrum/Base/Polygon | Ethereum, Arbitrum, Base, Polygon, BSC, Plasma                                                                                                                   | `fluid-dex`                            |                                                  0.85x | TVL (`liquidity_in_usd`), one-sided USD volume (normalized from `base_volume` / `target_volume`), price (`last_price`), balances (collateral + debt real reserves), fee (`getPoolFee`)    |
| **Balancer**             | `POST https://api-v3.balancer.fi/` (GraphQL `poolGetPools` + `aggregatorPools` amp sweep)                                             | 16 mapped chains (Ethereum, Arbitrum, Base, Polygon, Optimism, Gnosis, Avalanche, Sonic, Fantom, Fraxtal, Mode, Polygon zkEVM, Plasma, Monad, HyperEVM, X Layer) | `balancer-stable`, `balancer-weighted` |                            stable 0.85x, weighted 0.4x | Exact pool address (`address`), TVL (`totalLiquidity`), volume (`volume24h`), price (derived from `balanceUSD / balance`), balances (`balance`, `balanceUSD`, `weight`), rate-provider rates (`priceRate`), fees (`swapFee`), stable-math amp (`aggregatorPools.amp`, hook-free reviewed pools only) |
| **Raydium**              | `GET https://api-v3.raydium.io/pools/info/list`                                                                                       | Solana                                                                                                                                                           | `raydium-clmm`, `raydium-amm`          |                                   clmm 0.85x, amm 0.4x | TVL (`tvl`), volume (`day.volume`), price (`price`), balances (`mintAmountA/B`), fees (`feeRate`)                                                                                         |
| **Orca**                 | `GET https://api.orca.so/v2/solana/pools`                                                                                             | Solana                                                                                                                                                           | `orca-whirlpool`                       |                                                  0.85x | TVL (`tvlUsdc`), volume (`stats.24h.volume`), price (`price`), balances (`tokenBalanceA/B`), fees (`feeRate`)                                                                             |
| **Meteora**              | `GET https://dlmm.datapi.meteora.ag/pools`                                                                                            | Solana                                                                                                                                                           | `meteora-dlmm`                         |                                                  0.85x | TVL (`tvl`), volume (`volume.24h`), price (`current_price`), balances (`token_x_amount` / `token_y_amount`), fees (`base_fee_pct + dynamic_fee_pct`)                                      |
| **PancakeSwap V3**       | Graph gateway -> official PancakeSwap subgraphs                                                                                       | BSC, Ethereum, Base                                                                                                                                              | `pancakeswap-v3-*`                     | 1bp 1.1x, 5bp 0.85x, 25bp 0.7x, 30bp 0.4x, 100bp 0.25x | TVL (`totalValueLockedUSD`), trailing 24h volume (sum of bounded `poolHourDatas.volumeUSD`), price (`token0Price`), balances (`totalValueLockedToken0/1`), fees (`feeTier`)               |
| **Aerodrome Slipstream** | Base Sugar view contract (`all()` + `tokens()`) via RPC                                                                               | Base                                                                                                                                                             | `aerodrome-slipstream-*`               |                        1bp 1.1x, 5bp 0.85x, 30bp+ 0.4x | TVL (reserve-derived from tracked token prices), price (sqrt_ratio Q64.96 via `sqrtRatioToSpotPrice`), balances (`reserve0/1`), fees (`pool_fee`)                                         |
| **Velodrome Slipstream** | Optimism Sugar view contract (`all()` + `tokens()`) via RPC                                                                           | Optimism                                                                                                                                                         | `velodrome-slipstream-*`               |                        1bp 1.1x, 5bp 0.85x, 30bp+ 0.4x | TVL (reserve-derived from tracked token prices), price (sqrt_ratio Q64.96 via `sqrtRatioToSpotPrice`), balances (`reserve0/1`), fees (`pool_fee`)                                         |

All direct fetchers now surface partial/total upstream failure explicitly to the cron, use circuit breakers (`CIRCUIT_SOURCE.FLUID_DEX_API`, `BALANCER_API`, `RAYDIUM_API`, `ORCA_API`, `METEORA_API`, `PANCAKESWAP_API`, `AERODROME_SLIPSTREAM_API`, `VELODROME_SLIPSTREAM_API`), and apply min TVL thresholds ($10K for liquidity inclusion, $50K for price observations). Runtime parsing no longer learns new token ownership from DeFiLlama or subgraph symbol strings, so the canonical tracked-token registry is immutable during a run. When both DL and a direct API cover the same physical pool, the direct API data is preferred only when the identity match is exact or uniquely derived and the direct source carries measured non-zero 24h volume; ambiguous same-pair pools remain separate instead of being collapsed. The dedupe index now also reserves every authoritative direct-API exact pool id for later staged/fallback exact-match checks even when that direct row falls below the scoring floor, so discovery sources cannot re-add the same address with incompatible TVL semantics. Direct-API pools now use a conservative default maturity of `30` days unless the source provides stronger evidence. PancakeSwap subgraph fetches also parse the raw body before surfacing a failure so HTML/plaintext upstream regressions are recorded as explicit `invalid-json` diagnostics instead of opaque parser crashes, and PancakeSwap volume now sums a bounded trailing window of official `poolHourDatas` rows instead of reading the latest UTC day bucket.

PancakeSwap and Orca pagination now refresh the highest-TVL head on every run and continue a bounded tail from `dex_source_pagination_state`. PancakeSwap keeps an independent offset cursor for BSC, Ethereum, and Base; Orca keeps its opaque API cursor. Completing a tail cycle resets its cursor to the first tail page while preserving the newly refreshed head. Orca retains the attempted far-tail cursor across transport, rate-limit, 5xx, and malformed-response failures; it restarts from the refreshed head only when the API explicitly rejects the cursor with 400/404. Healthy budget truncation is represented as `pagination.state = "partial"` with the next cursor instead of an opaque fetch error. Cursor writes return a bounded persistence class in source/run metadata: `write-failed` degrades the source and leaves the stored cursor retryable, while `missing-table` remains an explicit non-degrading rollout-compatibility state. Rejection/error samples are bounded before entering cron metadata.

Balancer direct fetches now take exact identity from the API's `address` field. The GraphQL `id` remains the 32-byte vault pool id, but exact-address dedupe and authoritative staged-pool confirmation both key off the true pool address.

During the scoring cron, UniV3/Aerodrome subgraph enrichment completes before the direct API stage begins so those fetch families do not overlap inside Cloudflare's per-trigger connection budget. Fluid resolver enrichment and Slipstream Sugar reads use the scheduled runtime's configured `chainRpcs` map (Alchemy/dRPC when configured) instead of relying on module-level public RPC defaults.

Balancer, Raydium, Orca, and resolver-backed Fluid pools now preserve richer metadata through `top_pools_json`: measured `balanceRatio`, per-token `balanceDetails`, and normalized `feeTier` badges in basis points. Balancer weighted pools compare actual USD composition versus target token weights before deriving balance health; Raydium and Orca derive inventory balance from token balances plus per-token USD prices; Fluid derives inventory from the official DexReservesResolver by summing collateral and debt real reserves per token. Fluid pools on chains without that resolver deployment, or on any chain where token decimals cannot be resolved safely, fall back to neutral balance.

Large retained pools must clear the minimum 24-hour volume floor even when a source marks volume as unmeasured; the unmeasured flag remains diagnostic and no longer bypasses the anti-poisoning guard. After pool filtering and protocol-level TVL caps are applied, the scorer rebuilds every aggregate (`total_tvl_usd`, `total_volume_24h_usd`, `total_volume_7d_usd`, `effective_tvl_usd`, balance/organic/stress weights, protocol/chain breakdowns, and source-family mix) from the retained pool set before computing the final score. Filtered or capped pools cannot continue influencing the score through stale pre-filter aggregates. The top-asset recovery guard keeps raw top-10 covered TVL visible but discounts previous rows whose raw TVL was dominated by near-zero effective liquidity before applying near/hard guard thresholds. The strict cap now targets the inflation-prone secondary discovery families (`cg_onchain`, `gecko_terminal`, `dexscreener`, `cg_tickers`) rather than clipping `direct_api` pools by default, so legitimate protocol-native liquidity is less likely to be suppressed by stale DefiLlama protocol ceilings.

`dex_pool_staging` is the handoff point for discovery-refresh rows (CoinGecko Onchain, GeckoTerminal, DexScreener, CoinGecko Tickers). The scoring cron consumes staged rows refreshed within the last 24 hours and gracefully falls back to primary-only scoring when the staging table is absent or empty. It also retains bounded direct fallback probes after the primary/staged merge: DexScreener can still repair zero-pool, no-price, or materially weak partial on-chain coverage, while CoinGecko ticker/orderbook fallback is limited to assets with absent, no-price, or tiny DEX coverage so centralized synthetic books do not churn already-covered DEX assets.

Staged rows with non-finite, negative, or impossible pool TVL above the discovery sanity ceiling are rejected before persistence and skipped again at scoring merge time. Secondary-source rows with a measured tracked-token price must also pass the same peg-aware DEX observation sanity gate used for price publication before their TVL can be staged or merged. Carbon DeFi chain-suffixed provider ids also normalize to the DefiLlama `carbon-defi` protocol cap. These gates prevent one malformed secondary-source reserve or token-price field from poisoning coin-level TVL, global TVL, or CPU-heavy downstream diagnostics.

Shared source-specific helpers now own the duplicate discovery/liquidity normalization rules:

- GeckoTerminal request construction, bounded pagination, pool parsing, and pool-type normalization: `worker/src/cron/dex-liquidity/geckoterminal-shared.ts`
- CoinGecko onchain parsing, fee-bucket classification, balance-ratio inference, and locked-liquidity parsing: `worker/src/cron/dex-liquidity/coingecko-onchain-shared.ts`
- CoinGecko tickers filtering, exchange aggregation, synthetic orderbook TVL, and price-observation gating: `worker/src/cron/dex-liquidity/coingecko-tickers-shared.ts`

Data sources are split across two cron families: scoring remains on `10,40 * * * *` (every 30 min), while discovery sources (CoinGecko Onchain, GeckoTerminal, DexScreener, CoinGecko Tickers) now run only on `6 */2 * * *` (every 2 hours) and write to `dex_pool_staging` for later merge.

See the [Discovery Cron](#discovery-cron) section below for the full discovery pipeline architecture.

### Quality Multipliers (v2)

| Pool Type                  | Multiplier | Detection                                                   |
| -------------------------- | ---------- | ----------------------------------------------------------- |
| Curve StableSwap A>=500    | 1.0x       | `registryId` not containing `crypto` + A>=500               |
| Curve StableSwap A<500     | 0.85x      | `registryId` not containing `crypto` + A<500                |
| Curve CryptoSwap           | 0.5x       | `registryId` containing `crypto`/`twocrypto`/`tricrypto`    |
| Uniswap V3 1bp             | 1.1x       | fee tier <= 100                                             |
| Uniswap V3 5bp             | 0.85x      | fee tier <= 500                                             |
| Uniswap V3 30bp+           | 0.4x       | fee tier > 500                                              |
| Fluid DEX                  | 0.85x      | project contains `fluid`                                    |
| Aerodrome Stable (sAMM)    | 0.85x      | project contains `aerodrome` + `isStable` flag              |
| Aerodrome Volatile (vAMM)  | 0.4x       | project contains `aerodrome`, non-stable                    |
| Balancer Stable            | 0.85x      | project contains `balancer` + stable pattern                |
| Balancer Weighted          | 0.4x       | project contains `balancer`, non-stable                     |
| Raydium CLMM               | 0.85x      | concentrated liquidity (direct API or DL)                   |
| Raydium AMM                | 0.4x       | standard AMM, wider spreads                                 |
| Orca Whirlpool             | 0.85x      | concentrated liquidity (direct API or DL)                   |
| Meteora DLMM               | 0.85x      | protocol contains `meteora`                                 |
| PancakeSwap V3 1bp         | 1.1x       | protocol contains `pancakeswap` + fee tier <= 1 bp          |
| PancakeSwap V3 5bp         | 0.85x      | protocol contains `pancakeswap` + fee tier <= 5 bp          |
| PancakeSwap V3 25bp        | 0.7x       | protocol contains `pancakeswap` + fee tier <= 25 bp         |
| PancakeSwap V3 30bp        | 0.4x       | protocol contains `pancakeswap` + fee tier <= 30 bp         |
| PancakeSwap V3 100bp       | 0.25x      | protocol contains `pancakeswap` + fee tier > 30 bp          |
| Aerodrome Slipstream 1bp   | 1.1x       | protocol contains `aerodrome-slipstream` + fee tier <= 1 bp |
| Aerodrome Slipstream 5bp   | 0.85x      | protocol contains `aerodrome-slipstream` + fee tier <= 5 bp |
| Aerodrome Slipstream 30bp+ | 0.4x       | protocol contains `aerodrome-slipstream` + fee tier > 5 bp  |
| Velodrome Slipstream 1bp   | 1.1x       | protocol contains `velodrome-slipstream` + fee tier <= 1 bp |
| Velodrome Slipstream 5bp   | 0.85x      | protocol contains `velodrome-slipstream` + fee tier <= 5 bp |
| Velodrome Slipstream 30bp+ | 0.4x       | protocol contains `velodrome-slipstream` + fee tier > 5 bp  |
| Generic AMM                | 0.3x       | fallback                                                    |
| Orderbook                  | 0.6x       | CoinGecko tickers fallback (centralized exchange, no AMM)   |

### Pool Quality Adjustments

- **Balance health**: Continuous `Math.pow(balanceRatio, 1.5)` instead of binary threshold
- **Pair quality**: Co-token scored using Pharos governance classification (CeFi->1.0, DeFi->0.9, CeFi-Dep->0.8) + static map for volatile assets (WETH->0.65, WBTC->0.6, unknown->0.3). Known quote aliases such as `USD₮0`, `USDT0`, `aUSDC`, `aUSDT`, `USDbC`, and `.e` bridged variants are normalized to canonical symbols before scoring. Composite Curve LP aliases such as `3Crv` and `FRAXBP` inherit the best score from their underlying stablecoin basket. Multi-asset pools use best co-token score
- **MetaPool TVL dedup**: Uses `usdTotalExcludingBasePool` to prevent double-counting base pool liquidity across ~322 Curve metapools
- **Effective TVL**: `poolTvl x mechanismMultiplier x balanceHealth x pairQuality`, summed across all pools

For direct APIs, balance health is no longer uniformly neutral. Balancer, Raydium, Orca, and resolver-backed Fluid pools now contribute measured balance ratios when their APIs provide enough token-balance and pricing context. Fluid pools still default to `1.0` balance when the official resolver is unavailable or token decimals cannot be resolved safely.

### Data Quality Filters

- `isBroken === true` Curve pools: skipped
- Dead/rugged/deprecated protocols: excluded from `dexProjects` set and the explicit runtime blocklist (currently including Retro and Bunni variants)
- `exposure === "single"` pools (lending deposits, not DEX liquidity): skipped
- CryptoSwap pools: correctly classified via `registryId`

### CoinGecko Onchain Integration

CoinGecko Onchain is now a discovery-stage source rather than a direct scoring-cron fetch. Its outputs are written into `dex_pool_staging` and later merged by `syncDexLiquidity()` if the staged rows are fresh. Pool parsing, fee-tier classification, balance-ratio inference, and locked-liquidity parsing are shared between discovery and liquidity through `worker/src/cron/dex-liquidity/coingecko-onchain-shared.ts`. CoinGecko Onchain and GeckoTerminal token crawls now read multiple bounded pages (`3 x 20` rows max) before declaring discovery exhausted, which reduces false partial-coverage outcomes on fragmented assets.

Chain resolution is registry-backed in `worker/src/lib/chain-registry.ts`: the worker keeps one canonical internal chain id per deployment (`bob`, `worldchain`, `plasma`, etc.) and maps it to provider-specific network slugs (`bob-network`, `world-chain`, `plasma`, ...). When `COINGECKO_API_KEY` is configured, pool discovery uses CoinGecko `/onchain` for chains with a `coingecko` mapping and still runs GeckoTerminal for chains that only have a `geckoTerminal` mapping. This avoids the old all-or-nothing mode switch where enabling CoinGecko could silently drop GT-only chains.

| Feature          | GeckoTerminal (fallback)                                                                                                                | CoinGecko Onchain (paid)                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Rate limit       | 30 req/min                                                                                                                              | ~240 req/min                                                                                                                        |
| Chain coverage   | Registry-backed GT network slugs for canonical chains, including slug aliases such as `bob-network`, `manta-pacific`, and `world-chain` | Registry-backed CG network ids for chains with explicit CG support; GT-only chains still flow through GeckoTerminal in the same run |
| Balance data     | Not available (defaults to 1.0)                                                                                                         | Approximated from token prices                                                                                                      |
| Fee tier         | DEX-prefix lookup only                                                                                                                  | `pool_fee_percentage` field                                                                                                         |
| Locked liquidity | Not available                                                                                                                           | `locked_liquidity_percentage` field                                                                                                 |

The CG integration extracts three signals unavailable from GeckoTerminal:

1. **Balance ratio approximation**: Computed from `base_token_price_usd`/`quote_token_price_usd` for stable pairs. Feeds into `balanceHealth`, `balanceRatioWeightedSum`, and pool stress.
2. **Fee tier classification**: `pool_fee_percentage` enables proper quality multipliers for non-Uniswap concentrated liquidity pools (PancakeSwap V3, SushiSwap V3, etc.).
3. **Locked liquidity**: Persisted for pool-quality context and API observability, but not currently included in the live durability score.

### DexScreener Fallback

DexScreener runs in two complementary paths:

1. **Discovery cron** (`sync-dex-discovery`): Populates `dex_pool_staging` with pool data for later merge during scoring.
2. **Scoring-cron fallback** (`sync-dex-liquidity`, step 5b): After primary sources and staged-pool merge, any tracked stablecoin that still has zero pools, no usable DEX price observation, or materially weak partial coverage is queried directly via DexScreener's `/tokens/v1/{chainId}/{address}` endpoint. Weak coverage currently keys off retained-pool guardrails for pool count, protocol breadth, TVL, and measured-balance share. This covers 30+ chains including Solana, Berachain, Monad, MegaETH, Plume, and other exotic chains. The fallback shares a 2-minute time budget with the CG tickers fallback and records one aggregate outcome under `dexscreener-liquidity` per run instead of one breaker update per token request.

DexScreener token-pool requests use browser-compatible API headers because the public endpoint sits behind provider-side Cloudflare/WAF rules. Failed responses preserve final HTTP status, content type, and a bounded body snippet in pricing diagnostics so production can distinguish rate limits or challenges from empty valid token-pool results.

The discovery cron is intentionally best-effort rather than all-or-nothing. It runs with a 12-minute shared wall-clock budget, a 25-second per-coin cap, and short no-retry request timeouts for late-stage fallback sources so partial runs return `status="degraded"` with `budgetExhausted=true` instead of drifting into a hard timeout and leaving stale in-flight telemetry behind. Tier-2 and tier-3 candidates are sharded by stablecoin id across their cadence windows, so the cron refreshes each lower-priority cohort on schedule without batching every eligible asset into one oversized run.

Address matching uses both canonical `contracts` and optional `tradedContracts` metadata. `tradedContracts` is reserved for wrapper / secondary-market token addresses that are meaningfully used for DEX discovery even when issuer metadata points to a different canonical deployment.

Quality gates:

- Pool TVL must exceed $1,000
- Pool must have 24h volume > 0 or TVL > $10,000
- Pools are accepted when the tracked token is either the base or quote asset
- Quote-side pools still require an explicit tracked-token USD derivation before they can contribute a DEX price observation
- Pools already discovered by the primary pipeline are deduplicated by exact or uniquely derived pool identity
- Generic quality multiplier (0.3x) unless the DEX ID matches a known protocol (same `GT_DEX_QUALITY` lookup)

DexScreener pools are merged through the shared secondary-pool contribution path — no balance ratio data, neutral organic fraction default (0.5).

### CoinGecko Tickers Fallback (Orderbook DEXes)

CoinGecko Tickers runs in two complementary paths:

1. **Discovery cron** (`sync-dex-discovery`): Synthetic orderbook pools enter scoring through `dex_pool_staging`.
2. **Scoring-cron fallback** (`sync-dex-liquidity`, step 5b): After DexScreener fallback, a coin with a `geckoId` is queried via CoinGecko's `/coins/{id}/tickers` endpoint with `depth=true` only when retained DEX coverage is absent, lacks a usable price observation, or remains genuinely tiny. This covers coins whose primary liquidity lives on orderbook exchanges not tracked by DeFiLlama or DexScreener (e.g. KAG and KAU on Kinesis Exchange) without adding time-budget-dependent synthetic books to already-covered DEX assets. Shares the 2-minute fallback time budget.

Ticker filtering: `!is_stale && !is_anomaly`, finite `converted_last.usd`, finite `converted_volume.usd >= 1,000`, and a non-empty exchange identifier. Only USD-equivalent quote assets are accepted (USD, USDT, USDC, DAI, C1USD, etc.). CoinGecko deprecated `trust_score` on March 3, 2026, so the fallback no longer depends on that field. Filtering, exchange aggregation, synthetic TVL construction, and orderbook price-observation gating are shared between discovery and liquidity through `worker/src/cron/dex-liquidity/coingecko-tickers-shared.ts`.

Per-exchange aggregation: all valid tickers from the same exchange are combined into one synthetic pool entry:

- `syntheticTvl = totalVolume × 3` when CoinGecko depth fields are unavailable. When `depth=true` returns 2% downside orderbook depth (`cost_to_move_down_usd`), Pharos uses `min(totalVolume × 3, cost_to_move_down_usd)` so measured downside depth can reduce overstated volume-derived books without inflating scores on day one.
- `poolType: "orderbook"`, quality multiplier 0.6x
- `priceUsd = volume-weighted average` across accepted tickers on that exchange
- Maturity defaults to 30 days unless later refreshed through repeated discovery

The 0.6x quality multiplier reflects that orderbook exchanges are legitimate but centralized (not fully on-chain), placing them between Aerodrome volatile (0.4x) and Balancer stable (0.85x).

These rows are explicitly marked synthetic in persisted pool metadata. Depth-informed rows also preserve the 2% downside/upside orderbook depth and `orderbookTvlBasis` metadata for top-pool diagnostics. They no longer present themselves as faux `USDC` pools; the quote side is labeled as an orderbook USD proxy so downstream consumers can distinguish centralized synthetic liquidity from measured AMM inventory.

Uses the shared secondary-pool contribution path used by GT/CG/staged fallback merges, so aggregate math and metadata propagation stay aligned across sources.

### Direct CEX Orderbook Telemetry

The DEX liquidity cron also reads a tiny non-scoring direct orderbook canary for USDC and USDT from public Binance, Coinbase Exchange, and Kraken L2 endpoints. This telemetry computes 2% downside/upside depth, mid price, spread bps, and venue counts, then publishes only a compact summary in cron metadata under `sourceCoverage.directCexOrderbookDepth`.

This direct CEX lane is deliberately diagnostic for now:

- It does not change `liquidity_score`
- It does not create `dex_liquidity` pool rows
- It is bounded to major stablecoins and a few high-quality venues
- Failures are non-fatal and only mark the direct CEX telemetry source as failed

The lane exists to compare direct venue depth against CoinGecko depth-informed orderbook rows before any future scoring integration.

### Pool Stress Index (0-100)

Per-pool stress metric: `35x(1-balanceRatio) + 25x(1-organicFraction) + 20xImmaturityPenalty + 20x(1-pairQuality)`. TVL-weighted average stored as `avg_pool_stress`.

### Durability Score (0-100)

Per-stablecoin durability metric combining: TVL stability from 30-day CV (35%), volume consistency from 30-day CV (25%), oldest pool maturity (25%), and organic fee fraction with sqrt curve (15%). Locked liquidity removed — no reliable data source. Stored as `durability_score`.

#### Pool Quality Formula

Pool Quality measures the venue quality retention ratio: the fraction of total TVL that survives after applying mechanism and balance-health multipliers.

`poolQuality = min(100, max(0, (qualityAdjustedTvl / totalTvlUsd - 0.15) / 0.65 * 100))`

Where `qualityAdjustedTvl` applies mechanism and balance-health multipliers to raw TVL, and `totalTvlUsd` is the pre-adjustment sum across all pools. Pair quality is already reflected upstream in `effectiveTvl` and the pool-stress diagnostics, but it is not part of this retention-ratio component. The linear rescaling maps the 15–80% retention range to 0–100, so a pool set retaining 15% or less of its raw TVL after quality adjustment scores 0, and one retaining 80% or more scores 100.

#### Durability Sub-Component Weights

- **35%** TVL stability — `1 - min(1, CV)` over 30-day snapshots (CV = coefficient of variation)
- **25%** Volume consistency — same CV formula over 30-day volume snapshots
- **25%** Maturity — oldest pool age, capped at 365 days: `min(1, oldestDays / 365) × 100`
- **15%** Organic fraction — `sqrt(organicFraction) × 100` (diminishing returns past 50%; 25% organic → 50 score, 50% → 71 score, 100% → 100 score)

### Pool Identity (`poolId`)

Each `PoolEntry` carries a chain-scoped `poolId`. Chain aliases first resolve to the canonical Pharos chain ID; EVM addresses are lowercased, while case-sensitive non-EVM pool IDs and token mints retain their original case. Trustworthy on-chain/native IDs use `chain:poolId`; identity-poor retained rows use a fallback fingerprint over canonical chain, normalized protocol, and sorted chain-scoped token IDs. This identifies a physical pool across stablecoins without collapsing case-distinct Solana pools. A single pool (for example USDC/USDT on Raydium) may still appear under multiple stablecoin entries, and the scoped identity enables safe global deduplication.

### Cross-Source Deduplication

DeFiLlama's yields API often uses opaque UUIDs as pool identifiers (for example `6b6de6c7-...`), while CoinGecko/GeckoTerminal/DexScreener and direct protocol APIs usually expose on-chain pool addresses. The scorer therefore tracks a **pool identity** with two layers:

- `exactPoolKey`: `chain:poolId` when the id is trustworthy (EVM address, Uniswap V4 pool id, Solana-style address, or orderbook-native id)
- `derivedMatchKey`: `chain + normalized protocol + sorted tokens + pool shape + fee bucket + stable/volatile flag`

Dedup rules are intentionally conservative:

- exact ids always win when both sides expose the same real pool id
- derived matches only deduplicate when the match is unique on both sides
- direct-API vs DeFiLlama precedence also allows a narrowly scoped optional-metadata wildcard when the incoming identity-poor side is missing fee-tier and/or stable-flag metadata but still matches on chain, normalized protocol, token set, and pool-shape family
- staged discovery can use that same optional-metadata wildcard only when the staged incoming bucket and the known primary bucket are both unique, which lets one exact pool-id discovery row collapse against one DeFiLlama UUID row without merging parallel same-pair pools
- Balancer stablecoin pools get one extra fallback: if DeFiLlama tags a `balancer-v3` pool as stablecoin-only but omits the stable subtype from its project metadata, the identity builder treats it as a stable-pair candidate for dedupe so it can still collapse against the exact Balancer direct-API pool instead of surviving as a faux weighted duplicate
- ambiguous same-pair pools stay separate, so legitimate parallel pools are not collapsed

Token and pool identity share the same chain-aware canonicalizer. Addressed tokens must resolve by canonical `chain + address`; symbol fallback is allowed only for addressless tokens with one unique match on that chain. Route IDs, output asset keys, and correlation keys also retain the canonical chain-scoped pool/token identity, preventing the same address text on two chains, or case-distinct non-EVM identifiers, from being treated as one route or failure domain.

That wildcard path is intentionally not used for scoring-cron fallback-source merges, and staged-pool use is limited to unique incoming and known buckets. `/status` exposes the split directly via `stagedPoolsSkippedByExactIdentity`, `stagedPoolsSkippedByUniqueDerivedIdentity`, and `stagedPoolsSkippedByOptionalWildcardIdentity`.

### Coverage Confidence

Every scored row now persists:

- `coverage_class`: `primary`, `mixed`, `fallback`, `legacy`, or `unobserved`
- `coverage_confidence`: current trust score for the row (`0-1`) derived from retained-pool evidence quality
- `source_mix_json`: compact source-family composition for the retained pool set

`primary` coverage now includes both pure-`dl` rows and pure-`direct_api` rows. `fallback` is reserved for rows built entirely from staged / DexScreener / CoinGecko-tickers style recovery sources.

Coverage confidence is no longer a fixed ladder by source family alone. The scorer now blends:

- protocol breadth and source-family breadth across the retained pool set
- measured-balance and measured-price TVL share
- organic measured TVL share
- penalties for synthetic and freshness-decayed TVL share

This keeps `coverage_class` stable for broad bucket semantics while making `coverage_confidence` more honest about partially measured rows.

Current rows also persist:

- `balance_measured_tvl_usd`
- `organic_measured_tvl_usd`

Top-pool JSON now also preserves per-pool measurement flags (`tvlMeasured`, `volumeMeasured`, `balanceMeasured`, `maturityMeasured`, `priceMeasured`, `synthetic`, `decayed`, `capped`) so downstream consumers can distinguish measured inventory from inferred fallback liquidity.

These measurement-denominator fields let the frontend weight balance/organic aggregates only by TVL that actually had measured inputs.

### Storage

Stored in D1 `dex_liquidity` table (current checked-in schema lives in `worker/migrations/0000_baseline.sql`; the pre-squash lineage was created in migration 0009 and extended in 0010, 0012, 0024, 0036, and 0061) with per-stablecoin aggregate metrics, protocol/chain TVL breakdowns, top 10 pools as JSON columns, plus v2/v3 columns: `avg_pool_stress`, `weighted_balance_ratio`, `organic_fraction`, `effective_tvl_usd`, `durability_score`, `score_components_json`, `locked_liquidity_pct`, `coverage_class`, `coverage_confidence`, `source_mix_json`, `balance_measured_tvl_usd`, `organic_measured_tvl_usd`, and `methodology_version`. Stablecoins with no observed DEX presence store `liquidity_score = NULL` (NR semantics) and `coverage_class = 'unobserved'`.

Safety Score v8.17 preserves those evidence fields, plus aggregate `dex_deployment_outcomes`, through its report-card snapshot loader. This does not change the standalone Liquidity Score. Liquidity / Exit separately classifies aggregate rows as generic TVL proxy, synthetic/fallback, or unobserved and applies conservative evidence ceilings. Balance-measured aggregate TVL remains generic proxy evidence unless a separate exact route observation retains the invariant, fee, output identity, and executable capacity curve needed for reserve-based AMM simulation. Rows explicitly marked `legacy` remain neutral until current evidence is republished. The stronger measured-executable-depth and direct-orderbook-depth classes require dedicated, consumer-validated route producers; TVL alone is never labeled as executable slippage depth.

Pool, token, and deployment identities use chain-specific casing: EVM addresses remain case-insensitive, while non-EVM native identifiers preserve case. During the rollout from legacy lowercase non-EVM rows, a newer corrected staging or deployment-outcome row supersedes an older lowercase-equivalent row only when the stablecoin, chain, source identity, and native pool/token identity otherwise match; same-time or otherwise ambiguous case-distinct rows remain separate and fail closed rather than being guessed together.

The additive P4a producer also writes optional same-notional route observations into the existing score-details envelope. Capability matrix `p4a.4` supports exact Raydium standard constant-product pools, Balancer weighted constant-mean pools, Curve plain StableSwap pools, Balancer stable-math pools (STABLE, COMPOSABLE_STABLE, META_STABLE), and validated Uniswap V3 or PancakeSwap V3 QuoterV2 measurements. Reserve-based models require normalized balances, chain-scoped token identities, each token's own USD reference, fees, weights or amplification, and the tracked input index. Curve models attach only through an address-grade DeFiLlama join - exact pool address or unambiguous coin-set fingerprint (DeFiLlama yields rows carry UUID pool ids, so the fingerprint is the production path; identical coin sets fail closed to the symbol fallback, which never carries a model) - and fail closed on CryptoSwap registries and on rate-bearing pools detected via a 1% per-coin USD price spread gate, both of which were measured overstating on-chain quotes when modeled as plain stableswap. Paused or swap-disabled Balancer pools survive only as P4 capability-gate rows; scoring excludes them before protocol caps, aggregate metrics, visible pools, challenger construction, and price observations. Stableswap amplification is stored in the plain paper convention (`Ann = A * n^n`): both the Curve API and the Balancer aggregator endpoint report the contract convention (`Ann = A * n`), so capture divides by `n^(n-1)` - verified against on-chain `get_dy`/`queryBatchSwap` quotes at pinned blocks. Balancer stable models take amp from the aggregator endpoint (which, queried without hook inclusion, only returns hook-free pools with reviewed rate providers), exclude the composable pool's own phantom BPT, and simulate on rate-scaled balances (`balance * priceRate`, reference price divided by the same rate) so the invariant sees on-chain scaled units; a missing amp or missing per-token price rate fails closed to shaped TVL evidence. It simulates bounded curves at a 200 bps maximum cost and a 300 second settlement horizon. The tracked input token must resolve to the stablecoin being scored, token identities must be distinct under the chain's casing rules, and modeled pool TVL (`sum(balance * referencePriceUsd)`) must stay within `0.5x-2x` of the retained pool TVL. A missing or invalid model, including a TVL reconciliation outside those bounds, emits no executable observation and records an `invalidExecutionModel:*` unsupported reason; aggregate TVL is never substituted as executable depth.

Capability matrix `p4a.4` makes completeness depend on the explicit count of retained pools that have a reviewed score-eligible execution capability. Generic shaped TVL remains visible in diagnostics but is excluded from that denominator because it cannot produce executable evidence. Reviewed exact-family failures, including CryptoSwap, rate-bearing Curve inputs, malformed exact captures, and paused or swap-disabled pools, remain in the denominator through an explicit capability gate and therefore keep coverage incomplete. Older envelopes without the explicit capability count fail closed until a new DEX-liquidity capture publishes `p4a.4`; the consumer does not infer completeness from legacy unsupported-reason strings.

The isolated `sync-cl-exit-depth` lane runs at `0,30 * * * *`, ten minutes before DEX scoring. It loads the latest published retained-pool target generation, pins one block per chain, verifies reviewed QuoterV2 and factory bytecode, proves each pool through the factory's exact `getPool` binding, and records a $1,000 marginal quote plus the TVL-tiered $100,000/$1 million/$10 million/$25 million ladder with bounded refinement. The producer publishes target and quote generations atomically in D1. The following scoring run joins only a fresh published quote generation, projects a compact public profile, and publishes the next target generation after scoring; raw calldata, returndata, and failure evidence remain in D1. Uniswap V3 and PancakeSwap V3 profiles must pass consumer validation of generation, identity, decimals, price, freshness, provenance, curve monotonicity, cost bracketing, and the `1.5x` retained-TVL capacity ceiling. Their reviewed deployment cohorts nevertheless remain `activation-pending` and score-ineligible until archive replay, executed-swap equivalence, independent cross-checks, drift analysis, and the required shadow window are approved. Fluid resolver measurements use the same producer and remain `activation-pending` under their own matrix and shadow requirements. Curve CryptoSwap remains a separately validated shadow adapter and is not routed through the plain StableSwap model.

Exact DEX route coverage is complete only when the count of capability-denominator pools with at least one score-eligible observation equals the explicit capability-denominator count. Aggregate observation count is not the completeness measure because one pool may emit multiple observations, and generic shaped pools may remain unsupported diagnostics without entering the executable denominator. Partial model coverage remains useful shadow evidence but cannot present the modeled subset as the holder's exhaustive DEX exit surface. Production report cards continue to use the legacy aggregate path until a deployed `p4a.4` capture and replay satisfy the activation boundary; incomplete modeled coverage retains the aggregate DEX floor rather than allowing a modeled subset to replace it. The DEX envelope accepts only `dex-amm` and `dex-orderbook` route families, and active replay rejects future observations or live observations older than twice the 30-minute producer interval (1 hour). Unmeasured CLMM/DLMM pools, custom invariants without an activated adapter (Gyro and Fluid), hook-bearing Balancer pools, incomplete token-price models, aggregate TVL rows, and narrow CEX diagnostics remain explicitly unsupported or diagnostic-only.

Current rows expose `exitRouteObservations` and `exitRouteObservationCoverage`; daily history stores the bounded summary prospectively in `dex_liquidity_history.exit_route_summary_json`. Existing history is not backfilled or claimed to reconstruct old route capacity. The first isolated complete generation, `dex-liquidity-1783905029`, published 360 asset rows: 7 populated, 173 unsupported, and 180 unknown, with 21 exact observations. That generation predates the per-pool completeness counter, so current calibration preserves the observations but treats its DEX coverage as incomplete and activation-ineligible. The fixed all-active decision table is committed at `shared/data/safety-score-v9/exit-route-calibration-v1.json`.

Both `dex_liquidity` and `dex_liquidity_history` also carry `methodology_version` (migration 0036), reconstructed from commit-history version windows in `shared/lib/liquidity-score-version.ts`. Historical rows also persist `coverage_class`, `coverage_confidence`, and `source_mix_json`. Legacy pre-0061 rows are backfilled as `coverage_class = 'legacy'` and `coverage_confidence = 0.5`.

Detail-page consumers should treat `unobserved` history as explicit absence-of-direct-market evidence, not as a measured zero-liquidity market chart. The stablecoin detail page now renders a dedicated unobserved-history state for those rows instead of plotting a zero-value TVL area chart.

Discovery and merge staging tables are documented in the [Discovery Cron](#discovery-cron) section below.

## Discovery Cron

`worker/src/cron/dex-discovery/orchestrator.ts` runs every 2 hours (`6 */2 * * *`) and is responsible for pool discovery only. Scored TVL continues on the 30-minute cadence; discovery data is merged during the scoring run.

- **Architecture**: two dedicated cron tracks feed discovery from scratch:
  - Scoring cron: `syncDexLiquidity()` every 30 minutes (`10,40 * * * *`).
  - Discovery cron: `syncDexDiscovery()` every 2 hours (`6 */2 * * *`).
  - Discovery writes normalized candidates to `dex_pool_staging`; scoring cron consumes and merges them.
- **Discovery staging schema**: `dex_pool_staging` includes `pool_id`, `stablecoin_id`, `source`, `chain`, `protocol`, `dex_id`, `symbol`, `tvl_usd`, `volume_24h`, `quality_multiplier`, `pool_type`, `fee_tier`, `balance_ratio`, `is_stable`, `base_token`, `quote_token`, `quote_symbol`, `price_usd`, `locked_liq_pct`, `raw_json`, `discovered_at`, `refreshed_at`; PK is `(pool_id, stablecoin_id)`.
- **Discovery meta schema**: `dex_discovery_meta` stores `stablecoin_id` (PK), `consecutive_misses`, `last_crawl_at`, `last_hit_at`.
- **Deployment outcome schema**: `dex_deployment_outcomes` stores one exact stablecoin/chain/contract row as `observed_pools`, `verified_no_pools`, or `provider_inaccessible`, including the provider set, reason, observation time, pool count, and optional owned waiver. A no-pool result is written only after a provider completes that exact token query. The canonical registry owns current inaccessible deployments; full-footprint gaps require explicit, expiring waivers while adapters or provider mappings are evaluated.
- **Tiered priority**:
  - T1: coins with 0 pools (or effectively eligible baseline), every run.
  - T2: 1–4 pools or 1 chain, every 3rd run.
  - T3: `>=5` pools on `>=2` chains, every 10th run.
  - Global scheduling is tier-first (`T1 -> T2 -> T3 -> dormant`), with staleness used only as the tie-breaker inside a tier.
- **Exponential backoff** (applied as a tier floor from `consecutiveMisses`; effective tier is `max(baseTier, backoffTier)`):
  - 0–2 misses: no backoff override (base tier from pool/chain counts determines placement)
  - 3–5: floor T2
  - 6–9: floor T3
  - 10+: dormant (daily gate)
  - Any discovery hit resets `consecutiveMisses` to 0, removing the backoff floor; the coin's tier is then recomputed from its pool/chain counts on the next run.
- **Chain-aware source routing**: discovery only queries chains with defined entries in a stablecoin’s `contracts` plus optional `tradedContracts` metadata; this avoids unnecessary API calls against un-deployed chains while preserving wrapper/secondary-market discovery addresses.
- **Freshness confidence decay**: staged pool effective TVL is multiplied by `max(0.5, 1 - ageHours / 48)`; rows older than 24h are excluded from scoring merge.
- **Staged pool defaults**: `organic_fraction = 0.5`, `balanceRatio = 1.0`, `lockedLiquidity = null`, `maturity = min(daysSinceDiscovered, 30)`, `isStable` inferred from normalized `quoteSymbol`.
- **Source order and transport**: `CG Onchain -> GeckoTerminal -> DexScreener -> CG Tickers`, executed sequentially with one active fetch at a time (`1` connection).
- **Failure telemetry**: cron metadata records both `failedCoins` and `failedCoinErrors`; DexScreener malformed-pair or per-target errors are downgraded to warnings so a single bad fallback payload does not fail the whole coin crawl. DexScreener discovery records one aggregate breaker outcome per coin crawl rather than one failure per optional token target, so partial target misses do not open the source-wide breaker by themselves.

### Global Deduped Aggregates (`__global__`)

A sentinel row with `stablecoin_id = '__global__'` stores cross-stablecoin aggregates where each physical pool is counted only once (deduped by `poolId`). This prevents double-counting when a pool contains multiple tracked stablecoins (e.g., a USDT/USDC pool would otherwise add its full TVL to both USDT and USDC rows).

The `__global__` row contains deduped `total_tvl_usd`, `total_volume_24h_usd`, `total_volume_7d_usd`, `pool_count`, `chain_count`, `protocol_tvl_json`, and `chain_tvl_json`. 24h and 7d volumes are deduped by `poolId` the same way TVL is. Score-related fields (`liquidity_score`, `concentration_hhi`, etc.) are NULL.

The frontend reads `__global__` for overview stats (total DEX TVL, 24h volume, protocol/chain breakdown bars) instead of naively summing per-stablecoin values. The constant `DEX_GLOBAL_KEY` (`shared/types/index.ts`) provides the key.
The liquidity overview's `Protocol TVL Breakdown` legend is capped at 10 entries total: the top 9 protocols render individually, and the remainder is grouped into `Other`.

### Additional Liquidity Metrics

- **Concentration HHI**: Herfindahl-Hirschman Index computed from the full retained pool set after filtering/caps but before top-10 display truncation. Range 0-1 (1.0 = single pool). Stored as `concentration_hhi`.
- **Depth Stability**: Coefficient of variation of daily TVL over 30-day rolling window, inverted to 0-1 scale. Requires >=7 days of data. Stored as `depth_stability`.
- **TVL Trends**: 24h and 7d percentage changes computed from daily history snapshots, but only when a baseline exists within a tolerance window (`12h` for 24h, `36h` for 7d) and that snapshot has `coverage_confidence >= 0.5`. Otherwise the API returns `null`.
- **Depth Stability / Volume Consistency inputs**: durability history uses only snapshots with `coverage_confidence >= 0.75`; fewer than 7 confident rows fall back to neutral durability defaults.
- **Daily Snapshots**: One snapshot per active stablecoin per day in `dex_liquidity_history` (migration 0010, confidence fields added in 0061). A run reuses today's snapshot only when its active-ID set is exact, has no duplicate identities, and its scored-ID set covers the incoming active scored IDs. If coverage expands or the active universe changes, the writer preserves richer same-day scored rows, overlays new observations, and replaces the UTC date through one bounded atomic D1 batch (`DELETE` plus multi-row inserts), so a failed replacement leaves the prior date state intact. Successful DEX liquidity persistence also prunes history to the public 365-day window.

---

## DEX Price Cross-Validation

`dex_prices` table (migration 0011) stores DEX-implied USD prices extracted from multiple DEX sources. Updated every 30 minutes during `syncDexLiquidity()`.

**Price observation sources:**

| Source                           | Tier    | Chains                                                                                                                                                           | Method                                                                | Filter                                                                                                                                                              |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Curve StableSwap**             | 1 (1.0) | Ethereum, Base, Arbitrum, Polygon                                                                                                                                | Curve Finance API `usdPrice` per coin                                 | TVL >= $50K, balance ratio >= 0.3                                                                                                                                   |
| **Fallback indexed Curve pools** | lower   | Chains without native Curve API coverage, currently including Plasma when indexed by fallback pool providers                                                     | GeckoTerminal / CoinGecko Onchain token-pool prices                   | TVL >= $50K for price observations, peg-aware price sanity against the shared validation engine, and skipped on native-covered Curve API chains to avoid duplicates |
| **Uniswap V3**                   | 1 (1.0) | Ethereum, Base, Arbitrum, Polygon                                                                                                                                | Subgraph `token0Price`/`token1Price` relative to USD reference tokens | TVL >= $50K, one side must be USDC/USDT/DAI/etc. (after alias normalization such as `USD₮0` -> `USDT`), peg-aware price sanity against the shared validation engine |
| **Aerodrome**                    | 1 (1.0) | Base                                                                                                                                                             | Subgraph `token0Price`/`token1Price` + `reserveUSD`                   | TVL >= $50K, balance ratio >= 0.3, peg-aware price sanity against the shared validation engine                                                                      |
| **Fluid**                        | 1 (1.0) | Ethereum, Arbitrum, Base, Polygon, BSC, Plasma                                                                                                                   | Direct API `last_price` (base/target ratio)                           | TVL >= $50K, peg-aware price sanity against the shared validation engine                                                                                            |
| **Balancer**                     | 1 (1.0) | 16 mapped chains (Ethereum, Arbitrum, Base, Polygon, Optimism, Gnosis, Avalanche, Sonic, Fantom, Fraxtal, Mode, Polygon zkEVM, Plasma, Monad, HyperEVM, X Layer) | Derived from `balanceUSD / balance` per token                         | TVL >= $50K, peg-aware price sanity against the shared validation engine                                                                                            |
| **Raydium**                      | 1 (1.0) | Solana                                                                                                                                                           | Direct API `price` field (base/quote ratio)                           | TVL >= $50K, peg-aware price sanity against the shared validation engine                                                                                            |
| **Orca**                         | 1 (1.0) | Solana                                                                                                                                                           | Direct API `price` field (base/quote ratio)                           | TVL >= $50K, peg-aware price sanity against the shared validation engine                                                                                            |
| **Meteora**                      | 1 (1.0) | Solana                                                                                                                                                           | Direct API `current_price`                                            | TVL >= $50K, peg-aware price sanity against the shared validation engine                                                                                            |
| **PancakeSwap V3**               | 1 (1.0) | BSC, Ethereum, Base                                                                                                                                              | Subgraph `token0Price`/`token1Price`                                  | TVL >= $50K, peg-aware price sanity against the shared validation engine                                                                                            |
| **Aerodrome Slipstream**         | 1 (1.0) | Base                                                                                                                                                             | Sugar view `sqrt_ratio` via `sqrtRatioToSpotPrice`                    | TVL >= $50K, peg-aware price sanity against the shared validation engine                                                                                            |
| **Velodrome Slipstream**         | 1 (1.0) | Optimism                                                                                                                                                         | Sugar view `sqrt_ratio` via `sqrtRatioToSpotPrice`                    | TVL >= $50K, peg-aware price sanity against the shared validation engine                                                                                            |
| **DexScreener**                  | lower   | 30+ chains (universal fallback)                                                                                                                                  | Token pools API `priceUsd`                                            | Pair liquidity >= $50K for price observations, >= $1K for pool discovery, peg-aware price sanity against the shared validation engine                               |

**Price extraction pipeline:**

1. Collect price observations from all source families during data fetching phase
2. Merge all observations into a single map keyed by stablecoin ID
3. Run pool dedupe, retention filters, and protocol-level TVL caps for the main liquidity scoring surface
4. Rebuild DEX price observations only from retained pools that still carry a usable stablecoin `price`
5. Collapse any remaining duplicate retained observations of the same physical pool so one pool only carries weight once
6. Compute source-family-confidence-weighted median per stablecoin from that retained priced-pool surface
7. Compare with primary price from D1 cache to compute `deviation_from_primary_bps`
8. Store in `dex_prices` with one aggregated JSON entry per protocol in `price_sources_json`
9. Publish qualifying challenger pools from the full retained pool set into `dex_price_challenger_snapshots` and `dex_price_challengers`
10. Retire any pre-existing `dex_prices` rows whose stablecoin has no observations in the latest successful scoring run, so the table reflects current DEX coverage rather than last-seen coverage

Raw pre-retention discovery observations no longer write directly into `dex_prices`. If a pool is skipped as a duplicate or dropped by retained-pool quality filters, it cannot keep influencing `dexPriceUsd` or `price_sources_json`.

DEX observation validation now loads the current FX / gold / silver references **once per cron entrypoint** and passes them through the scoring and discovery paths. In normal operation this means:

- fiat pegs validate against live FX references, not only hardcoded fallback ranges
- gold/silver pegs validate against live spot references, scaled by `commodityOunces` for fractional tokens

The primary-pricing bridge now reads `dex_prices.price_sources_json` as a per-protocol aggregate (`fluid`, `balancer`, `curve`, `uniswap-v3`, `uniswap-v4`, `raydium`, `orca`, etc.) rather than as repeated individual pool rows. Those aggregates are rebuilt from the same retained pool surface used by challenger publication and UI liquidity detail, so skipped discovery rows cannot bypass retained-pool admission just because they emitted an early price observation. Individual pool challenge reads instead come from the dedicated challenger tables published from the full retained pool set, so consensus promotion, depeg confirmation, and UI top-pool display no longer share the same storage shape. When a promoted per-protocol bridge source is actually admitted for an asset, the overlapping `dex-promoted` aggregate is withheld from primary consensus so the same DEX observation family cannot self-confirm. If promoted protocol candidates are rejected for registry, freshness, TVL, or corroboration reasons, a valid aggregate `dex-promoted` source can still enter as the soft DEX fallback. A lone promoted DEX protocol is admitted only when no non-DEX source exists, or when a hard market/oracle/protocol source agrees inside the live threshold. Two or more promoted DEX protocols are admitted as candidate sources; consensus then determines agreement.

Every source family now uses the same minimum liquidity rule for DEX prices: a pool must contribute at least `$50K` of liquidity at observation time. For staged discovery rows, the floor is applied after freshness confidence decay. For retained-pool publication, the same floor is reapplied before writing `dex_price_usd` or `price_sources_json`, while lower-TVL retained pools can still contribute to liquidity scoring when they pass the scoring gates.

DEX price median weighting uses canonical source families rather than the normalized protocol label: DeFiLlama and direct API observations carry `1.0x`, CoinGecko Onchain and GeckoTerminal carry `0.85x`, and DexScreener plus CoinGecko tickers carry `0.55x`. This prevents fallback rows from gaining primary-source median weight solely by claiming a high-trust protocol name.

**Confirmation gate in `detectDepegEvents()`:**

- When primary price shows depeg (>=100bps), check DEX price
- Only **trusted** DEX rows are used for depeg suppression/confirmation: freshness within `DEX_FRESHNESS_SEC` (currently 35 minutes) and aggregate source TVL `>= $1M`
- If a trusted DEX price shows coin at peg (<100bps): **suppress** new depeg event (likely false positive)
- If DEX unavailable, stale, or confirms depeg: open event normally
- DEX evidence participates in new-event suppression, pending/extreme confirmation, same-direction peak support, and corroborated recovery paths; existing events are not auto-closed by a single contradictory DEX row
- ~80-100 stablecoins covered by multi-source observations; remainder fall through to primary-only detection

**API exposure:**

- `/api/dex-liquidity`: adds `dexPriceUsd`, `dexDeviationBps`, `priceSourceCount`, `priceSourceTvl`, `priceSources`, `coverageClass`, `coverageConfidence`, coverage-confidence-derived `liquidityEvidenceClass`, `hasMeasuredLiquidityEvidence`, `trendworthy`, `sourceMix`, `balanceMeasuredTvlUsd`, `organicMeasuredTvlUsd`, and exact `deploymentCoverage` outcome rows
- `/api/dex-liquidity`: adds a `Warning` header when the latest `sync-dex-liquidity` run was degraded or failed and the endpoint is serving the last successful dataset; high-severity quality drift in an otherwise `ok` run now also emits a warning
- `/api/dex-liquidity-history`: now returns `liquidityEvidenceClass`, `hasMeasuredLiquidityEvidence`, and `trendworthy` so history consumers can separate baseline-worthy periods from informational low-confidence snapshots
- `/api/peg-summary`: adds optional `dexPriceCheck` per coin when the row passes a UI trust gate (fresh within 60 minutes and aggregate source TVL `>= $250K`)

**Frontend:**

- `dex-liquidity-card.tsx`: shows DEX-implied price section when available plus coverage badges (`Primary`, `Mixed`, `Fallback`, `NR`)
- `dex-liquidity-card.tsx`: surfaces whether liquidity is measured, partially measured, or only observed without measured pool balances
- `dex-liquidity-card.tsx`: for `unobserved` rows, the detail page now says no direct-token DEX market is observed and renders an explicit unobserved-history state instead of hiding history or plotting placeholder zeros as a market chart
- `dex-liquidity-card.tsx` and the detail distribution section distinguish unsupported or valid-empty coverage from source failures; unavailable and retained-stale data remain visible with source notices and retry actions instead of disappearing
- `/liquidity`: shows coverage badges and a separate unrated/unobserved section instead of silently dropping NR assets
- `/liquidity` search uses two-way URL synchronization, so browser Back/Forward restores the visible `q` input as well as the result set
- Detail and overview liquidity surfaces now attach contextual methodology hints to the score label, `Effective TVL`, and key summary stats, with score-card footer links back to `/methodology/#liquidity-methodology`
- `peg-heatmap.tsx`: amber "!" badge on tiles where DEX disagrees with primary

**Operator metadata:**

- `sync-dex-liquidity` cron metadata now records run-over-run drift and evidence-gap diagnostics including:
  - `qualityDriftSeverity` / `qualityDriftFlags`
  - `coinsWithoutMeasuredBalances`, `coinsGtOnly`, `coinsCrawlerOnly`
  - per-source-family retained pool counts, measured TVL, and price-observation coin counts
  - protocol-cap breakdowns by top protocol and top affected stablecoin
  - watchlist deltas for major assets such as USDC, USDT, DAI, USDS, and USDe
