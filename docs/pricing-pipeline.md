# Pricing Pipeline

Canonical reference for Pharos live-price selection, fallback enrichment, and source-specific normalization.

For supply fallback behavior and broader cache/integrity guardrails, see [data-pipeline.md](./data-pipeline.md).

---

## Overview

Pharos uses a two-stage pricing system:

1. **Primary consensus** in `fetchPrimaryPrices()` (`worker/src/cron/enrich-prices.ts`)
2. **Fallback enrichment** in `enrichMissingPrices()` (`worker/src/cron/enrich-prices.ts`)

The output is the cached `price`, `priceSource`, `priceConfidence`, `priceObservedAt`, `priceSyncedAt`, and compatibility `priceUpdatedAt` fields served through `/api/stablecoins`.

When an asset still has no usable current price after validation and fallback recovery, Pharos keeps `price = null`, `priceConfidence = null`, and serializes `priceSource = "missing"` so the cache payload stays structurally valid while still making the missing-price state explicit.

---

## Versioning

- **Current methodology version:** `v2.15`
- **Canonical version module:** `shared/lib/pricing-pipeline-version.ts`
- **Public changelog route:** `/methodology/pricing-pipeline-changelog/`
- **Longform methodology section:** `/methodology/#pricing-pipeline-methodology`

---

## Primary Consensus

`fetchPrimaryPrices()` gathers all usable live prices for a tracked asset, then runs N-source consensus via `worker/src/lib/price-consensus.ts`.

### Source Weights

| Source | Weight | Module / Origin | Notes |
|--------|--------|-----------------|-------|
| CoinGecko `/simple/price` | 2 | built-in fetch path | Primary market-data voice |
| DefiLlama stablecoins list | 1 | Extracted from DL stablecoins endpoint | Independent DL aggregation for assets with `llamaId` |
| Pyth Hermes | 2 | `worker/src/lib/pyth.ts` | Oracle input with confidence intervals |
| Binance spot | 2 | `worker/src/lib/cex-tickers.ts` | Batch venue input |
| Kraken spot | 2 | `worker/src/lib/cex-tickers.ts` | Explicit-pair venue input with alias-safe symbol mapping |
| Bitstamp spot | 1 | `worker/src/lib/cex-tickers.ts` | Lower-weight all-tickers corroboration venue |
| Coinbase spot | 2 | `worker/src/lib/cex-tickers.ts` | Per-symbol venue input |
| RedStone | 1 | `worker/src/lib/redstone.ts` | Fresh per-venue oracle snapshot with venue-agreement gating |
| Curve on-chain | 3 | `worker/src/lib/curve-onchain.ts` | Highest-weight on-chain voice for supported pools |
| Curve oracle (`crvusd-curve` only) | 3 | `worker/src/cron/enrich-prices.ts` | Additional primary-consensus voice for crvUSD |
| Trusted promoted DEX prices | 1 | `worker/src/lib/depeg-helpers.ts` | Only used when no promoted per-protocol DEX bridge source exists for the same asset |
| Fluid DEX (via `dex_prices`) | 3 | `worker/src/lib/depeg-helpers.ts` | One aggregated Fluid price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist |
| Balancer DEX (via `dex_prices`) | 3 | `worker/src/lib/depeg-helpers.ts` | One aggregated Balancer price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist |
| Raydium DEX (via `dex_prices`) | 2 | `worker/src/lib/depeg-helpers.ts` | One aggregated Raydium price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist |
| Orca DEX (via `dex_prices`) | 2 | `worker/src/lib/depeg-helpers.ts` | One aggregated Orca price per asset from `price_sources_json`; admitted only when corroborated or when no non-DEX voices exist |
| GeckoTerminal pool probe | 1 | `worker/src/lib/geckoterminal-price-probe.ts` | Pool-level cross-check for weak CoinGecko / DL-list soft-source outcomes |

> **Historical note (v2.0→v2.1):** The DL coins API (`coins.llama.fi/prices/current/coingecko:{id}`) was removed from primary consensus because it returned CoinGecko-sourced data, creating illusory two-source agreement. It is still used in fallback enrichment via contract-address queries.

### Consensus Rules

`computePriceConsensus()` behaves as follows:

