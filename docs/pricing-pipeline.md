# Pricing Pipeline

Canonical reference for Pharos live-price selection, fallback enrichment, and source-specific normalization.

For supply fallback behavior and broader cache/integrity guardrails, see [data-pipeline.md](./data-pipeline.md).

---

## Overview

Pharos uses a two-stage pricing system:

1. **Primary consensus** in `fetchPrimaryPrices()` (`worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`)
2. **Fallback enrichment** in `enrichMissingPrices()` (`worker/src/cron/sync-stablecoins/enrich-prices.ts`)

The output is the cached `price`, `priceSource`, `priceConfidence`, `priceObservedAt`, `priceObservedAtMode`, `priceSyncedAt`, and compatibility `priceUpdatedAt` fields served through `/api/stablecoins`.

When an asset still has no usable current price after validation and fallback recovery, Pharos keeps `price = null`, `priceConfidence = null`, and serializes `priceSource = "missing"` so the cache payload stays structurally valid while still making the missing-price state explicit.

---

## Versioning

- **Current methodology version:** `v4.38`
- **Canonical version module:** `shared/lib/pricing-pipeline-version.ts`
- **Public changelog route:** `/methodology/pricing-pipeline-changelog/`
- **Longform methodology section:** `/methodology/#pricing-pipeline-methodology`

---

## Primary Consensus

`fetchPrimaryPrices()` gathers all usable live prices for a tracked asset, then runs N-source consensus via `worker/src/lib/price-consensus.ts`.

### Source Weights

| Source | Weight | Module / Origin | Notes |
|--------|--------|-----------------|-------|
| CoinGecko `/simple/price` | 2 | built-in fetch path | Primary market-data voice; uses upstream `last_updated_at` freshness when available and drops stale rows outside the trusted age window |
| CoinGecko ticker | 2 | `worker/src/lib/cg-ticker.ts` | Exchange-ticker corroboration path for the curated tracked subset |
| DefiLlama stablecoins list | 1 | Typed quote extracted from DL stablecoins endpoint | Independent DL aggregation with explicit observed-time provenance |
| Pyth Hermes | 2 | `worker/src/lib/pyth.ts` | Oracle input with confidence intervals |
| Binance spot | 2 | `worker/src/lib/cex-tickers.ts` | Batch venue input |
| Kraken spot | 2 | `worker/src/lib/cex-tickers.ts` | Explicit-pair venue input with alias-safe symbol mapping |
| Bitstamp spot | 1 | `worker/src/lib/cex-tickers.ts` | Lower-weight all-tickers corroboration venue |
| Coinbase spot | 2 | `worker/src/lib/cex-tickers.ts` | Per-symbol venue input |
| RedStone | 1 | `worker/src/lib/redstone.ts` | Fresh per-venue oracle snapshot with venue-agreement gating |
| Curve on-chain | 3 | `worker/src/lib/curve-onchain.ts` | Highest-weight on-chain voice for supported pools |
| Curve oracle (`crvusd-curve` only) | 3 | `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` | Additional primary-consensus voice for crvUSD |
| Trusted promoted DEX prices | 1 | `worker/src/lib/depeg-helpers.ts` | Only used when no promoted per-protocol DEX bridge source exists for the same asset |
| Fluid DEX (via `dex_prices`) | 3 | `worker/src/lib/depeg-helpers.ts` | One aggregated Fluid price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist |
| Balancer DEX (via `dex_prices`) | 3 | `worker/src/lib/depeg-helpers.ts` | One aggregated Balancer price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist |
| Raydium DEX (via `dex_prices`) | 2 | `worker/src/lib/depeg-helpers.ts` | One aggregated Raydium price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist |
| Orca DEX (via `dex_prices`) | 2 | `worker/src/lib/depeg-helpers.ts` | One aggregated Orca price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist |
| Meteora / PancakeSwap / Slipstream DEX (via `dex_prices`) | 2-3 | `worker/src/lib/depeg-helpers.ts` | Additional per-protocol DEX bridge sources from Meteora, PancakeSwap, Aerodrome Slipstream, and Velodrome Slipstream; still admitted only when corroborated or when no non-DEX voices exist |
| GeckoTerminal pool probe | 1 | `worker/src/lib/geckoterminal-price-probe.ts` | Pool-level cross-check for weak CoinGecko / DL-list soft-source outcomes |

