# Pricing Pipeline

Canonical reference for Pharos live-price selection, fallback enrichment, and source-specific normalization.

For supply fallback behavior and broader cache/integrity guardrails, see [data-pipeline.md](./data-pipeline.md).

> **Agent navigation** — ~72 KB; Grep the heading you need instead of reading wholesale: Overview · Versioning · Primary Consensus · Provider-Specific Normalization · Authoritative Overrides · Fallback Enrichment · Confidence Model · Update Rules · File Index.

---

## Overview

Pharos uses a two-stage pricing system:

1. **Primary consensus** in `fetchPrimaryPrices()` (`worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`)
2. **Fallback enrichment** in `enrichMissingPrices()` (`worker/src/cron/sync-stablecoins/enrich-prices.ts`)

The output is the cached `price`, `priceSource`, `priceConfidence`, `priceObservedAt`, `priceObservedAtMode`, `priceSyncedAt`, optional `priceSourceConfidenceProfile`, and compatibility `priceUpdatedAt` fields served through `/api/stablecoins`.

When an asset still has no usable current price after validation and fallback recovery, Pharos keeps `price = null`, `priceConfidence = null`, and serializes `priceSource = "missing"` so the cache payload stays structurally valid while still making the missing-price state explicit.

---

## Versioning

- **Current methodology version:** `v6.191`
- **Canonical version module:** `shared/lib/methodology-versions/pricing-pipeline.ts`
- **Public changelog route:** `/methodology/pricing-pipeline-changelog/`
- **Longform methodology section:** `/methodology/#pricing-pipeline-methodology`

---

## Primary Consensus

`fetchPrimaryPrices()` gathers all usable live prices for a tracked asset, then runs N-source consensus via `worker/src/lib/price-consensus.ts`.

### Source Weights

| Source                                      | Weight | Module / Origin                                                                 | Notes                                                                                                                                          |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| CoinGecko `/simple/price`                   | 2      | built-in fetch path                                                             | Primary market-data voice; uses upstream `last_updated_at` freshness when available and drops stale rows outside the trusted age window        |
| CoinGecko ticker                            | 2      | `worker/src/lib/cg-ticker.ts`                                                   | Exchange-ticker corroboration path for the curated tracked subset                                                                              |
| DefiLlama stablecoins list                  | 1      | Typed quote extracted from DL stablecoins endpoint                              | Independent DL aggregation; requires observed-time metadata and drops missing, stale, or future-skewed observations before consensus           |
| Pyth Hermes                                 | 2      | `worker/src/lib/pyth.ts`                                                        | Oracle input with confidence intervals                                                                                                         |
| Binance spot                                | 2      | `worker/src/lib/cex-tickers.ts`                                                 | Batch venue input                                                                                                                              |
| Kraken spot                                 | 2      | `worker/src/lib/cex-tickers.ts`                                                 | Explicit-pair venue input with alias-safe symbol mapping                                                                                       |
| Bitstamp spot                               | 1      | `worker/src/lib/cex-tickers.ts`                                                 | Lower-weight all-tickers corroboration venue                                                                                                   |
| Coinbase spot                               | 2      | `worker/src/lib/cex-tickers.ts`                                                 | Per-symbol venue input                                                                                                                         |
| RedStone                                    | 1      | `worker/src/lib/redstone.ts`                                                    | Fresh per-venue oracle snapshot with venue-agreement gating                                                                                    |
| Curve on-chain                              | 3      | `worker/src/lib/curve-onchain.ts`                                               | Highest-weight on-chain voice for explicitly configured direct, one-hop, and opt-in chained-hop Curve pools                                    |
| Curve oracle (`crvusd-curve` only)          | 3      | `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`                     | Additional primary-consensus voice for crvUSD                                                                                                  |
| Chainlink NAV reserve telemetry             | 3      | `reserve_composition` rows from the `chainlink-nav` live-reserve adapter        | Matched authoritative live-reserve snapshots; USD NAV publishes directly and non-USD NAV converts through fresh/static FX references           |
| Superstate NAV reserve telemetry            | 3      | `reserve_composition` rows from the `superstate-liquidity` live-reserve adapter | USTB NAV telemetry from the Superstate live-reserve adapter, admitted only when the reserve snapshot matches reserve sync state                |
| Trusted promoted DEX prices                 | 1      | `worker/src/lib/depeg-helpers.ts`                                               | Only used when no promoted per-protocol DEX bridge candidate exists for the same asset and no Binance bridge overlap exists                    |
| Fluid DEX (via `dex_prices`)                | 3      | `worker/src/lib/depeg-helpers.ts`                                               | One aggregated Fluid price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist                |
| Balancer DEX (via `dex_prices`)             | 3      | `worker/src/lib/depeg-helpers.ts`                                               | One aggregated Balancer price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist             |
| Curve DEX (via `dex_prices`)                | 3      | `worker/src/lib/depeg-helpers.ts`                                               | One aggregated Curve price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist                |
| Uniswap V3 DEX (via `dex_prices`)           | 2      | `worker/src/lib/depeg-helpers.ts`                                               | One aggregated Uniswap V3 price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist           |
| Uniswap V4 DEX (via `dex_prices`)           | 2      | `worker/src/lib/depeg-helpers.ts`                                               | One aggregated Uniswap V4 price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist           |
| Raydium DEX (via `dex_prices`)              | 2      | `worker/src/lib/depeg-helpers.ts`                                               | One aggregated Raydium price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist              |
| Orca DEX (via `dex_prices`)                 | 2      | `worker/src/lib/depeg-helpers.ts`                                               | One aggregated Orca price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist                 |
| Meteora DEX (via `dex_prices`)              | 2      | `worker/src/lib/depeg-helpers.ts`                                               | One aggregated Meteora price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist              |
| PancakeSwap DEX (via `dex_prices`)          | 2      | `worker/src/lib/depeg-helpers.ts`                                               | One aggregated PancakeSwap price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist          |
| Aerodrome Slipstream DEX (via `dex_prices`) | 2      | `worker/src/lib/depeg-helpers.ts`                                               | One aggregated Aerodrome Slipstream price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist |
| Velodrome Slipstream DEX (via `dex_prices`) | 2      | `worker/src/lib/depeg-helpers.ts`                                               | One aggregated Velodrome Slipstream price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist |
| GeckoTerminal pool probe                    | 1      | `worker/src/lib/geckoterminal-price-probe.ts`                                   | Pool-level cross-check for weak CoinGecko / DL-list soft-source outcomes                                                                       |
| Exact-address augmentation providers        | 1      | `worker/src/lib/address-price-providers/index.ts`                               | Targeted exact chain+address augmentation via DexScreener, DexPaprika, CoinGecko Onchain, Alchemy Prices, Moralis, and Birdeye for missing, low-depth, or low-confidence assets; no symbol search |
| DexPaprika exact-address augmentation       | 1      | `worker/src/lib/address-price-providers/index.ts`                               | Public exact token-detail lookup with liquidity and upstream freshness when available                                                           |
| Alchemy Prices exact-address augmentation   | 1      | `worker/src/lib/address-price-providers/index.ts`                               | Optional keyed batch lookup by provider network + address                                                                                       |
| Moralis exact-address augmentation          | 1      | `worker/src/lib/address-price-providers/index.ts`                               | Optional keyed EVM batch lookup by chain + token address                                                                                        |
| Birdeye exact-address augmentation          | 1      | `worker/src/lib/address-price-providers/index.ts`                               | Optional keyed Solana-only token-price lookup for targeted gaps                                                                                 |

> **Historical note (v2.0→v2.1):** The DL coins API (`coins.llama.fi/prices/current/coingecko:{id}`) was removed from primary consensus because it returned CoinGecko-sourced data, creating illusory two-source agreement. It is still used in fallback enrichment via contract-address queries.

### Consensus Rules

`computePriceConsensus()` behaves as follows:

1. 0 sources -> no result
2. 1 source -> `single-source`
3. 2+ sources -> build fully pairwise agreement clusters within a peg-aware threshold
4. best cluster with 2+ members -> initially `high` confidence, publish the cluster median, and keep the best trusted member as internal provenance. For even-sized clusters, the median is the midpoint average of the two middle sorted members.
5. no 2+ cluster:
   - fixed pegs -> stay in fixed-peg mode even if the reference price is temporarily unavailable; choose the best trusted fallback source by trust tier first, then reference proximity, and mark `low`
   - NAV tokens -> use a wider 500 bps cluster threshold first, otherwise choose the best trusted fallback source and mark `low`