1. 0 sources -> no result
2. 1 source -> `single-source`
3. 2+ sources -> build fully pairwise agreement clusters within a peg-aware threshold
4. best cluster with 2+ members -> `high` confidence and choose the best trusted member inside that cluster
5. no 2+ cluster:
   - fixed pegs -> stay in fixed-peg mode even if the reference price is temporarily unavailable; choose the best trusted fallback source and mark `low`
   - NAV tokens -> use a wider 500 bps cluster threshold first, otherwise choose the best trusted fallback source and mark `low`

When multiple clusters have the same size, the winner is chosen deterministically by:

1. larger total cluster weight
2. tighter internal spread
3. proximity to peg reference (when available)
4. stable alphabetical source label as the final tie-break

Source labels list all agreeing sources alphabetically:

- 1 source: source name directly
- 2+ sources: `sourceA+sourceB+sourceC` (full list, no truncation)

### Pool Challenge (Soft-Source Guard)

After consensus, weak soft-source results where all relevant sources are **pool-challenge eligible** are challenged against current individual priced pools from the published challenger snapshot (`dex_price_challenger_snapshots` + `dex_price_challengers`) that meet the live $100K TVL minimum and are fresh within `DEX_FRESHNESS_SEC`. Eligible source families include CoinGecko, DefiLlama-list, `dex-promoted`, and promoted protocol-level DEX sources (`fluid-dex`, `balancer-dex`, `raydium-dex`, `orca-dex`) as long as no exempt hard source is present. The divergence threshold is **peg-type-aware**: 500 bps for USD pegs, `min(2× depeg threshold, 500)` for non-USD pegs (e.g., 300 bps for JPY/EUR). If ANY qualifying pool diverges from the weak result beyond the threshold:

1. Confidence is always downgraded to `low`.
2. The price is **replaced** with the TVL-weighted mean only when diverging pools span **≥2 independent protocols** — a single protocol's pools may share data-quality issues (vault-token counterparties, misconfigured pairs). When only one protocol diverges, the original price is preserved but confidence stays `low`.

The DEX bridge and the pool challenge now deliberately read from different storage views:

- `dex_prices.price_sources_json`: one aggregate per protocol, used for primary-price promotion
- `dex_price_challenger_snapshots` + `dex_price_challengers`: current individual challenger pools, published from the full retained DEX pool set for large-pool challenge / depeg confirmation
- `dex_liquidity.top_pools_json`: display-oriented top pools for UI detail, no longer the canonical challenger source

This catches cases where multiple aggregators or DEX-derived bridge sources agree on a misleading price derived from small pools while ignoring large pools that show a depeg. When the challenge fires, on-chain pool liquidity provides a more honest price signal than aggregator consensus because large pools carry proportional weight. Hard sources (Pyth, Binance, Kraken, Bitstamp, Coinbase, Curve on-chain, Curve oracle, RedStone with multi-venue agreement, protocol-redeem) are exempt because they provide independent market/oracle data.

---

## Provider-Specific Normalization

Several live providers need normalization before their prices can safely enter consensus:

- **Pyth feed IDs:** `worker/src/lib/pyth.ts` normalizes feed IDs to lowercase and strips any leading `0x` before reverse-matching them to tracked assets. Hermes may return the same feed in prefixed or unprefixed form.
- **Pyth staleness guard:** Feeds with `publish_time` older than 5 minutes (`PYTH_MAX_STALENESS_SEC = 300`) are rejected before entering consensus. This prevents stale oracle snapshots from poisoning the price.
- **Kraken symbols:** Kraken uses explicit request-pair and response-key maps in `worker/src/lib/cex-tickers.ts`; `USDT/USD` returns `USDTZUSD`, so the integration does not rely on naive string slicing.
- **Bitstamp ticker surface:** Bitstamp is fetched from the exchange-wide all-tickers endpoint and then filtered through an explicit tracked-pair allowlist so venue coverage stays deterministic.
- **Coinbase symbols:** `fetchPrimaryPrices()` uppercases symbols before Coinbase lookup. Active pairs: USDT, DAI, PAXG, USDS, USD1, HONEY.
- **RedStone symbols:** `worker/src/lib/redstone.ts` only queries the exact-case tracked subset in `REDSTONE_TRACKED_SYMBOL_ALLOWLIST` (36 symbols including `USDe`, `crvUSD`, `fxUSD`, `sUSDe`). Unsupported symbols are filtered out before transport. Where metadata symbols differ from RedStone API symbols (e.g., `FRXUSD` → `frxUSD`, `EURC` → `EUROC`, `XAUT` → `XAUt`), the module translates via `REDSTONE_API_SYMBOL_MAP` and keys results by metadata symbol so callers don't need to know the mapping.
- **RedStone request shape:** RedStone requests are sent in sequential batches of 10 symbols; any symbol missing from a batch response is retried once as a single-symbol request.
- **RedStone freshness + transparency gate:** RedStone entries are only admitted when they carry a timestamp newer than 5 minutes and a usable per-venue price breakdown. Timestamp-less or opaque aggregate-only responses are rejected.
- **RedStone multi-venue gate:** RedStone prices now need at least 2 venues and at least 50% venue agreement before they can enter primary consensus; a single venue is treated as insufficient corroboration, and the published RedStone price is derived from the venue median instead of the provider aggregate.
- **Jupiter Price API V3 freshness semantics:** Jupiter documents `blockId` as the recency field for V3 responses. The fallback path therefore does not reject quotes based on optional `createdAt` metadata and instead relies on Jupiter's own price heuristics, liquidity gating, and peg-aware validation.
- **Chainlink reference overlay:** `worker/src/cron/sync-fx-rates.ts` overlays curated Chainlink EUR/USD, GBP/USD, JPY/USD, XAU/USD, and XAG/USD feeds onto the shared `fx-rates` cache when their on-chain quotes are fresh and within 5% of the current reference stack. Frankfurter / secondary FX APIs and `gold-api.com` remain fallback sources for uncovered or divergent feeds, and commodity pegs now also have a stablecoins-cache peer-median recovery path when the anonymous metals endpoint is unavailable from Workers. These independent recovery probes still run during cached-fallback FX runs so a stale intraday subset can recover without waiting for the full Frankfurter stack.
- **Secondary + tertiary FX fallbacks:** `sync-fx-rates.ts` compares the jsDelivr `@fawazahmed0/currency-api` mirror with the direct `latest.currency-api.pages.dev` endpoint and persists the fresher valid dated snapshot. CNH/RUB/UAH/ARS always use this daily secondary path, and when Frankfurter is unavailable the same feed can temporarily backstop the wider fiat FX set. If both Frankfurter and the secondary mirrors are unavailable, the worker falls through to ExchangeRate-API's daily USD snapshot before dropping into cached-fallback mode.
- **FX freshness semantics:** `fx-rates-meta` tracks usable cache freshness (`usableSyncAt`) separately from per-peg source freshness metadata (`sourceUpdatedAtByPeg`, `sourceCadenceByPeg`, `sourceDateByPeg`). Intraday sources (`gold-api.com`, stablecoins-cache commodity peer medians, pure realtime recoveries) still age on wall-clock seconds, while daily sources (ECB/Frankfurter and the secondary CNH/RUB/UAH/ARS feed) are evaluated against their expected publish cadence instead of a naive 6-hour clock. When OXR or Chainlink overlays refine an already-fresh daily fiat reference, the worker now preserves that daily cadence/date metadata instead of downgrading the peg to synthetic intraday-only provenance. When the live FX fetches fail, same-day live fiat references can therefore be carried forward against their daily publish cadence rather than aging immediately into false intraday staleness, and commodity references can recover from the fresh `stablecoins` cache instead of inheriting stale metals timestamps. Cached fallback runs are reserved for cases where the job cannot refresh a live source and the carried-forward daily references are no longer cadence-valid, so non-USD and commodity validation cannot silently look fresh after a real upstream aging event. If a cached-fallback run later refreshes fresh full-set fiat coverage through OXR or Chainlink-backed overlays, the job now promotes itself back to `live` immediately instead of continuing to accumulate fallback streaks on already-recovered rates.
- **GeckoTerminal probe transport:** `worker/src/lib/geckoterminal-price-probe.ts` now prefers authenticated CoinGecko `/onchain/networks/.../tokens/.../pools` when `COINGECKO_API_KEY` is configured and the chain has a CoinGecko on-chain network mapping. If that path yields no usable pool, the worker falls back to the public GeckoTerminal token-pools endpoint. The resulting cross-check still enters consensus as the `geckoterminal` source because the pool-selection and weighting semantics are unchanged.
- **GeckoTerminal probe breaker semantics:** `worker/src/lib/geckoterminal-price-probe.ts` treats token-level lookup misses (`404` / `422`) as expected coverage gaps, not source outages. The `geckoterminal-probe` circuit breaker only trips on hard upstream failures such as transport errors, rate limits, or server-side failures, and each serialized probe request now gets one retry before a hard failure is recorded. Thin assets without indexed GT pools therefore do not poison the source-wide breaker state, and a single transient `429` no longer guarantees another 30-minute open interval.
- **GeckoTerminal probe self-budget:** the serialized GT cross-check now enforces a `3 minute` wall-clock budget per `sync-stablecoins` run and skips any remaining probeable candidates once that window is exhausted. This keeps weak soft-source days from consuming the full quarter-hour sync timeout.
- **GeckoTerminal probe observability:** `sync-stablecoins` now persists a `gtProbe` block into cron metadata, including `updatedCount`, coverage misses, upstream errors, public fallbacks, per-transport attempt counts for CoinGecko on-chain vs public GeckoTerminal, and budget flags (`budgetExhausted`, `budgetSkipped`). Operators can inspect those fields in `cron_runs.metadata` without relying on live Wrangler tails.
- **Circuit-breaker accounting:** for Pyth and RedStone, a transport-successful request that returns zero usable prices is still recorded as an unsuccessful outcome for breaker state. This avoids treating empty responses as healthy data.
- **Curve on-chain sanity bound:** Implied prices from `get_dy` calls are capped at `< 10,000` (to accommodate commodity tokens like PAXG/XAUT at ~$2,900).
- **Direct-API DEX bridge:** per-protocol DEX prices are aggregated before they enter primary consensus, so one Balancer/Fluid/Raydium/Orca protocol can contribute at most one elevated source per asset.
- **DEX bridge overlap guard:** when a promoted per-protocol DEX bridge source exists for an asset, the overlapping `dex-promoted` aggregate is withheld so the same bridge observation family cannot self-confirm.
- **Promoted DEX corroboration gate:** a lone promoted DEX protocol is only admitted into primary consensus when it agrees with another promoted DEX protocol, agrees with a non-DEX source within the live threshold, or no non-DEX source exists for that asset.
- **Direct-API tracked quote pricing:** direct-API pair conversion now prefers only fresh authoritative tracked stablecoin prices from the cached stablecoins payload for quote legs before falling back to peg references. Weak or stale tracked prices no longer feed back into the DEX bridge, and unknown addressed `USDC`/`USDT`-style tokens still do not get unconditional `$1` treatment.
- **DEX token matching and dedupe:** direct-API, staged, and fallback DEX pools resolve tracked assets by `chain + address` first. If an upstream token already carries an address and that address is unknown to the canonical registry, it is dropped instead of falling back to symbol; symbol fallback is reserved for addressless rows and must still be unique within the same chain. Repeated observations of the same physical pool are collapsed by exact pool id or a conservative derived identity before they enter `dex_prices`.
- **Direct-API pair conversion:** non-USD tracked stablecoin pairs use peg-reference-aware conversion rather than treating every tracked stablecoin counterparty as `$1`.