> **Historical note (v2.0→v2.1):** The DL coins API (`coins.llama.fi/prices/current/coingecko:{id}`) was removed from primary consensus because it returned CoinGecko-sourced data, creating illusory two-source agreement. It is still used in fallback enrichment via contract-address queries.

### Consensus Rules

`computePriceConsensus()` behaves as follows:

1. 0 sources -> no result
2. 1 source -> `single-source`
3. 2+ sources -> build fully pairwise agreement clusters within a peg-aware threshold
4. best cluster with 2+ members -> `high` confidence, publish the cluster median, and keep the best trusted member as internal provenance
5. no 2+ cluster:
   - fixed pegs -> stay in fixed-peg mode even if the reference price is temporarily unavailable; choose the best trusted fallback source and mark `low`
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

### Pool Challenge (Soft-Source Guard)

After consensus, weak soft-source results where all relevant sources are **pool-challenge eligible** are challenged against current individual priced pools from the published challenger snapshot (`dex_price_challenger_snapshots` + `dex_price_challengers`) that meet the live $100K TVL minimum and are fresh within `DEX_FRESHNESS_SEC`. Eligible source families include CoinGecko, DefiLlama-list, `dex-promoted`, and promoted protocol-level DEX sources (`fluid-dex`, `balancer-dex`, `raydium-dex`, `orca-dex`) as long as no exempt hard source is present. NAV tokens are excluded from the pool challenge entirely: their fair value is their published NAV and the peg-aware divergence threshold does not map to a meaningful DEX-liquidity check, so diverging pools cannot downgrade or replace a NAV price. The divergence threshold is **peg-type-aware**: 500 bps for USD pegs, `min(2× depeg threshold, 500)` for non-USD pegs (e.g., 300 bps for JPY/EUR). If ANY qualifying pool diverges from the weak result beyond the threshold:

1. Confidence is always downgraded to `low`.
2. The price is **replaced** only when diverging protocol-level challenger prices span **≥2 independent protocols** — a single protocol's pools may share data-quality issues (vault-token counterparties, misconfigured pairs), and one rogue pool inside an otherwise agreeing protocol does not make that protocol count as corroborating disagreement. When replacement fires, Pharos first collapses each protocol to a TVL-weighted median price, then evaluates divergence and the final replacement from those protocol medians. When only one protocol diverges, the original price is preserved but confidence stays `low`.

When pool-challenge replacement fires, the selected primary result is rewritten in lockstep so downstream carry-through sees the new source: `allPrices`, `observedAtBySource`, and `observedAtModeBySource` are collapsed to a single `pool-tvl-weighted` entry, the replacement `observedAt` is the minimum of the contributing pools' observed-at timestamps (with mode `local_fetch`), and `agreeSources` / `candidateSources` / `disagreeSources` are updated to match. This keeps `hasCorroboratedSevereDownsideCandidate` and the primary-candidate carry-through lane from reading stale pre-replacement sources during later validation passes.

If the selected primary price is a severe fixed-peg downside and at least two live candidate sources independently
corroborate that downside, including at least one depeg-authoritative source such as Pyth, pool challenge can still
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