When multiple clusters have the same size, the winner is chosen deterministically by:

1. larger total cluster weight
2. stronger trust tier (any hard-tier member > mixed > all soft) — prevents a tight soft cluster from beating an equal-weight hard cluster on proximity alone
3. tighter internal spread
4. proximity to peg reference (when available)
5. stable alphabetical source label as the final tie-break

Source labels list all agreeing sources alphabetically:

- 1 source: source name directly
- 2+ sources: `sourceA+sourceB+sourceC` (full list, no truncation)

High-confidence consensus now separates:

- the **published price**: the median of the agreeing winning cluster
- the **selected source**: the best cluster member kept internally for provenance and downstream trust policy

Inside the winning cluster, the selected source is chosen by:

1. higher configured weight
2. stronger trust tier
3. closer distance to the reference price
4. alphabetical source key

When severe fixed-peg downside publication is accepted because multiple candidate sources independently confirm the
downside, that candidate-price evidence is carried through the later prevalidation and post-enrichment validation passes
as long as the current asset price, source, and confidence still match the selected primary result. This keeps a
corroborated low-confidence depeg price from being cleared as if it were genuinely single-source, without loosening the
guardrail for unrelated fallback or stale prices.

Severe fixed-peg downside corroboration counts independent source families, not raw source labels. CoinGecko-derived
sources share one lineage, DefiLlama list/detail/contract sources share one lineage, each CEX/oracle source keeps its own
lineage, and promoted DEX protocol lanes count by protocol. A CoinGecko plus DefiLlama-list downside pair is treated as
correlated list-aggregator evidence and cannot publish a severe downside price unless a separate hard or non-list family
also corroborates it.

### Pool Challenge (Soft-Source Guard)

After consensus, weak soft-source results where the selected/agreeing source cluster is **pool-challenge eligible** are challenged against current individual priced pools from the published challenger snapshot (`dex_price_challenger_snapshots` + `dex_price_challengers`) that meet the live $100K TVL minimum and are fresh within `DEX_FRESHNESS_SEC`. Eligible source families include CoinGecko, DefiLlama-list, `dex-promoted`, and promoted protocol-level DEX sources (`fluid-dex`, `balancer-dex`, `curve-dex`, `uniswap-v3-dex`, `uniswap-v4-dex`, `raydium-dex`, `orca-dex`, `meteora-dex`, `pancakeswap-dex`, `aerodrome-dex`, `velodrome-dex`) as long as the selected cluster does not include an exempt hard source. Non-selected hard candidates do not by themselves exempt the selected soft result, but they can corroborate the narrow high-TVL replacement exception below. NAV tokens are excluded from the pool challenge entirely: their fair value is their published NAV and the peg-aware divergence threshold does not map to a meaningful DEX-liquidity check, so diverging pools cannot downgrade or replace a NAV price. The standard divergence threshold is **peg-type-aware**: 500 bps for USD pegs, `min(2× depeg threshold, 500)` for non-USD pegs (e.g., 300 bps for JPY/EUR). High-TVL replacement paths use the peg depeg threshold as their result-vs-pool trigger when the soft result is still inside that same threshold. If ANY qualifying protocol median diverges from the weak result beyond the applicable threshold:

1. Confidence is always downgraded to `low`.
2. The price is **replaced** when diverging protocol-level challenger prices span **≥2 independent protocols**. A single protocol's pools may share data-quality issues (vault-token counterparties, misconfigured pairs), and one rogue pool inside an otherwise agreeing protocol does not make that protocol count as corroborating disagreement. A high-TVL multi-protocol path also replaces a near-peg soft result when at least two independent protocol medians each carry at least `$5M` TVL, are depeg-sized in the same direction, diverge from the soft result by at least the peg depeg threshold, and agree with each other inside the existing pool-challenge bps band. If an additional high-TVL protocol median shows the same direction but breaks pairwise coherence, Pharos selects the largest coherent same-direction high-TVL subset instead of letting that outlier veto the otherwise corroborated replacement. A narrow single-protocol exception exists when that protocol median carries at least the `$5M` high-TVL threshold, the protocol median itself is depeg-sized versus the peg reference, the DEX mark materially diverges from the published soft result, and a hard market/oracle/protocol primary candidate agrees with that protocol median within the normal consensus threshold. When replacement fires, Pharos first collapses each protocol to a TVL-weighted median price, then evaluates divergence and the final replacement from those protocol medians. When only one lower-TVL or uncorroborated protocol diverges, or no coherent high-TVL same-direction subset remains, the original price is preserved but confidence stays `low`.

Before any pool-challenge divergence or replacement decision, protocol-level challenger medians must pass the peg-aware `dex_observation` price validator. This keeps inverse or malformed commodity marks (for example `1 / XAUUSD` instead of a USD-per-ounce gold token price) from downgrading or replacing a healthy primary price, while valid depeg-sized DEX medians remain eligible for the normal replacement paths.

When pool-challenge replacement fires, the selected primary result is rewritten in lockstep so downstream carry-through sees the new source: `allPrices`, `observedAtBySource`, and `observedAtModeBySource` are collapsed to a single `pool-tvl-weighted` entry, the replacement `observedAt` is the minimum of the contributing pools' observed-at timestamps (with mode `local_fetch`), and `agreeSources` / `candidateSources` / `disagreeSources` are updated to match. This keeps `hasCorroboratedSevereDownsideCandidate` and the primary-candidate carry-through lane from reading stale pre-replacement sources during later validation passes.

If the selected primary price is a severe fixed-peg downside and at least two live candidate sources independently
corroborate that downside by source family, including at least one depeg-authoritative source such as Pyth, pool challenge can still
downgrade confidence but cannot replace the selected price with a DEX pool median. The same candidate corroboration
also satisfies the temporal-jump guard when the previous trusted price was near peg. This keeps near-peg or stale DEX
liquidity from erasing a corroborated severe depeg while preserving the normal challenge behavior for weak,
uncorroborated soft-source prices.

The DEX bridge and the pool challenge now deliberately read from different storage views:

- `dex_prices.price_sources_json`: one aggregate per protocol, used for primary-price promotion
- `dex_price_challenger_snapshots` + `dex_price_challengers`: current individual challenger pools, published from the full retained DEX pool set for large-pool challenge / depeg confirmation
- `dex_liquidity.top_pools_json`: display-oriented top pools for UI detail, no longer the canonical challenger source

Dead or explicitly blocked DEX ids, including Bunni and its chain-scoped variants, are filtered upstream and cannot contribute challenger pools, promoted DEX bridge sources, or pool-challenge replacement marks.

This catches cases where multiple aggregators or DEX-derived bridge sources agree on a misleading price derived from small pools while ignoring large pools that show a depeg. When the challenge fires, on-chain pool liquidity provides a more honest price signal than aggregator consensus because large pools carry proportional weight. Hard sources (Pyth, Binance, Kraken, Bitstamp, Coinbase, Curve on-chain, Curve oracle, RedStone with multi-venue agreement, protocol-redeem) are exempt because they provide independent market/oracle data.

---

## Provider-Specific Normalization

Several live providers need normalization before their prices can safely enter consensus:

- **Source freshness gate:** primary candidate admission runs every timestamped source through a registry-backed freshness check before the source can enter consensus. The gate enforces each source's `maxTrustedAgeSec`, required observed-at metadata, default observed-at mode, and a 10-minute future-skew ceiling. This is the final shared admission check on top of provider-local stale filtering.
- **Pyth feed IDs:** `worker/src/lib/pyth.ts` normalizes feed IDs to lowercase and strips any leading `0x` before reverse-matching them to tracked assets. Hermes may return the same feed in prefixed or unprefixed form.
- **Pyth staleness guard:** Feeds with `publish_time` older than 5 minutes (`PYTH_MAX_STALENESS_SEC = 300`) are rejected before entering consensus. This prevents stale oracle snapshots from poisoning the price.
- **CoinGecko simple-price freshness:** `/simple/price` requests `last_updated_at`; when CoinGecko supplies it, rows older than the source trust window are rejected before consensus instead of being stamped as fresh local fetches. If the field is absent despite the request, the row can still enter as local-fetch provenance for backwards compatibility with partial responses.
- **Kraken symbols:** Kraken uses explicit request-pair and response-key maps in `worker/src/lib/cex-tickers.ts`; `USDT/USD` returns `USDTZUSD`, so the integration does not rely on naive string slicing.
- **Bitstamp ticker surface:** Bitstamp is fetched from the exchange-wide all-tickers endpoint and then filtered through an explicit tracked-pair allowlist so venue coverage stays deterministic.
- **Coinbase symbols:** `fetchPrimaryPrices()` uppercases symbols before Coinbase lookup. Active pairs: USDT, PAXG, USDS, USD1, HONEY.
- **Binance stable-quote conversion:** Binance direct markets may be configured with stablecoin quote assets when no USD pair exists. BFUSD uses `BFUSDUSDT` and `BFUSDUSDC`; the raw quote is multiplied by the same-run Binance USDT/USD or USDC/USD price before entering consensus as the single `binance` source. If the DEX bridge row also contains Binance orderbook evidence for the same asset, the overlapping aggregate `dex-promoted` lane is suppressed.
- **RedStone symbols:** `worker/src/lib/redstone.ts` only queries the exact-case tracked subset in `REDSTONE_TRACKED_SYMBOL_ALLOWLIST` (21 symbols including `USDe`, `crvUSD`, and `fxUSD`). Unsupported symbols are filtered out before transport, and test coverage now guards the allowlist against stale untracked entries. Where metadata symbols differ from RedStone API symbols (e.g., `FRXUSD` → `frxUSD`, `EURC` → `EUROC`, `XAUT` → `XAUt`), the module translates via `REDSTONE_SYMBOL_CONFIG` entries. Each entry also declares the canonical stablecoin id that may consume the feed, and fetched quotes are keyed by that id before consensus so same-symbol assets cannot share a hard-oracle quote. The `USDH` RedStone feed is pinned to `usdh-native-markets` because the live RedStone source set is Hyperliquid/HypEVM-specific.
- **RedStone request shape:** RedStone requests are sent in sequential batches of 10 symbols; any symbol missing from a batch response is retried once as a single-symbol request.
- **RedStone freshness + transparency gate:** RedStone entries are only admitted when they carry a timestamp newer than 5 minutes and a usable per-venue price breakdown. Timestamp-less or opaque aggregate-only responses are rejected.
- **RedStone multi-venue gate:** RedStone prices now need at least 2 venues and at least 60% venue agreement before they can enter primary consensus; a single venue is treated as insufficient corroboration, and the published RedStone price is derived from the venue median instead of the provider aggregate.
- **CEX capability semantics:** Binance, Kraken, Bitstamp, and Coinbase are all still treated as hard-market voices, but their registry metadata now makes their actual capabilities explicit. Binance is modeled as last-trade-only without bid/ask depth, while Kraken, Bitstamp, and Coinbase expose bid/ask-derived spot surfaces. Kraken retains local-fetch freshness (its `/0/public/Ticker` has no per-pair UNIX timestamp), while Bitstamp (via response `timestamp`, UNIX seconds) and Coinbase (via response `time`, ISO-8601) now publish per-pair upstream observation times and stamp `observedAtMode = "upstream"`. Bitstamp and Coinbase rows are rejected before hard-market admission when their upstream timestamps are stale, missing, invalid, or future-skewed beyond the shared freshness ceiling.
- **Pyth confidence weighting:** Pyth is no longer dropped abruptly at modest confidence widths. Medium-confidence prints are now downweighted smoothly, and only very wide confidence intervals are excluded entirely.
- **Jupiter Price API V3 freshness semantics:** Jupiter fallback accepts documented sparse no-quote rows as healthy empty coverage. Rows that carry a quote still need `usdPrice`, `decimals`, `blockId`, and optional `priceChange24h` / `liquidity`. `blockId` is checked against a fresh Solana `getSlot` reference fetched sequentially from a bounded three-endpoint RPC roster; a blocked primary falls through, while complete slot-reference failure rejects the quotes. Optional `createdAt` is not used for freshness, and optional `liquidity` is treated as an extra guard only when present.
- **Chainlink reference overlay:** `worker/src/cron/sync-fx-rates.ts` overlays curated Chainlink EUR/USD, GBP/USD, JPY/USD, XAU/USD, and XAG/USD feeds onto the shared `fx-rates` cache when their on-chain quotes are fresh and within 5% of the current reference stack. The worker now tries dedicated dRPC `eth_call` transport for the supported Base / Ethereum / Arbitrum feeds before falling back to the shared chain RPC pool and then the existing Etherscan V2 proxy path, so the Chainlink overlay can still recover when earlier quarter-hour jobs have already saturated the shared Alchemy/public RPC budget. Frankfurter / secondary FX APIs and `gold-api.com` remain fallback sources for uncovered or divergent feeds, and commodity pegs now also have a stablecoins-cache peer-median recovery path when the anonymous metals endpoint is unavailable from Workers. These independent recovery probes still run during cached-fallback FX runs so a stale intraday subset can recover without waiting for the full Frankfurter stack.
- **Secondary + tertiary FX fallbacks:** `sync-fx-rates.ts` compares the jsDelivr `@fawazahmed0/currency-api` `@latest` mirror, the direct `latest.currency-api.pages.dev` endpoint, and the date-pinned jsDelivr package for the current UTC date, then persists the fresher valid dated snapshot. CNH/RUB/UAH/ARS/KGS/NGN/XOF/VND always use this daily secondary path, and when Frankfurter is unavailable the same feed can temporarily backstop the wider fiat FX set. If both Frankfurter and the secondary mirrors are unavailable, the worker falls through to ExchangeRate-API's daily USD snapshot before dropping into cached-fallback mode.
- **FX freshness semantics:** `fx-rates-meta` tracks usable cache freshness (`usableSyncAt`) separately from per-peg source freshness metadata (`sourceUpdatedAtByPeg`, `sourceCadenceByPeg`, `sourceDateByPeg`). Intraday sources (`gold-api.com`, stablecoins-cache commodity peer medians, pure realtime recoveries) still age on wall-clock seconds, while daily sources (ECB/Frankfurter and the secondary CNH/RUB/UAH/ARS/KGS/NGN/XOF/VND feed) are evaluated against their expected publish cadence instead of a naive 6-hour clock. When OXR or Chainlink overlays refine an already-fresh daily fiat reference, the worker now preserves that daily cadence/date metadata instead of downgrading the peg to synthetic intraday-only provenance. When the live FX fetches fail, same-day live fiat references can therefore be carried forward against their daily publish cadence rather than aging immediately into false intraday staleness, and commodity references can recover from the fresh `stablecoins` cache instead of inheriting stale metals timestamps. Cached fallback runs are reserved for cases where the job cannot refresh a live source and the carried-forward daily references are no longer cadence-valid, so non-USD and commodity validation cannot silently look fresh after a real upstream aging event. If a cached-fallback run later refreshes fresh full-set fiat coverage through OXR or Chainlink-backed overlays, the job now promotes itself back to `live` immediately instead of continuing to accumulate fallback streaks on already-recovered rates.
- **Direct native-peg live-publication guard:** supported non-USD fiat assets with reliable CoinGecko native pairs can derive a fresh `native quote × FX reference` USD mark during post-enrichment. ARS and NGN are now included where CoinGecko exposes direct native pairs; KGS and XOF remain on the secondary daily FX mirror and deterministic validation bounds because CoinGecko does not currently expose usable `kgs` or `xof` simple-price quotes. That native-implied mark can correct materially divergent weak or mixed-source live USD publications and can also fill a missing live price for supported assets when the derived mark passes the shared publication guards.
- **Native lane scope:** `coingecko-native-implied` is a fresh fallback-validation lane, not a second replay-safe primary consensus source. Pharos can publish it for the current run when it is the best validated live mark, but it is not written into `price_cache` for later replay continuity.
- **Historical native-peg replay:** supported non-USD fiat backfills now prefer direct CoinGecko native-fiat history and compare that series to the native `1.0` peg before falling back to USD-denominated market history. In that native-fiat mode, replay now uses daily points plus a two-point confirmation window across 36 hours so thin hourly native prints cannot manufacture long false depeg streaks during repair.
- **Peg-aware validation bounds:** USD and fiat FX pegs with usable references share the same upside tolerance ratio, so non-USD fiat prints are capped at `1.19 × referencePrice` instead of the broader commodity band. Gold and silver references keep the existing `2 × referencePrice` upper band, with `commodityOunces` scaling for fractional tokens. Authoritative downside modes still keep their explicit lower-bound relaxation.
- **GeckoTerminal probe transport:** `worker/src/lib/geckoterminal-price-probe.ts` now prefers authenticated CoinGecko `/onchain/networks/.../tokens/.../pools` when `COINGECKO_API_KEY` is configured and the chain has a CoinGecko on-chain network mapping. If that path yields no usable pool, the worker falls back to the public GeckoTerminal token-pools endpoint.
- **GeckoTerminal probe estimator:** GT no longer trusts a single highest-TVL pool. It collapses usable pools to one TVL-weighted-median price per protocol, then uses the TVL-weighted median across those protocol groups as the injected `geckoterminal` source. This reduces estimator noise from repeated same-protocol pools.
- **GeckoTerminal probe breaker semantics:** `worker/src/lib/geckoterminal-price-probe.ts` treats token-level lookup misses (`404` / `422`) as expected coverage gaps, not source outages. The `geckoterminal-probe` circuit breaker only trips on hard upstream failures such as transport errors, rate limits, or server-side failures, and each serialized probe request now gets one retry before a hard failure is recorded. Thin assets without indexed GT pools therefore do not poison the source-wide breaker state, and a single transient `429` no longer guarantees another 30-minute open interval.
- **GeckoTerminal probe self-budget:** the serialized GT cross-check now enforces a `90 second` wall-clock budget per `sync-stablecoins` run, dynamically clipped when earlier stages run long so the job keeps a `90 second` tail before its outer cron timeout. Remaining probeable candidates are skipped with `budgetExhausted` / `budgetSkipped` metadata instead of letting the optional soft-source pass consume the full quarter-hour sync timeout.
- **GeckoTerminal probe observability:** `sync-stablecoins` now persists a `gtProbe` block into cron metadata, including `updatedCount`, coverage misses, upstream errors, public fallbacks, per-transport attempt counts for CoinGecko on-chain vs public GeckoTerminal, and budget flags (`budgetExhausted`, `budgetSkipped`). Operators can inspect those fields in `cron_runs.metadata` without relying on live Wrangler tails.
- **Circuit-breaker accounting:** for Pyth and RedStone, a transport-successful request that returns zero usable prices is still recorded as an unsuccessful outcome for breaker state. This avoids treating empty responses as healthy data.
- **CoinGecko ticker breaker semantics:** `worker/src/lib/cg-ticker.ts` still rejects stale or otherwise unusable Kinesis ticker rows for price publication, but the `coingecko-ticker` circuit breaker now tracks endpoint availability rather than row freshness. A successful `/coins/{id}/tickers` response with only stale/unusable USD rows no longer opens the source breaker; only transport failures or non-OK responses count as breaker failures.
- **Curve on-chain sanity bound:** Implied prices from `get_dy` calls are capped at `< 10,000` (to accommodate commodity tokens like PAXG/XAUT at ~$2,900).
- **Curve on-chain block-timestamp freshness:** Curve on-chain reads now pin `get_dy` calls to a single block number fetched up front and stamp each priced pair with that block's timestamp (`observedAtMode = "upstream"`). Runs older than 300 s of wall-clock time vs the block timestamp are rejected as `upstream-error` under the same 300-second ceiling shared with `curve-oracle`.
- **Curve on-chain route resolution:** Curve configs declare whether a route is `direct`, `one-hop`, `trusted-wrapper`, or explicit `chained-hop`. Hop routes multiply by the resolved USD price of their via asset rather than assuming a `$1` reference. Chained hops must opt in with `routeType = "chained-hop"` and `maxHopDepth > 1`; missing dependencies, route-shape mismatches, and cycles fail closed.
- **Curve oracle staleness guard:** The `curve-oracle` voice (crvUSD `PriceAggregator.price()` EMA) is fetched against a resolved block number and its block timestamp is used to stamp `observedAt`. Reads with a block timestamp older than 5 minutes (`CURVE_ORACLE_MAX_STALENESS_SEC = 300`) are rejected before entering primary consensus, so a stale-replica RPC cannot single-source publish an EMA read minutes behind chain head. `curve-oracle` now uses its own `CIRCUIT_SOURCE.CURVE_ORACLE` breaker separately from the per-pool `curve-onchain` breaker, so an aggregator outage does not suppress per-pool Curve reads and vice versa.
- **Live-reserve NAV telemetry:** Primary consensus can admit NAV prices already fetched by live-reserve adapters when the `reserve_composition` row is matched to `reserve_sync_state.last_success_at`. `chainlink-nav` and `superstate-liquidity` rows must expose a positive `metadata.navPerToken` and verified `sourceTimestamp` / `oracleUpdatedAt`. USD NAVs publish directly; non-USD NAVs first multiply by fresh or static FX references from the shared validation cache.
- **Exact-address price augmentation:** after the normal primary provider fetches, Pharos can query targeted exact-address providers for assets whose previous publication had fewer than 3 consensus sources, no price, or low/fallback confidence. Missing prices are prioritized first, then low-depth priced assets by circulating materiality. The current augmentation providers are DexScreener exact token endpoint, DexPaprika, CoinGecko Onchain, Alchemy Prices, Moralis token prices, and Birdeye for Solana. Targets come only from canonical `asset.address`, `contracts`, or `tradedContracts` metadata and are matched by exact chain+address; symbol search is retired. Provider order and each provider's target queue advance through durable cursors, so bounded request caps cannot permanently favor the same prefix. The public DexScreener address lane is opt-in, capped at one 30-address batch per stablecoin sync, and stops immediately on hard upstream refusal, so a Cloudflare/WAF rate-limit response cannot fan out into the remaining optional batches. Birdeye uses the Standard-compatible Solana `price` endpoint for up to 10 targeted requests per sync; null or missing rows are treated as coverage misses, while HTTP `429` or provider-wide quota/compute-unit exhaustion stops the remaining batch immediately and trips the `birdeye-prices` breaker. DexPaprika caches deterministic token-detail `404` results for 24 hours, stops the run on the first `429`, and suppresses later runs through the bounded `Retry-After` window. Request-cap, negative-cache, quota, and rate-limit diagnostics stay explicit in cron metadata.
- **Address-provider enablement:** unset `ADDRESS_PRICE_PROVIDERS_ENABLED` auto-enables DexPaprika plus any keyed provider with a configured credential (`COINGECKO_API_KEY`, `ALCHEMY_API_KEY`, `MORALIS_API_KEY`, `BIRDEYE_API_KEY`). Operators can set a comma-separated allowlist or `none` to disable the group. DexScreener address augmentation is no longer part of the unset default because the public `/tokens/v1/{chain}/{addresses}` endpoint can WAF-rate-limit Cloudflare Worker traffic at the quarter-hourly cadence; include `dexscreener-address` explicitly only when accepting that opportunistic behavior. Key-backed providers without credentials are skipped rather than attempted. Moralis uses 100-token batches but is capped at 3 requests per 15-minute sync so the default cadence stays inside Moralis's free 40k CU/day envelope; operators should exclude `moralis-address` from the allowlist when the account quota is exhausted or intentionally reserved for other jobs.
- **Address-provider trust semantics:** exact-address augmentation sources enter primary consensus as weight-1 soft fallback/search-family sources. They can improve source depth and corroborate normal publication, but they are non-replay-safe, non-search-derived, and non-depeg-authoritative on their own.
- **Weak address-provider depeg quarantine:** fixed-peg prices from fallback/search-family address providers must stay within 500 bps of the peg unless a stronger source corroborates the move. Rejected address-provider candidates fall through to the later enrichment passes, so a weak CoinGecko Onchain address print cannot suppress a validated DefiLlama exact-contract quote.
- **Binance host cascade and environment availability:** Binance ticker fetches no longer retry the same host on server-side failures. On HTTP 5xx, 429, or Worker-side 403/451, the fetcher short-circuits to the next host (`data-api.binance.vision` -> `api.binance.com`) instead of consuming the Retry-After budget against a host that is already failing. When every host returns `403`/`451`, durable runtime state suppresses the predictable environment block for six hours, then permits one probe host. One invocation-scoped promise is shared by primary consensus and pending-depeg confirmation, so the same stablecoin run cannot request Binance twice. A successful probe clears the block; network exceptions remain ordinary provider failures. Intra-host retries are reserved for transient network exceptions where the host itself has not answered.
- **Direct-API DEX bridge:** per-protocol DEX prices are aggregated before primary-consensus admission. The currently registered promoted DEX sources are Fluid, Balancer, Curve, Uniswap V3, Uniswap V4, Raydium, Orca, Meteora, PancakeSwap, Aerodrome Slipstream, and Velodrome Slipstream, so each of those protocols can contribute at most one elevated source per asset.
- **DEX bridge overlap guard:** when at least one promoted per-protocol DEX bridge candidate exists for an asset, the overlapping `dex-promoted` aggregate is withheld so the same bridge observation family cannot self-confirm through a rejected protocol lane plus its aggregate. A valid aggregate `dex-promoted` source can enter as the soft DEX fallback only when no promoted protocol candidate exists for the asset and the Binance overlap guard is clear.
- **Promoted DEX corroboration gate:** a lone promoted DEX protocol is admitted only when no non-DEX source exists, or when a hard market/oracle/protocol source agrees within the live threshold. Two or more promoted DEX protocols are admitted as candidate sources; consensus then determines agreement.
- **DEX bridge freshness preservation:** primary pricing now keeps the per-source `updatedAt` values already stored inside `dex_prices.price_sources_json` when rebuilding promoted DEX sources. It only falls back to the row write time when a source-specific timestamp is missing or invalid, so freshness is no longer flattened across the entire bridge row. Each promoted protocol lane is then freshness-checked independently before candidate admission, so a fresh parent `dex_prices` row cannot carry a stale or future-skewed protocol lane into consensus.
- **DEX bridge source explainability:** stale `dex_prices.price_sources_json` rows, malformed source snapshots, missing pricing-source registry mappings, below-threshold protocol sources (`< $50K` TVL), and promoted DEX candidates rejected for lacking corroboration are logged with structured reasons. Published DEX-inclusive stablecoin rows can also carry `priceSourceConfidenceProfile` with active protocol-lane count, freshest DEX lane age, and whether the price relies only on the aggregate `dex-promoted` lane.
- **Retained-pool DEX bridge publication:** `dex_prices` is now rebuilt from the final retained priced-pool surface after dedupe, caps, and scoring filters. Raw discovery observations that never survive retained-pool admission can no longer leak into promoted DEX bridge sources or `dexPriceCheck`.
- **Direct-API fetch hard stops:** direct DEX API fetchers run in bounded parallelism (`2` independent protocol fetches at a time), share a `15 s` request timeout policy, and use deterministic pagination caps with resume markers. Orca cursor requests retain the same TVL sort and minimum-TVL filter as the refreshed head, preventing resumed scans from drifting into zero-TVL inventory. A provider that returns usable rows plus partial errors remains visible through fallback and source-warning diagnostics but is not counted as a failed source; `failedSources` is reserved for providers that return no usable response. Raydium and Orca no longer stop on a single below-threshold or empty-eligible page when upstream sort semantics drift; they record partial/degraded states instead of silently truncating.
- **Direct-API merge explainability:** direct-API pools are unit-normalized before merge, invalid TVL/token-unit rows are dropped centrally, exact pool ids are canonicalized before dedupe, and merge metadata counts accepted protocol-chain lanes plus exclusions for invalid units, untracked tokens, TVL thresholds, sanity caps, and duplicate identity conflicts. Staged-pool merge also persists skip dimensions by protocol, chain, reason, threshold, and conflict for cron metadata/alerts.
- **Direct-API tracked quote pricing:** direct-API pair conversion now prefers only fresh authoritative tracked stablecoin prices from the cached stablecoins payload for quote legs before falling back to peg references. Weak or stale tracked prices no longer feed back into the DEX bridge, and unknown addressed `USDC`/`USDT`-style tokens still do not get unconditional `$1` treatment.
- **DEX token matching and dedupe:** direct-API, staged, and fallback DEX pools resolve tracked assets by `chain + address` first. If an upstream token already carries an address and that address is unknown to the canonical registry, it is dropped instead of falling back to symbol; symbol fallback is reserved for addressless rows and must still be unique within the same chain. Repeated observations of the same physical pool are collapsed by exact pool id or a conservative derived identity before they enter `dex_prices`.
- **Direct-API pair conversion:** non-USD tracked stablecoin pairs use peg-reference-aware conversion rather than treating every tracked stablecoin counterparty as `$1`.

