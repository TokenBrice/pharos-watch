# Pricing Pipeline

Canonical reference for Pharos live-price selection, fallback enrichment, and source-specific normalization.

For supply fallback behavior and broader cache/integrity guardrails, see [data-pipeline.md](./data-pipeline.md).

---

## Overview

Pharos uses a two-stage pricing system:

1. **Primary consensus** in `fetchPrimaryPrices()` (`worker/src/cron/enrich-prices.ts`)
2. **Fallback enrichment** in `enrichMissingPrices()` (`worker/src/cron/enrich-prices.ts`)

The output is the cached `price`, `priceSource`, `priceConfidence`, and `priceUpdatedAt` fields served through `/api/stablecoins`.

---

## Versioning

- **Current methodology version:** `v2.1`
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
| Coinbase spot | 2 | `worker/src/lib/cex-tickers.ts` | Per-symbol venue input |
| RedStone | 1 | `worker/src/lib/redstone.ts` | Per-venue oracle snapshot |
| Curve on-chain | 3 | `worker/src/lib/curve-onchain.ts` | Highest-weight on-chain voice for supported pools |
| Curve oracle (`crvusd-curve` only) | 3 | `worker/src/cron/enrich-prices.ts` | Additional primary-consensus voice for crvUSD |
| Trusted promoted DEX prices | 1 | `worker/src/lib/depeg-helpers.ts` | Only trusted DEX rows are promoted into primary pricing |
| GeckoTerminal pool probe | 1 | `worker/src/lib/geckoterminal-price-probe.ts` | Pool-level cross-check for single-source CG-only assets |

> **Historical note (v2.0→v2.1):** The DL coins API (`coins.llama.fi/prices/current/coingecko:{id}`) was removed from primary consensus because it returned CoinGecko-sourced data, creating illusory two-source agreement. It is still used in fallback enrichment via contract-address queries.

### Consensus Rules

`computePriceConsensus()` behaves as follows:

1. 0 sources -> no result
2. 1 source -> `single-source`
3. 2+ sources -> build agreement clusters within a peg-aware threshold
4. best cluster with 2+ members -> `high` confidence and choose the highest-weight member in that cluster
5. no 2+ cluster:
   - fixed pegs -> choose the source closest to peg reference, mark `low`
   - NAV tokens -> use a wider 500 bps cluster threshold first, otherwise choose the highest-weight source and mark `low`

Source labels are compressed for agreeing clusters:

- 1 source: source name directly
- 2 sources: `sourceA+sourceB`
- 3+ sources: `firstSource+Nmore`

### Pool Challenge (Soft-Source Guard)

After consensus, results where all agreeing sources are **soft aggregators** (CoinGecko, DefiLlama-list, dex-promoted) are challenged against the highest-TVL individual DEX pool from `dex_prices.price_sources_json`. If the highest-TVL pool (≥$100K TVL, fresh within `DEX_FRESHNESS_SEC`) diverges from consensus by ≥500 bps, confidence is downgraded to `low`.

This catches cases where multiple aggregators agree on a misleading price derived from small pools while ignoring large pools that show a depeg. Hard sources (Pyth, Binance, Coinbase, Curve on-chain, RedStone, protocol-redeem) are exempt because they provide independent market/oracle data.

---

## Provider-Specific Normalization

Several live providers need normalization before their prices can safely enter consensus:

- **Pyth feed IDs:** `worker/src/lib/pyth.ts` normalizes feed IDs to lowercase and strips any leading `0x` before reverse-matching them to tracked assets. Hermes may return the same feed in prefixed or unprefixed form.
- **Pyth staleness guard:** Feeds with `publish_time` older than 5 minutes (`PYTH_MAX_STALENESS_SEC = 300`) are rejected before entering consensus. This prevents stale oracle snapshots from poisoning the price.
- **Coinbase symbols:** `fetchPrimaryPrices()` uppercases symbols before Coinbase lookup. Active pairs: USDT, DAI, PAXG, USDS, USD1, HONEY.
- **RedStone symbols:** `worker/src/lib/redstone.ts` only queries the exact-case tracked subset in `REDSTONE_TRACKED_SYMBOL_ALLOWLIST` (36 symbols including `USDe`, `crvUSD`, `fxUSD`, `sUSDe`). Unsupported symbols are filtered out before transport. Where metadata symbols differ from RedStone API symbols (e.g., `FRXUSD` → `frxUSD`, `EURC` → `EUROC`, `XAUT` → `XAUt`), the module translates via `REDSTONE_API_SYMBOL_MAP` and keys results by metadata symbol so callers don't need to know the mapping.
- **RedStone request shape:** RedStone requests are sent in sequential batches of 10 symbols; any symbol missing from a batch response is retried once as a single-symbol request.
- **Circuit-breaker accounting:** for Pyth and RedStone, a transport-successful request that returns zero usable prices is still recorded as an unsuccessful outcome for breaker state. This avoids treating empty responses as healthy data.
- **Curve on-chain sanity bound:** Implied prices from `get_dy` calls are capped at `< 10,000` (to accommodate commodity tokens like PAXG/XAUT at ~$2,900).

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

The same registry also supports historical replay for backfills so admin rebuilds do not silently downgrade back to weaker market sources.

`crvusd-curve` no longer lives in the authoritative-override registry. Its Curve `PriceAggregator.price()` quote is now injected into primary consensus as the `curve-oracle` source alongside the other live pricing voices.

---

## Fallback Enrichment

Assets still missing prices after primary consensus run through `enrichMissingPrices()`:

1. **Pass 1:** DefiLlama `coins.llama.fi` by current contract address
2. **Pass 1b:** alternate-chain contract fallback via DefiLlama
3. **Pass 2:** CoinMarketCap `listings/latest` batch — prefers `cmcSlug`-based matching over symbol to avoid cross-contamination in collision groups (e.g., two coins sharing "GUSD")
4. **Pass 3:** DexScreener search fallback with liquidity and peg-aware validation gates

The enrichment path is intentionally narrower than primary pricing:

- it exists to fill holes, not overrule good consensus
- fallback results are validated before they enter `price_cache`
- invalid fallback prints are dropped instead of poisoning later runs

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
4. `/methodology` pricing copy in `src/app/methodology/methodology-sections.tsx`
5. `shared/lib/pricing-pipeline-version.ts` if methodology semantics changed
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
| `worker/src/lib/cex-tickers.ts` | Binance and Coinbase price fetchers |
| `worker/src/lib/curve-onchain.ts` | Curve on-chain price reads |
| `worker/src/lib/price-validation.ts` | Peg-aware reasonableness validation |
| `shared/lib/pricing-pipeline-version.ts` | Methodology version metadata and changelog route |
| `src/app/methodology/methodology-sections.tsx` | Public longform pricing-pipeline methodology copy |