- **Pyth feed IDs:** `worker/src/lib/pyth.ts` normalizes feed IDs to lowercase and strips any leading `0x` before reverse-matching them to tracked assets. Hermes may return the same feed in prefixed or unprefixed form.
- **Pyth staleness guard:** Feeds with `publish_time` older than 5 minutes (`PYTH_MAX_STALENESS_SEC = 300`) are rejected before entering consensus. This prevents stale oracle snapshots from poisoning the price.
- **CoinGecko simple-price freshness:** `/simple/price` requests `last_updated_at`; when CoinGecko supplies it, rows older than the source trust window are rejected before consensus instead of being stamped as fresh local fetches. If the field is absent despite the request, the row can still enter as local-fetch provenance for backwards compatibility with partial responses.
- **Kraken symbols:** Kraken uses explicit request-pair and response-key maps in `worker/src/lib/cex-tickers.ts`; `USDT/USD` returns `USDTZUSD`, so the integration does not rely on naive string slicing.
- **Bitstamp ticker surface:** Bitstamp is fetched from the exchange-wide all-tickers endpoint and then filtered through an explicit tracked-pair allowlist so venue coverage stays deterministic.
- **Coinbase symbols:** `fetchPrimaryPrices()` uppercases symbols before Coinbase lookup. Active pairs: USDT, DAI, PAXG, USDS, USD1, HONEY.
- **RedStone symbols:** `worker/src/lib/redstone.ts` only queries the exact-case tracked subset in `REDSTONE_TRACKED_SYMBOL_ALLOWLIST` (21 symbols including `USDe`, `crvUSD`, and `fxUSD`). Unsupported symbols are filtered out before transport, and test coverage now guards the allowlist against stale untracked entries. Where metadata symbols differ from RedStone API symbols (e.g., `FRXUSD` → `frxUSD`, `EURC` → `EUROC`, `XAUT` → `XAUt`), the module translates via `REDSTONE_SYMBOL_CONFIG` entries (each carrying `metaSymbol` and `apiSymbol` fields) and keys results by metadata symbol so callers don't need to know the mapping.
- **RedStone request shape:** RedStone requests are sent in sequential batches of 10 symbols; any symbol missing from a batch response is retried once as a single-symbol request.
- **RedStone freshness + transparency gate:** RedStone entries are only admitted when they carry a timestamp newer than 5 minutes and a usable per-venue price breakdown. Timestamp-less or opaque aggregate-only responses are rejected.
- **RedStone multi-venue gate:** RedStone prices now need at least 2 venues and at least 60% venue agreement before they can enter primary consensus; a single venue is treated as insufficient corroboration, and the published RedStone price is derived from the venue median instead of the provider aggregate.
- **CEX capability semantics:** Binance, Kraken, Bitstamp, and Coinbase are all still treated as hard-market voices, but their registry metadata now makes their actual capabilities explicit. Binance is modeled as last-trade-only without bid/ask depth, while Kraken, Bitstamp, and Coinbase expose bid/ask-derived spot surfaces but still retain local-fetch freshness semantics in the current implementation.
- **Pyth confidence weighting:** Pyth is no longer dropped abruptly at modest confidence widths. Medium-confidence prints are now downweighted smoothly, and only very wide confidence intervals are excluded entirely.
- **Jupiter Price API V3 freshness semantics:** Jupiter documents `blockId` as the recency field for V3 responses. The fallback path therefore does not reject quotes based on optional `createdAt` metadata and instead relies on Jupiter's own price heuristics, liquidity gating, and peg-aware validation.
- **Chainlink reference overlay:** `worker/src/cron/sync-fx-rates.ts` overlays curated Chainlink EUR/USD, GBP/USD, JPY/USD, XAU/USD, and XAG/USD feeds onto the shared `fx-rates` cache when their on-chain quotes are fresh and within 5% of the current reference stack. The worker now tries dedicated dRPC `eth_call` transport for the supported Base / Ethereum / Arbitrum feeds before falling back to the shared chain RPC pool and then the existing Etherscan V2 proxy path, so the Chainlink overlay can still recover when earlier quarter-hour jobs have already saturated the shared Alchemy/public RPC budget. Frankfurter / secondary FX APIs and `gold-api.com` remain fallback sources for uncovered or divergent feeds, and commodity pegs now also have a stablecoins-cache peer-median recovery path when the anonymous metals endpoint is unavailable from Workers. These independent recovery probes still run during cached-fallback FX runs so a stale intraday subset can recover without waiting for the full Frankfurter stack.
- **Secondary + tertiary FX fallbacks:** `sync-fx-rates.ts` compares the jsDelivr `@fawazahmed0/currency-api` mirror with the direct `latest.currency-api.pages.dev` endpoint and persists the fresher valid dated snapshot. CNH/RUB/UAH/ARS always use this daily secondary path, and when Frankfurter is unavailable the same feed can temporarily backstop the wider fiat FX set. If both Frankfurter and the secondary mirrors are unavailable, the worker falls through to ExchangeRate-API's daily USD snapshot before dropping into cached-fallback mode.
- **FX freshness semantics:** `fx-rates-meta` tracks usable cache freshness (`usableSyncAt`) separately from per-peg source freshness metadata (`sourceUpdatedAtByPeg`, `sourceCadenceByPeg`, `sourceDateByPeg`). Intraday sources (`gold-api.com`, stablecoins-cache commodity peer medians, pure realtime recoveries) still age on wall-clock seconds, while daily sources (ECB/Frankfurter and the secondary CNH/RUB/UAH/ARS feed) are evaluated against their expected publish cadence instead of a naive 6-hour clock. When OXR or Chainlink overlays refine an already-fresh daily fiat reference, the worker now preserves that daily cadence/date metadata instead of downgrading the peg to synthetic intraday-only provenance. When the live FX fetches fail, same-day live fiat references can therefore be carried forward against their daily publish cadence rather than aging immediately into false intraday staleness, and commodity references can recover from the fresh `stablecoins` cache instead of inheriting stale metals timestamps. Cached fallback runs are reserved for cases where the job cannot refresh a live source and the carried-forward daily references are no longer cadence-valid, so non-USD and commodity validation cannot silently look fresh after a real upstream aging event. If a cached-fallback run later refreshes fresh full-set fiat coverage through OXR or Chainlink-backed overlays, the job now promotes itself back to `live` immediately instead of continuing to accumulate fallback streaks on already-recovered rates.
- **Direct native-peg live-publication guard:** supported non-USD fiat assets with reliable CoinGecko native pairs can derive a fresh `native quote × FX reference` USD mark during post-enrichment. That native-implied mark can correct materially divergent weak or mixed-source live USD publications and can also fill a missing live price for supported assets when the derived mark passes the shared publication guards.
- **Native lane scope:** `coingecko-native-implied` is a fresh fallback-validation lane, not a second replay-safe primary consensus source. Pharos can publish it for the current run when it is the best validated live mark, but it is not written into `price_cache` for later replay continuity.
- **Historical native-peg replay:** supported non-USD fiat backfills now prefer direct CoinGecko native-fiat history and compare that series to the native `1.0` peg before falling back to USD-denominated market history. In that native-fiat mode, replay now uses daily points plus a two-point confirmation window across 36 hours so thin hourly native prints cannot manufacture long false depeg streaks during repair.
- **GeckoTerminal probe transport:** `worker/src/lib/geckoterminal-price-probe.ts` now prefers authenticated CoinGecko `/onchain/networks/.../tokens/.../pools` when `COINGECKO_API_KEY` is configured and the chain has a CoinGecko on-chain network mapping. If that path yields no usable pool, the worker falls back to the public GeckoTerminal token-pools endpoint.
- **GeckoTerminal probe estimator:** GT no longer trusts a single highest-TVL pool. It collapses usable pools to one TVL-weighted-median price per protocol, then uses the TVL-weighted median across those protocol groups as the injected `geckoterminal` source. This reduces estimator noise from repeated same-protocol pools.
- **GeckoTerminal probe breaker semantics:** `worker/src/lib/geckoterminal-price-probe.ts` treats token-level lookup misses (`404` / `422`) as expected coverage gaps, not source outages. The `geckoterminal-probe` circuit breaker only trips on hard upstream failures such as transport errors, rate limits, or server-side failures, and each serialized probe request now gets one retry before a hard failure is recorded. Thin assets without indexed GT pools therefore do not poison the source-wide breaker state, and a single transient `429` no longer guarantees another 30-minute open interval.
- **GeckoTerminal probe self-budget:** the serialized GT cross-check now enforces a `3 minute` wall-clock budget per `sync-stablecoins` run and skips any remaining probeable candidates once that window is exhausted. This keeps weak soft-source days from consuming the full quarter-hour sync timeout.
- **GeckoTerminal probe observability:** `sync-stablecoins` now persists a `gtProbe` block into cron metadata, including `updatedCount`, coverage misses, upstream errors, public fallbacks, per-transport attempt counts for CoinGecko on-chain vs public GeckoTerminal, and budget flags (`budgetExhausted`, `budgetSkipped`). Operators can inspect those fields in `cron_runs.metadata` without relying on live Wrangler tails.
- **Circuit-breaker accounting:** for Pyth and RedStone, a transport-successful request that returns zero usable prices is still recorded as an unsuccessful outcome for breaker state. This avoids treating empty responses as healthy data.
- **CoinGecko ticker breaker semantics:** `worker/src/lib/cg-ticker.ts` still rejects stale or otherwise unusable Kinesis ticker rows for price publication, but the `coingecko-ticker` circuit breaker now tracks endpoint availability rather than row freshness. A successful `/coins/{id}/tickers` response with only stale/unusable USD rows no longer opens the source breaker; only transport failures or non-OK responses count as breaker failures.
- **Curve on-chain sanity bound:** Implied prices from `get_dy` calls are capped at `< 10,000` (to accommodate commodity tokens like PAXG/XAUT at ~$2,900).
- **Curve oracle staleness guard:** The `curve-oracle` voice (crvUSD `PriceAggregator.price()` EMA) is fetched against a resolved block number and its block timestamp is used to stamp `observedAt`. Reads with a block timestamp older than 5 minutes (`CURVE_ORACLE_MAX_STALENESS_SEC = 300`) are rejected before entering primary consensus, so a stale-replica RPC cannot single-source publish an EMA read minutes behind chain head. `curve-oracle` now uses its own `CIRCUIT_SOURCE.CURVE_ORACLE` breaker separately from the per-pool `curve-onchain` breaker, so an aggregator outage does not suppress per-pool Curve reads and vice versa.
- **Binance host cascade:** Binance ticker fetches no longer retry the same host on server-side failures. On HTTP 5xx, 429, or Worker-side 403/451, the fetcher short-circuits to the next host (`data-api.binance.vision` → `api.binance.com`) instead of consuming the Retry-After budget against a host that is already failing. Intra-host retries are reserved for transient network exceptions where the host itself has not answered.
- **Direct-API DEX bridge:** per-protocol DEX prices are aggregated before they enter primary consensus, so one Fluid/Balancer/Raydium/Orca/Meteora/PancakeSwap/Slipstream protocol can contribute at most one elevated source per asset.
- **DEX bridge overlap guard:** when a promoted per-protocol DEX bridge source exists for an asset, the overlapping `dex-promoted` aggregate is withheld so the same bridge observation family cannot self-confirm.
- **Promoted DEX corroboration gate:** a lone promoted DEX protocol is only admitted into primary consensus when it agrees with another promoted DEX protocol, agrees with a non-DEX source within the live threshold, or no non-DEX source exists for that asset.
- **DEX bridge freshness preservation:** primary pricing now keeps the per-source `updatedAt` values already stored inside `dex_prices.price_sources_json` when rebuilding promoted DEX sources. It only falls back to the row write time when a source-specific timestamp is missing or invalid, so freshness is no longer flattened across the entire bridge row.
- **Retained-pool DEX bridge publication:** `dex_prices` is now rebuilt from the final retained priced-pool surface after dedupe, caps, and scoring filters. Raw discovery observations that never survive retained-pool admission can no longer leak into promoted DEX bridge sources or `dexPriceCheck`.
- **Direct-API tracked quote pricing:** direct-API pair conversion now prefers only fresh authoritative tracked stablecoin prices from the cached stablecoins payload for quote legs before falling back to peg references. Weak or stale tracked prices no longer feed back into the DEX bridge, and unknown addressed `USDC`/`USDT`-style tokens still do not get unconditional `$1` treatment.
- **DEX token matching and dedupe:** direct-API, staged, and fallback DEX pools resolve tracked assets by `chain + address` first. If an upstream token already carries an address and that address is unknown to the canonical registry, it is dropped instead of falling back to symbol; symbol fallback is reserved for addressless rows and must still be unique within the same chain. Repeated observations of the same physical pool are collapsed by exact pool id or a conservative derived identity before they enter `dex_prices`.
- **Direct-API pair conversion:** non-USD tracked stablecoin pairs use peg-reference-aware conversion rather than treating every tracked stablecoin counterparty as `$1`.