These normalization rules live in code because they are provider quirks, not business-level scoring decisions.

---

## Authoritative Overrides

After market/oracle consensus, the provider registry under `worker/src/lib/authoritative-price-sources/` can replace the chosen live price for specific redeemable assets whose executable value is better represented by direct protocol redemption, or by an instantly redeemable tracked base asset, than by secondary-market liquidity.

### Current Scope

| Asset                    | Source                                                                          |
| ------------------------ | ------------------------------------------------------------------------------- |
| `cusd-cap`               | Cap `getBurnAmount(address,uint256)`                                            |
| `iusd-infinifi`          | infiniFi `RedeemController.receiptToAsset(uint256)`                             |
| `usdai-usd-ai`           | inherits tracked `pyusd-paypal` pricing as a redeemable PYUSD wrapper           |
| `iusd-initia`            | inherits tracked `ausd-agora` pricing as an AUSD-backed Initia wrapper          |
| `usdcx-movement`         | inherits tracked `usdc-circle` pricing as a Circle xReserve-backed USDC wrapper |
| `m-m0`                   | inherits tracked `wm-m0` pricing as the underlying M0 unit                      |
| `usdk-kast`              | inherits fresh tracked `wm-m0` pricing as a Solana M0 extension unit            |
| `xo-exodus`              | inherits fresh tracked `wm-m0` pricing as a Solana M0 extension unit            |
| `usdn-noble`             | inherits fresh tracked `m-m0` pricing as an M0-backed rebasing Noble unit       |
| `usdnr-nerona`           | inherits tracked `wm-m0` pricing as an M0 extension unit                        |
| `weusd-picwe`            | inherits tracked `usdc-circle` pricing with PicWe's documented 1% redemption-fee haircut |
| `sofid-sofi`             | direct USD redemption-par reference for observable on-chain supply              |
| `usbd-bima`              | direct USD redemption-par reference for observable DefiLlama supply             |
| `usdq-quill`             | direct USD redemption-par reference for observable DefiLlama supply             |
| `chfau-allunity`         | direct CHF redemption-par reference using fresh/static CHF/USD FX               |
| `cadd-cad-digital`       | direct CAD redemption-par reference using fresh/static CAD/USD FX               |
| `jpym-mento`             | direct JPY redemption-par reference using fresh/static JPY/USD FX               |
| `zarm-mento`             | direct ZAR redemption-par reference using fresh/static ZAR/USD FX               |
| `xofm-mento`             | direct XOF redemption-par reference using fresh/static XOF/USD FX               |
| `susdt-spark`            | ERC-4626 `convertToAssets(1 share)` × tracked `usdt-tether` price               |
| `susdc-spark`            | ERC-4626 `convertToAssets(1 share)` × tracked `usdc-circle` price               |
| `steakusdt-steakhouse`   | ERC-4626 `convertToAssets(1 share)` × tracked `usdt-tether` price               |
| `steakusdc-steakhouse`   | ERC-4626 `convertToAssets(1 share)` × tracked `usdc-circle` price               |
| `bbqusdc-steakhouse`     | ERC-4626 `convertToAssets(1 share)` × tracked `usdc-circle` price               |
| `srusde-strata`          | ERC-4626 `convertToAssets(1 share)` × tracked `usde-ethena` price               |
| `gtusdc-gauntlet`        | ERC-4626 `convertToAssets(1 share)` × tracked `usdc-circle` price               |
| `gtusdcp-gauntlet`       | ERC-4626 `convertToAssets(1 share)` × tracked `usdc-circle` price               |
| `yvusdc-yearn`           | ERC-4626 `convertToAssets(1 share)` × tracked `usdc-circle` price               |
| `autousd-auto-finance`   | ERC-4626 `convertToAssets(1 share)` × tracked `usdc-circle` price               |
| `eearn-ember`            | ERC-4626 `convertToAssets(1 share)` × tracked `usdc-circle` price               |
| `savusd-avant`           | ERC-4626 `convertToAssets(1 share)` × tracked `avusd-avant` price               |
| `susn-noon`              | ERC-4626 `convertToAssets(1 share)` × tracked `usn-noon` price                  |
| `syzusd-yuzu`            | ERC-4626 `convertToAssets(1 share)` × tracked `yzusd-yuzu` price                |
| `stkgho-umbrella-aave`   | ERC-4626 `convertToAssets(1 share)` × tracked `gho-aave` price                  |
| `syusd-aegis`            | ERC-4626 `convertToAssets(1 share)` × tracked `yusd-aegis` price                |
| `sbold-k3-capital`       | ERC-4626 `convertToAssets(1 share)` × tracked `bold-liquity` price              |
| `ybold-yearn`            | ERC-4626 `convertToAssets(1 share)` × tracked `bold-liquity` price              |
| `sgho-aave`              | Aave legacy savings `previewRedeem(1 share)` × tracked `gho-aave` price         |
| `aa-falconx-mev-capital` | Idle CDO `virtualPrice(address tranche)` × tracked `usdc-circle` price          |