These normalization rules live in code because they are provider quirks, not business-level scoring decisions.

---

## Authoritative Overrides

After market/oracle consensus, `worker/src/lib/authoritative-price-sources.ts` can replace the chosen live price for specific redeemable assets whose executable value is better represented by direct protocol redemption than by secondary-market liquidity.

### Current Scope

| Asset | Source |
|-------|--------|
| `cusd-cap` | Cap `getBurnAmount(address,uint256)` |
| `iusd-infinifi` | infiniFi `RedeemController.receiptToAsset(uint256)` |

When a live override validates successfully, the cached asset is written with:

- `priceSource = "protocol-redeem"`
- `priceConfidence = "high"`

These authoritative overrides are applied after the GeckoTerminal single-source probe, so a later market cross-check cannot overwrite a validated redemption price.

The same registry also supports historical replay for backfills so admin rebuilds do not silently downgrade back to weaker market sources.

`crvusd-curve` no longer lives in the authoritative-override registry. Its Curve `PriceAggregator.price()` quote is now injected into primary consensus as the `curve-oracle` source alongside the other live pricing voices.

---

## Fallback Enrichment

Assets still missing prices after primary consensus run through `enrichMissingPrices()`:

1. **Pass 1:** DefiLlama `coins.llama.fi` by current contract address
2. **Pass 1b:** alternate tracked deployment fallback via DefiLlama; only known tracked deployments are probed, never synthetic same-address cross-chain identities
3. **Pass 2:** CoinMarketCap `listings/latest` batch — prefers `cmcSlug`-based matching over symbol, and symbol fallback is only allowed when the tracked symbol is unique. Rate-limited to 1 call/hour via D1 cache (see data-pipeline.md)
4. **Pass 3:** Jupiter Price API for tracked Solana mints — liquidity-gated and still subject to peg-aware validation
5. **Pass 4:** DexScreener exact token-address pool lookup when chain+address are available, falling back to symbol search only for unique tracked symbols under the same liquidity and peg-aware validation gates