These normalization rules live in code because they are provider quirks, not business-level scoring decisions.

---

## Authoritative Overrides

After market/oracle consensus, `worker/src/lib/authoritative-price-sources.ts` can replace the chosen live price for specific redeemable assets whose executable value is better represented by direct protocol redemption, or by an instantly redeemable tracked base asset, than by secondary-market liquidity.

### Current Scope

| Asset | Source |
|-------|--------|
| `cusd-cap` | Cap `getBurnAmount(address,uint256)` |
| `iusd-infinifi` | infiniFi `RedeemController.receiptToAsset(uint256)` |
| `usdai-usd-ai` | inherits tracked `pyusd-paypal` pricing as a redeemable PYUSD wrapper |
| `usdk-kast` | inherits tracked `wm-m0` pricing as a Solana M0 extension unit |
| `xo-exodus` | inherits tracked `wm-m0` pricing as a Solana M0 extension unit |
| `usdnr-nerona` | inherits tracked `wm-m0` pricing as an M0 extension unit |

When a live override validates successfully, the cached asset is written with:

- `priceSource = "protocol-redeem"`
- `priceConfidence = "high"`

For tracked-base inheritance paths, the authoritative layer does not query a bespoke contract path; it inherits the tracked parent asset's live price and historical replay because Pharos models the child as an instantly redeemable wrapper or extension of that parent rail.