When a live override validates successfully, direct protocol/NAV quotes and high-confidence tracked-base inheritance are written with:

- `priceSource = "protocol-redeem"`
- `priceConfidence = "high"`

Scoped tracked-base inheritance from a fresh replay-safe single-source parent keeps the parent `priceSource` and
`priceConfidence = "single-source"` so downstream publication guardrails continue to see the inherited quote's soft
upstream provenance instead of treating it as depeg-authoritative protocol redemption.

For tracked-base inheritance paths, the authoritative layer does not query a bespoke contract path; it inherits the tracked parent asset's live price and historical replay because Pharos models the child as an instantly redeemable wrapper or extension of that parent rail.

Live tracked-base and NAV-wrapper inheritance only promotes parent prices that are replay-safe and either
high-confidence or explicitly authoritative themselves. For scoped M0 extension assets, a fresh replay-safe single-source
M0 parent is also admissible, but it is preserved as a single-source child price with the parent source instead of
being upgraded into `protocol-redeem` high-confidence provenance. Low-confidence, fallback, cached, stale-sync,
single-source stale, or provenance-less parent prices are skipped. For high-confidence composite parents, a fresh same-run `priceSyncedAt` can satisfy the live inheritance
freshness check when the composite's single displayed `observedAt` is older than one short-window component source; this
preserves source-specific admission from the parent run without falsely rejecting mixed-cadence composites such as
USDC. When inheritance is accepted, the override carries the parent source, confidence, observed-at timestamp,
observed-at mode, and replay-safety status for diagnostics.