Operationally, missing-price enrichment runs before the slower GeckoTerminal soft-source cross-check so recovery of unpriced assets stays on the critical path; the GT probe still reruns consensus later for weak CG / DL-list outcomes, self-stops once its 3-minute budget is exhausted, and protocol overrides still apply after that probe.

The enrichment path is intentionally narrower than primary pricing:

- it exists to fill holes, not overrule good consensus
- fallback results are validated before they enter `price_cache`
- replay cache only stores replay-safe prices (no `low`, no `fallback`, no fragile search-derived sources), expires after 6 hours, and now preserves source/confidence/timestamp/source-list provenance
- previous-trusted continuity now merges the last authoritative stablecoins publication with fresh replay-safe `price_cache` rows, so a temporarily `low` or unusable publication does not make an already-confirmed severe depeg forget its prior corroborated state on the next run
- replay-safe cached fallback is applied to any asset that is still missing after post-validation, including assets that became missing later in the same sync run because a current-run candidate was rejected
- invalid or severely depegged single-source fallback prints are dropped instead of poisoning later runs

### Timestamp Semantics

- `priceObservedAt`: upstream source observation time when available, otherwise the local observation time for that source
- `priceSyncedAt`: when Pharos selected and wrote the price during the current sync
- `priceUpdatedAt`: compatibility alias for the effective observation timestamp, preserved so existing consumers do not interpret sync-write time as source freshness

### Downstream Trust Semantics

- Soft single-source prices are never depeg-authoritative
- Soft-only multi-source agreement can still publish, but it remains `confirm_required` downstream unless a hard authoritative source is present
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

---

## Update Rules

When changing live pricing behavior, update all relevant surfaces in the same change:

1. runtime implementation in `worker/src/cron/enrich-prices.ts` or related provider modules
2. this document for canonical pricing behavior
3. [data-pipeline.md](./data-pipeline.md) if broader sync/integrity semantics changed
4. `/methodology` pricing copy in `src/app/methodology/sections/core-sections.tsx`
5. `shared/lib/pricing-pipeline-version.ts` and [pricing-pipeline-timeline.md](./pricing-pipeline-timeline.md) if methodology semantics changed
6. [about-page.md](./about-page.md) and `src/app/about/page.tsx` when externally visible data sources change

---

## File Index

| File | Role |
|------|------|
| `worker/src/cron/enrich-prices.ts` | Primary consensus orchestration and fallback enrichment |
| `worker/src/lib/price-consensus.ts` | N-source clustering and confidence resolution |
| `worker/src/lib/authoritative-price-sources.ts` | Redeem-quote live/historical override registry |
| `worker/src/lib/pyth.ts` | Pyth Hermes integration and feed-ID normalization |
| `worker/src/lib/redstone.ts` | Exact-case RedStone allowlist, batching, and retry behavior |
| `worker/src/lib/cex-tickers.ts` | Binance, Kraken, Bitstamp, and Coinbase price fetchers |
| `worker/src/lib/chainlink-feeds.ts` | Curated Chainlink FX / commodity reference-feed reads |
| `worker/src/lib/curve-onchain.ts` | Curve on-chain price reads |
| `worker/src/lib/price-validation.ts` | Peg-aware reasonableness validation |
| `shared/lib/pricing-pipeline-version.ts` | Methodology version metadata and changelog route |
| `src/app/methodology/sections/core-sections.tsx` | Public longform pricing-pipeline methodology copy |