Current tracked-base inheritance paths are:

- `usdai-usd-ai -> pyusd-paypal`
- `usdk-kast -> wm-m0`
- `xo-exodus -> wm-m0`
- `usdnr-nerona -> wm-m0`

This prevents thin secondary-market child-token prints, or missing child-market coverage, from dragging PegScore away from the executable value of the tracked parent rail.

These authoritative overrides are pre-applied before fallback enrichment and then applied again after the GeckoTerminal single-source probe. The early pass keeps known redeemable wrappers and extension assets out of unnecessary fallback-source probes, while the final pass preserves the existing rule that a later market cross-check cannot overwrite a validated redemption price.

The same registry also supports historical replay for backfills so admin rebuilds do not silently downgrade back to weaker market sources.

`crvusd-curve` no longer lives in the authoritative-override registry. Its Curve `PriceAggregator.price()` quote is now injected into primary consensus as the `curve-oracle` source alongside the other live pricing voices.

---

## Fallback Enrichment

Assets still missing prices after primary consensus run through `enrichMissingPrices()`:

1. **Pass 1:** DefiLlama `coins.llama.fi` by canonical tracked contract identity, using the upstream row address when present and falling back to curated tracked `contracts` metadata when the upstream row is addressless; quotes are validated against shared peg-aware bounds before they can resolve the asset, and assets can probe multiple exact tracked coin ids when needed
2. **Pass 1b:** alternate tracked deployment fallback via DefiLlama; only known tracked deployments are probed, never synthetic same-address cross-chain identities
3. **Pass 2:** CoinMarketCap stablecoins category batch (`v1/cryptocurrency/category?id=604f2753ebccdd50cd175fc1&limit=300&convert=USD`) — prefers `cmcSlug`-based matching over symbol, and symbol fallback is only allowed when the tracked symbol is unique. Rate-limited to 1 call/hour via D1 cache (see data-pipeline.md)
4. **Pass 3:** Jupiter Price API for tracked Solana mints — liquidity-gated and still subject to peg-aware validation
5. **Pass 4:** DexScreener exact token-address pool lookup when chain+address are available. Unique-symbol search is now reserved for addressless assets only; if an exact target exists and fails, Pharos does not downgrade to symbol-only identity under the same request budget. The pass now walks the full sorted missing set and stops after 10 actual DexScreener requests, so skipped high-rank non-unique rows cannot crowd out later exact-target or unique-symbol candidates. The exact token lookup lane and the symbol-search lane now keep separate circuit-breaker state: `dexscreener-prices` tracks `/tokens/v1/{chain}/{address}`, while `dexscreener-search` tracks the last-resort `/latest/dex/search` path so a flaky search endpoint cannot suppress otherwise healthy exact-address recovery.