Current tracked-base inheritance paths are:

- `usdai-usd-ai -> pyusd-paypal`
- `iusd-initia -> ausd-agora`
- `usdcx-movement -> usdc-circle`
- `m-m0 -> wm-m0`
- `usdk-kast -> wm-m0`
- `xo-exodus -> wm-m0`
- `usdn-noble -> m-m0`
- `usdnr-nerona -> wm-m0`
- `weusd-picwe -> usdc-circle` with a 1% redemption-fee haircut

This prevents thin secondary-market child-token prints, or missing child-market coverage, from dragging PegScore away from the executable value of the tracked parent rail.

Scoped redemption-par references cover active assets with observable runtime supply and a source-reviewed primary redemption route, but no dependable current market quote. USD routes publish nominal USD parity through `protocol-redeem`; fee and capacity risk remains modeled in the redemption-backstop methodology rather than being hidden inside the token price. Non-USD routes must have a fresh or static FX reference for the peg currency before live publishing, and fall back to normal market/native-peg history until historical FX replay exists. The current scoped set is:

- `sofid-sofi` at USD parity
- `usbd-bima` at USD parity
- `usdq-quill` at USD parity
- `chfau-allunity` at CHF parity converted through the live CHF/USD reference
- `cadd-cad-digital` at CAD parity converted through the live CAD/USD reference
- `jpym-mento` at JPY parity converted through the live JPY/USD reference
- `zarm-mento` at ZAR parity converted through the live ZAR/USD reference
- `xofm-mento` at XOF parity converted through the live XOF/USD reference

These authoritative overrides are pre-applied before fallback enrichment and then applied again after the GeckoTerminal single-source probe. The early pass keeps known redeemable wrappers and extension assets out of unnecessary fallback-source probes, while the final pass preserves the existing rule that a later market cross-check cannot overwrite a validated redemption price.

Live parent-derived overrides normally require a replay-safe parent source. A narrow audited exception lets `sbold-k3-capital`, `ybold-yearn`, `syusd-aegis`, `usdk-kast`, and `xo-exodus` use a fresh high-confidence same-run parent consensus even when that parent composite includes address-derived providers; `usdk-kast`, `xo-exodus`, and `usdn-noble` may also inherit a fresh replay-safe single-source M0 parent. Cached parents are still rejected, and historical replay still uses only replay-safe provider paths.

The same registry also supports historical replay for backfills where a provider can replay the same source safely, so admin rebuilds do not silently downgrade back to weaker market sources.

`crvusd-curve` no longer lives in the authoritative-override registry. Its Curve `PriceAggregator.price()` quote is now injected into primary consensus as the `curve-oracle` source alongside the other live pricing voices.

---

## Fallback Enrichment

Assets still missing prices after primary consensus run through `enrichMissingPrices()`:

1. **Pass 1:** DefiLlama `coins.llama.fi` by canonical tracked contract identity, using the upstream row address when present and falling back to curated tracked `contracts` metadata when the upstream row is addressless. Accepted quotes must carry a fresh upstream timestamp, confidence, and matching symbol, then pass shared peg-aware bounds before they can resolve the asset. Schema-invalid OK responses record `dl-coins` breaker failures instead of being treated as healthy empty coverage.
2. **Pass 1b:** alternate tracked deployment fallback via DefiLlama; only known tracked deployments are probed, never synthetic same-address cross-chain identities. The same timestamp, confidence, symbol, and peg-aware gates apply.
3. **Pass 2:** CoinMarketCap stablecoins category batch (`v1/cryptocurrency/category?id=604f2753ebccdd50cd175fc1&limit=300&convert=USD`) — prefers `cmcSlug`-based matching over symbol, and symbol fallback is only allowed when the tracked symbol is unique. Each accepted quote preserves `quote.USD.last_updated` as upstream provenance and must be fresh; schema-invalid OK responses, malformed JSON, non-OK responses, and apparent category truncation record CMC breaker failures. Rate-limited to 1 call/hour via D1 cache, including 429 responses after the provider `Retry-After` delay is honored (see data-pipeline.md)
4. **Pass 3:** Jupiter Price API for tracked Solana mints — calls the official V3 gateway with `JUPITER_API_KEY` when configured, accepts documented sparse no-quote rows as healthy empty coverage, accepts quoted payloads without `liquidity`, checks `blockId` freshness against a sequential three-endpoint Solana current-slot fallback when a quote exists, applies optional liquidity gating only when liquidity is present, and remains subject to peg-aware validation. In addition to missing-price recovery, the pass can append `jupiter` as a bounded soft candidate for low-depth Solana assets when the Jupiter quote agrees with the current primary price; it does not replace the selected price or add Jupiter to `agreeSources`.
5. **Pass 4:** DexScreener exact token-address pool lookup when chain+address are available. Exact-address recoveries publish `dexscreener-exact`. The older last-resort symbol-search path is retired, so addressless assets no longer call `/latest/dex/search` and remain explicitly missing unless another fallback resolves them. The pass walks the full sorted missing set and stops after 10 actual DexScreener exact-address requests. The legacy `dexscreener-search` breaker can still appear in health payloads while stale production state ages out, but new sync runs recover it through the no-candidates path instead of probing the search endpoint.
6. **Pass 5:** CoinGecko low-volume allowlisted fallback for selected tracked assets with an audited current CoinGecko row but no accepted price. It currently targets `mnee-mnee`, `veur-vnx`, `usdn-smardex`, `cadm-mento`, `usp-pareto-credit`, `tryb-bilira`, `btcusd-btcfi`, `dllr-sovryn`, `ebusd-ebisu`, `gbpm-mento`, `audm-mento`, `copm-mento`, and `chfm-mento`; it runs after DefiLlama contract, CMC, Jupiter, and DexScreener recovery fail and only fills still-missing price fields with `priceConfidence: "fallback"`.

The DefiLlama `/coins` contract-address fallback, supplemental CoinGecko-id mirror fetches, and the DexScreener lookups used outside primary consensus (the `dex-liquidity` and `dex-discovery` crawls) now gate on and record against their own circuit breakers. `CIRCUIT_SOURCE.DL_COINS` wraps the `coins.llama.fi/prices/current/...` path so a DL regional outage opens the breaker instead of hammering the host, `CIRCUIT_SOURCE.DL_PROTOCOLS` wraps supplemental gold protocol mcap/TVL fetches as well as DEX protocol reads, `dexscreener-prices` wraps only the exact-address stablecoin pricing lane, and `dexscreener-liquidity` wraps optional DEX liquidity/discovery pool lookups. Discovery and liquidity fallback record aggregate DexScreener outcomes, so a handful of optional token-target failures inside a partially successful crawl do not count as multiple source-wide failures or poison stablecoin price fallback availability.

Tracked DefiLlama rows that collapse to zero supply are repaired before pricing when the row has no usable chart-history repair or its chart-history value is below the tracked repair floor. The repair remains scoped to source-reviewed deployments for CADD and the Mento JPY/ZAR/XOF stables, reads every configured chain successfully before publishing, converts total supply through the current fresh/static FX reference, and tags the result `supplySource = "onchain-total-supply"`.

Operationally, missing-price enrichment runs before the slower GeckoTerminal soft-source cross-check so recovery of unpriced assets stays on the critical path; the GT probe still reruns consensus later for weak CG / DL-list outcomes and self-stops once its clipped 90-second budget is exhausted. Protocol overrides run under a 10-second wall-clock budget, and external live RPC-backed `protocol-redeem` providers share a grouped breaker. Local par and inherited tracked-base overrides are attempted before RPC-backed providers; ERC-4626 NAV wrappers run before lower-priority RPC-backed override families; and missing-price candidates are prioritized within each provider tier so budget exhaustion repairs coverage before refreshing already-priced wrappers.

Provider attempt diagnostics for fallback providers are persisted into `sync-stablecoins` cron metadata. Those diagnostics include the sanitized endpoint, HTTP status when available, candidate/response/match counts, parse or rejection reason counts, and short non-OK snippets so operators can distinguish provider transport failures from schema drift, rejected quotes, and successful responses that simply carry no usable tracked prices.

DIA is currently research-only. `npm run audit:dia-provider -- --input agents/source-depth-baseline-YYYY-MM-DD.json` probes DIA's exact-address `GET /v1/assetQuotation/{blockchain}/{address}` endpoint for below-target rows and records hit rate, timestamp quality, source metadata, and agreement vs the current Pharos price. The probe does not publish prices, change `consensusSources`, alter circuit state, or participate in depeg confirmation. Any future production integration requires false-positive review, capacity/circuit approval, and a methodology update.

Jupiter fallback uses the official `https://api.jup.ag/price/v3` gateway and sends `x-api-key` when `JUPITER_API_KEY` is configured. The previous Lite gateway is no longer used after Worker egress received repeated Cloudflare 403 block pages from that host. Quote freshness uses one cached current-slot result per pass and tries `api.mainnet-beta.solana.com`, `api.mainnet.solana.com`, and `solana-rpc.publicnode.com` sequentially before failing closed.

Binance ticker fetches try the market-data mirror first (`data-api.binance.vision`) and then fall back to the main public API host (`api.binance.com`) before recording the source as failed. Both hosts use the same tracked `USDTUSD` / `USDCUSD` market mapping.

If every attempted Binance host returns a Worker-side 403/451 block, Pharos records the diagnostics and treats Binance as a no-contribution provider block rather than a source outage. Binance contributes zero prices in that state; it does not keep the source-wide breaker open.

When authoritative pricing removes every Jupiter fallback candidate, the run closes stale-open `jupiter-prices` breaker state without making a provider health request. Future eligible Solana fallback candidates still use the normal circuit breaker and diagnostics path.

### CoinGecko low-volume lane

Some tracked stablecoins trade at low enough volume that CoinGecko's upstream `last_updated_at` for the ticker sits hours-to-days behind real time. The strict 15-minute freshness gates used elsewhere reject these prices, leaving the assets with `priceSource: "missing"` even though CoinGecko has a valid USD quote.

`fetchFiatCoinGeckoTokens` in `worker/src/cron/sync-stablecoins/supplemental-assets/fiat-cg.ts` runs a relaxed fallback for CoinGecko-only supplemental assets:

1. Try `resolveSupplementalPrice` first (the standard 15-minute gate).
2. If there is no `geckoId` but the asset has one unambiguous supported supply contract, try the same DefiLlama coins endpoint with an exact `chain:contract` key. Accepted quotes must include a matching DefiLlama symbol, confidence of at least `0.8`, a fresh upstream timestamp, and pass the shared peg-aware reasonableness bounds before publishing as `source: "defillama-contract"` or normalizing the same on-chain total-supply fallback.
3. If that returns null but `cgData[geckoId].usd` is a positive finite number, build a resolution with `source: "coingecko-low-volume"`, `priceConfidence: "fallback"`, and `priceObservedAtMode: "upstream"` when CG returned `last_updated_at` (otherwise `"local_fetch"`).

The fallback enrichment pipeline also has a narrow `coingecko-low-volume` pass for selected tracked assets with audited usable CoinGecko rows. That pass runs only after DefiLlama contract, CMC, Jupiter, and DexScreener fallback recovery fail. It is explicitly allowlisted for `mnee-mnee`, `veur-vnx`, `usdn-smardex`, `cadm-mento`, `usp-pareto-credit`, `tryb-bilira`, `btcusd-btcfi`, `dllr-sovryn`, `ebusd-ebisu`, `gbpm-mento`, `audm-mento`, `copm-mento`, and `chfm-mento`; it preserves the row's admitted supply source and can only fill missing price fields, so it cannot overwrite a price that primary consensus or an earlier fallback already accepted.

The lane is registered in `shared/lib/pricing-source-registry-aggregators.ts` with a 7-day `maxTrustedAgeSec` and `defaultWeight: 0.5`. Downstream treatment is intentionally weaker than primary `coingecko`:

- `priceConfidence: "fallback"` flows into `priceValidationModeForAsset → "fallback_enrichment"` and `classifyPrimaryDepegTrust → "confirm_required"`, so the low-volume lane publishes for display but cannot single-handedly open, extend, or confirm a depeg alert.
- The new source belongs to the same CG lineage family in `worker/src/lib/price-publish-policy.ts` and `worker/src/lib/depeg-trust-policy.ts`, so severe-downside corroboration still requires an independent non-CG source.
- Fallback-enrichment recoveries use `priceConfidence: "fallback"`, so they are not written to the replay-safe `price_cache`.

Strict primary CoinGecko admission everywhere else is untouched.

### Zephyr Scanner supplemental lane

`zsd-zephyr-protocol` and `zys-zephyr-protocol` are native Zephyr-chain assets, so Pharos cannot derive supply from a supported EVM/Solana contract. The supplemental fiat-CoinGecko path fetches `https://zephyrprotocol.com/api/v1/livestats` once per run when either asset is active:

- ZSD uses official `zsd_circ` for circulating supply and keeps CoinGecko as the preferred market price when available; if CoinGecko is missing, the protocol's reported `zsd_price` is used as a scoped `zephyr-scanner` fallback.
- ZYS uses official `zys_circ` and `zys_price` because neither CoinGecko nor DefiLlama exposes the yield-share wrapper.
- The emitted `zephyr-scanner` pricing source is registered as protocol telemetry with no dedicated circuit breaker and is only reachable from this narrow supplemental path.