The DefiLlama `/coins` contract-address fallback and the DexScreener lookups used outside primary consensus (the `dex-liquidity` and `dex-discovery` crawls) now gate on and record against their own circuit breakers. `CIRCUIT_SOURCE.DL_COINS` wraps the `coins.llama.fi/prices/current/...` path so a DL regional outage opens the breaker instead of hammering the host, and the same `dexscreener-prices` / `dexscreener-search` breakers are consulted from the liquidity and discovery paths so a persistent DexScreener failure cannot keep retrying across cron surfaces.

Operationally, missing-price enrichment runs before the slower GeckoTerminal soft-source cross-check so recovery of unpriced assets stays on the critical path; the GT probe still reruns consensus later for weak CG / DL-list outcomes, self-stops once its 3-minute budget is exhausted, and protocol overrides still apply after that probe.

Provider attempt diagnostics for Binance and Jupiter are persisted into `sync-stablecoins` cron metadata. Those diagnostics include the sanitized endpoint, HTTP status when available, candidate/response/match counts, and short non-OK snippets so operators can distinguish provider transport failures from successful responses that simply carry no usable tracked prices.

Jupiter fallback uses the official `https://api.jup.ag/price/v3` gateway. The previous Lite gateway is no longer used after Worker egress received repeated Cloudflare 403 block pages from that host.

Binance ticker fetches try the market-data mirror first (`data-api.binance.vision`) and then fall back to the main public API host (`api.binance.com`) before recording the source as failed. Both hosts use the same tracked `USDTUSD` / `USDCUSD` market mapping.