The enrichment path is intentionally narrower than primary pricing:

- it exists to fill holes, not overrule good consensus
- fallback results are validated before they can claim an asset and before they enter `price_cache`
- replay cache only stores replay-safe prices (no `low`, no `fallback`, no fragile search-derived sources), expires after 6 hours, and now preserves source/confidence/timestamp/source-list provenance
- previous-trusted continuity now merges the last authoritative stablecoins publication with fresh replay-safe `price_cache` rows, so a temporarily `low` or unusable publication does not make an already-confirmed severe depeg forget its prior corroborated state on the next run
- replay-safe cached fallback is applied to any asset that is still missing after post-validation, including assets that became missing later in the same sync run because a current-run candidate was rejected
- invalid or severely depegged single-source fallback prints are dropped instead of poisoning later runs

### Timestamp Semantics

- `priceObservedAt`: effective observation time attached to the selected source price
- `priceObservedAtMode`: freshness provenance for `priceObservedAt`
- `priceObservedAtMode = "upstream"`: `priceObservedAt` came from source-native freshness metadata
- `priceObservedAtMode = "local_fetch"`: the source exposed no trustworthy upstream observation timestamp, so Pharos uses local fetch time instead
- `priceObservedAtMode = "unknown"`: legacy or carried-forward metadata did not preserve freshness provenance explicitly
- `priceSyncedAt`: when Pharos selected and wrote the price during the current sync
- `priceUpdatedAt`: compatibility alias for the effective observation timestamp, preserved so existing consumers do not interpret sync-write time as source freshness
- high-confidence cluster labels can describe multiple agreeing sources even when the published price is the cluster median rather than any one constituent source price

### Downstream Trust Semantics

- Source labels are normalized through the pricing-source registry before replay safety, pool-challenge eligibility, fallback-only classification, severe-downside corroboration, and depeg-authority checks run. Composite labels such as `coingecko+geckoterminal` are expanded into their component sources instead of being treated as unknown standalone sources.
- Every registered source declares a `depegSourceFamily`. CoinGecko-derived sources collapse to the `coingecko` family, DefiLlama list/detail/contract sources collapse to the `defillama` family, hard market/oracle/protocol sources keep provider-specific families, and promoted DEX lanes keep protocol-specific `dex:*` families. This family map is the durable policy for independent severe-downside corroboration and downstream depeg confirmation.
- Fallback/search lanes remain non-authoritative even when their source labels appear inside composite strings. `coinmarketcap`, `defillama-contract`, and CoinGecko mirror/low-volume-style sources are treated as list aggregators for independence checks; Jupiter, DexScreener exact/search/address, DexPaprika, CoinGecko Onchain address augmentation, Alchemy Prices, Moralis, Birdeye, and cached replay cannot satisfy single-source depeg authority.
- Soft single-source prices are never depeg-authoritative
- Soft-only multi-source agreement can still publish, but it remains `confirm_required` downstream unless a hard authoritative source is present
- Hard single-source prices are only depeg-authoritative when their freshness is source-native (`priceObservedAtMode = "upstream"`); local-fetch hard single-source prices remain `confirm_required`
- Supported non-USD fiat assets can require a fresh direct native-peg corroboration step before a derived USD/FX move is allowed to publish, or to open, extend, or confirm downstream depeg state; when that native-implied mark is published, it remains a non-replay-safe fallback lane rather than cached consensus continuity
- Weak fixed-peg price jumps versus the previous trusted price are quarantined until corroboration arrives

---

## Confidence Model

The final cached price can carry one of four confidence states:

| Value           | Meaning                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `high`          | 2 or more independent sources agree, or a validated authoritative override succeeded                                                                 |
| `single-source` | only one live source produced a usable price, or a 2-source agreeing cluster was downgraded because every agreeing member is a list-style aggregator |
| `low`           | multiple sources existed but failed to form a strong agreeing cluster                                                                                |
| `fallback`      | price came from enrichment rather than primary consensus                                                                                             |

Downstream consumers use these tags for display, depeg confirmation, and risk handling.

After consensus, `applyListAggregatorDowngrade()` expands composite source labels and downgrades 2-source clusters made entirely of list-style aggregators such as CoinGecko, DefiLlama-list, DefiLlama-contract, and CoinMarketCap from `high` to `single-source`, because those feeds can re-export overlapping upstream list data and are not treated as independent corroboration by themselves.

When the GeckoTerminal probe produces a re-run consensus that the post-consensus validation lane rejects (e.g., because the GT-enriched price would trigger temporal-jump quarantine), Pharos still treats the GT divergence evidence as material: a pre-GT `single-source` primary is downgraded to `low`-confidence rather than kept at its pre-probe confidence, so the run does not discard the evidence that the soft single-source publication differed meaningfully from the probed DEX pool. The pre-GT source/price are preserved; only the confidence tag is adjusted.

---

## Update Rules

When changing live pricing behavior, update all relevant surfaces in the same change:

1. runtime implementation in `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`, `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`, or related provider modules
2. this document for canonical pricing behavior
3. [data-pipeline.md](./data-pipeline.md) if broader sync/integrity semantics changed
4. `/methodology` pricing copy in `src/app/methodology/sections/core-sections-pricing.tsx`
5. `shared/lib/pricing-pipeline-version.ts` and [pricing-pipeline-timeline.md](./pricing-pipeline-timeline.md) if methodology semantics changed
6. [about-page.md](./about-page.md) and `src/app/about/content.ts` when externally visible data sources change

---

## File Index

| File                                                        | Role                                                                                                                                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` | Primary live-price collection, source assembly, consensus, GT probe, and pool challenge                                                                                                                  |
| `worker/src/cron/sync-stablecoins/enrich-prices.ts`         | Fallback enrichment orchestrator (`enrichMissingPrices()`) for still-missing prices                                                                                                                      |
| `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`  | Barrel re-export for individual pass runners (DefiLlama, CoinGecko low-volume, CMC, Jupiter, DexScreener)                                                                                                 |
| `worker/src/lib/price-consensus.ts`                         | N-source clustering and confidence resolution                                                                                                                                                            |
| `worker/src/lib/authoritative-price-sources/`               | Redeem-quote live/historical override provider registry                                                                                                                                                   |
| `worker/src/lib/pyth.ts`                                    | Pyth Hermes integration and feed-ID normalization                                                                                                                                                        |
| `worker/src/lib/redstone.ts`                                | Exact-case RedStone allowlist, batching, and retry behavior                                                                                                                                              |
| `worker/src/lib/cex-tickers.ts`                             | Binance, Kraken, Bitstamp, and Coinbase price fetchers                                                                                                                                                   |
| `worker/src/lib/coingecko-simple-price.ts`                  | `fetchCoingeckoSimplePrices` helper — extracted from the orchestrator to normalize batch request shape, upstream-timestamp parsing, staleness drop, and breaker accounting for CoinGecko `/simple/price` |
| `worker/src/lib/fetcher-result.ts`                          | `FetcherOutcome<T>` result type shared by CEX / oracle fetchers for uniform circuit-breaker accounting                                                                                                   |
| `worker/src/lib/chainlink-feeds.ts`                         | Curated Chainlink FX / commodity reference-feed reads                                                                                                                                                    |
| `worker/src/lib/curve-onchain.ts`                           | Curve on-chain price reads                                                                                                                                                                               |
| `worker/src/lib/price-validation.ts`                        | Peg-aware reasonableness validation                                                                                                                                                                      |
| `worker/src/lib/pricing-circuit-map.ts`                     | Canonical `PRICING_SOURCE_TO_CIRCUIT` map plus CI contract test asserting every registry source has a declared breaker (or is explicitly null for synthesized / composite / cached sources)              |
| `shared/lib/pricing-pipeline-constants.ts`                  | Shared numeric constants for primary pricing (currently `DIVERGENCE_THRESHOLD_BPS = 50`)                                                                                                                 |
| `shared/lib/methodology-versions/pricing-pipeline.ts`       | Methodology version metadata and changelog route                                                                                                                                                         |
| `src/app/methodology/sections/core-sections-pricing.tsx`    | Public longform pricing-pipeline methodology copy                                                                                                                                                        |