If every attempted Binance host returns a Worker-side 403/451 block, Pharos records the diagnostics and treats Binance as a no-contribution provider block rather than a source outage. Binance contributes zero prices in that state; it does not keep the source-wide breaker open.

When authoritative pricing removes every Jupiter fallback candidate, the run closes stale-open `jupiter-prices` breaker state without making a provider health request. Future eligible Solana fallback candidates still use the normal circuit breaker and diagnostics path.

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

- Soft single-source prices are never depeg-authoritative
- Soft-only multi-source agreement can still publish, but it remains `confirm_required` downstream unless a hard authoritative source is present
- Hard single-source prices are only depeg-authoritative when their freshness is source-native (`priceObservedAtMode = "upstream"`); local-fetch hard single-source prices remain `confirm_required`
- Supported non-USD fiat assets can require a fresh direct native-peg corroboration step before a derived USD/FX move is allowed to publish, or to open, extend, or confirm downstream depeg state; when that native-implied mark is published, it remains a non-replay-safe fallback lane rather than cached consensus continuity
- Weak fixed-peg price jumps versus the previous trusted price are quarantined until corroboration arrives

---

## Confidence Model

The final cached price can carry one of four confidence states:

| Value | Meaning |
|-------|---------|
| `high` | 2 or more sources agree, or a validated authoritative override succeeded |
| `single-source` | only one live source produced a usable price |
| `low` | multiple sources existed but failed to form a strong agreeing cluster |
| `fallback` | price came from enrichment rather than primary consensus |

Downstream consumers use these tags for display, depeg confirmation, and risk handling.

When the GeckoTerminal probe produces a re-run consensus that the post-consensus validation lane rejects (e.g., because the GT-enriched price would trigger temporal-jump quarantine), Pharos still treats the GT divergence evidence as material: a pre-GT `single-source` primary is downgraded to `low`-confidence rather than kept at its pre-probe confidence, so the run does not discard the evidence that the soft single-source publication differed meaningfully from the probed DEX pool. The pre-GT source/price are preserved; only the confidence tag is adjusted.

---

## Update Rules

When changing live pricing behavior, update all relevant surfaces in the same change:

1. runtime implementation in `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`, `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`, or related provider modules
2. this document for canonical pricing behavior
3. [data-pipeline.md](./data-pipeline.md) if broader sync/integrity semantics changed
4. `/methodology` pricing copy in `src/app/methodology/sections/core-sections-pricing.tsx`
5. `shared/lib/pricing-pipeline-version.ts` and [pricing-pipeline-timeline.md](./pricing-pipeline-timeline.md) if methodology semantics changed
6. [about-page.md](./about-page.md) and `src/app/about/page.tsx` when externally visible data sources change

---

## File Index

| File | Role |
|------|------|
| `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` | Primary live-price collection, source assembly, consensus, GT probe, and pool challenge |
| `worker/src/cron/sync-stablecoins/enrich-prices.ts` | Fallback enrichment orchestrator (`enrichMissingPrices()`) for still-missing prices |
| `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts` | Barrel re-export for individual pass runners (DefiLlama, CMC, Jupiter, DexScreener) |
| `worker/src/lib/price-consensus.ts` | N-source clustering and confidence resolution |
| `worker/src/lib/authoritative-price-sources.ts` | Redeem-quote live/historical override registry |
| `worker/src/lib/pyth.ts` | Pyth Hermes integration and feed-ID normalization |
| `worker/src/lib/redstone.ts` | Exact-case RedStone allowlist, batching, and retry behavior |
| `worker/src/lib/cex-tickers.ts` | Binance, Kraken, Bitstamp, and Coinbase price fetchers |
| `worker/src/lib/fetcher-result.ts` | `FetcherOutcome<T>` result type shared by CEX / oracle fetchers for uniform circuit-breaker accounting |
| `worker/src/lib/chainlink-feeds.ts` | Curated Chainlink FX / commodity reference-feed reads |
| `worker/src/lib/curve-onchain.ts` | Curve on-chain price reads |
| `worker/src/lib/price-validation.ts` | Peg-aware reasonableness validation |
| `shared/lib/pricing-pipeline-version.ts` | Methodology version metadata and changelog route |
| `src/app/methodology/sections/core-sections-pricing.tsx` | Public longform pricing-pipeline methodology copy |
