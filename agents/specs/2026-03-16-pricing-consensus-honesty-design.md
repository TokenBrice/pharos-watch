# Pricing Consensus Honesty: Correlated Source Fix + Independent Cross-Checks

**Date:** 2026-03-16
**Status:** Approved (design)
**Triggered by:** GitHub issues #28, #31 (dUSD-trinity showing ~$1 despite depeg on Sonic/Ethereum)

---

## Problem Statement

137 assets receive "high" confidence based solely on CoinGecko + DefiLlama coins API agreement. The DL coins API is queried with `coingecko:{geckoId}` prefixes, meaning it returns CoinGecko-sourced data. This is a single source presented as two-source consensus.

Consequence: tokens like dUSD-trinity show "high" confidence at ~$1 while their largest DEX pools are severely depegged ($0.80 on Ethereum, $0.11 on Sonic). CoinGecko's aggregation favors small near-peg pools over large depegged ones, and our pipeline has no independent signal to challenge it.

## Root Cause (dUSD-trinity)

| Chain | Pool | TVL | Price | Volume 24h |
|-------|------|-----|-------|------------|
| Sonic | Curve dUSD/frxUSD | $17.2K | $0.114 | $143 |
| Ethereum | Curve dUSD/sfrxUSD | $838K | $0.80 | $0 |
| Ethereum | Curve dUSD/frxUSD | $10.8K | $0.993 | $0 |
| Fraxtal | Curve dUSD/FRAX | $2.4K | $0.997 | $1,647 |

CoinGecko aggregates to ~$0.995. DL coins API mirrors this. Our consensus sees two agreeing sources and stamps "high". The $838K pool at $0.80 is invisible to the pipeline.

---

## Design

### Section 1: Drop DL Coins API from Primary Consensus

**Change:** Remove the `coingecko:{geckoId}` batch fetch to `coins.llama.fi/prices/current/` from `fetchPrimaryPrices()`.

**Rationale:** This fetch returns CoinGecko-sourced data. It provides no independent signal and creates an illusion of multi-source consensus. Removing it:
- Makes CG the sole CG-sourced voice -- honestly `single-source` when alone
- Eliminates ~150 redundant API calls per sync cycle
- Frees a connection slot in the Workers 6-connection pool

**What stays:** The DL coins API is still used in fallback enrichment (`runDlContractPasses` in `enrich-prices-passes.ts`) where it queries by `{chain}:{address}`. That's a different query path with potentially different data. Only the `coingecko:` prefixed query in primary consensus is removed.

**Confidence impact after this change alone:**
- CG + any independent source (Pyth, Binance, Coinbase, RedStone, Curve, DEX-promoted) = `high` (unchanged)
- CG alone = `single-source` (was falsely `high` for 137 assets)

**Files affected:**
- `worker/src/cron/enrich-prices.ts` -- remove DL coins API fetch from `fetchPrimaryPrices()`, remove `dlPrices` map, remove DL source injection into per-asset consensus loop
- `worker/src/lib/constants.ts` -- `CIRCUIT_SOURCE.DL_COINS` kept for fallback enrichment
- `docs/pricing-pipeline.md` -- update source weights table, remove DL coins API from primary consensus docs

### Section 2: DL Stablecoins List Price as Independent Voice

For assets with a `llamaId`, the DL stablecoins list endpoint (`stablecoins.llama.fi/stablecoins?includePrices=true`) returns a price from DL's own aggregation methodology. This is genuinely independent from CoinGecko's price.

**Mechanism:**

1. In `syncStablecoins()`, after parsing the DL list payload but before calling `fetchPrimaryPrices()`, extract each asset's `.price` field into a `Map<string, number>`. This is the price already present on each `peggedAsset` from the DL response -- not a separate API call.
2. Pass this map to `fetchPrimaryPrices()` as a new parameter (`dlListPrices`).
3. In the per-asset consensus loop, if an asset has a DL list price > 0, inject it as a `defillama-list` source with **weight 1**.
4. `defillama-list` is an independent source -- it counts as a separate voice for the "2+ sources -> high" rule.

**What this recovers:** 130 assets have both `geckoId` and `llamaId`. Of those, the ones that currently have no independent source (Pyth/CEX/Curve) will recover real `high` confidence via CG + `defillama-list`. The exact count depends on runtime coverage but is estimated at ~100 assets.

**Edge cases:**
- If DL list price is null/zero/missing for an asset: no source injected, no vote.
- Supplemental assets without `llamaId` (like dUSD-trinity): never had a DL list price, remain single-source. These are the target for Section 3.

**Files affected:**
- `worker/src/cron/sync-stablecoins.ts` -- extract DL list prices before `fetchPrimaryPrices()` call, pass as parameter
- `worker/src/cron/enrich-prices.ts` -- accept `dlListPrices` parameter in `fetchPrimaryPrices()`, inject into per-asset source list

### Section 3: GeckoTerminal Pool-Level Cross-Check

For assets that remain single-source after Sections 1-2 (only CG, no DL list price, no independent oracle/CEX coverage), add a targeted GeckoTerminal probe.

**Target population:** ~27 assets have a `geckoId` but no `llamaId`. After filtering out those that already have independent source coverage (Pyth, CEX, Curve), the actual probe target is smaller.

**Mechanism:**

1. After primary consensus resolves, collect all assets where confidence = `single-source` AND the only contributing source is `coingecko`.
2. For each, look up contract addresses from `TRACKED_STABLECOINS` metadata.
3. Query GeckoTerminal: `GET /api/v2/networks/{chain}/tokens/{address}/pools?page=1` -- returns top pools sorted by reserve (TVL). One call per asset, using the first EVM contract.
4. From the response, extract the price for the highest-TVL pool. **Validate that the queried contract address matches the pool's base or quote token address** to avoid price misattribution. Use `base_token_price_usd` when the queried token is the base, `quote_token_price_usd` when it's the quote.
5. Inject as a `geckoterminal` source with **weight 1** in a second-pass consensus re-evaluation for these assets only.

**Validation gate:** The GeckoTerminal price is only used if the top pool has >= $10K TVL. Below that, the signal is noise.

**Rate limits:** GeckoTerminal free tier allows 30 req/min. The codebase already enforces 2000ms pacing (`GECKO_TERMINAL_MS` in `worker/src/lib/rate-limit.ts`). With ~27 assets at 1 contract each, the probe completes within ~54 seconds. This fits within the 15-minute sync cron window.

**Impact on dUSD-trinity specifically:** The Ethereum dUSD/sfrxUSD pool ($838K TVL, $0.80) enters as a `geckoterminal` source. It diverges from CG's $0.995 by >1900bps. The cluster algorithm fails to form a 2+ agreement cluster, dropping confidence to `low`.

**Files affected:**
- New file: `worker/src/lib/geckoterminal.ts` -- GT fetch logic, response parsing, TVL validation gate, base/quote token matching
- `worker/src/cron/enrich-prices.ts` -- second-pass consensus for single-source CG-only assets after primary consensus
- `worker/src/lib/constants.ts` -- add `CIRCUIT_SOURCE.GECKO_TERMINAL`, GT TVL threshold constant

### Section 4: Error Handling and Degradation

GeckoTerminal is a new external dependency. It must never block or degrade the existing pipeline.

**Circuit breaker:** Add `CIRCUIT_SOURCE.GECKO_TERMINAL` to the existing circuit breaker system. Standard failure threshold and cooldown. When open, affected assets stay `single-source` -- same as today.

**Timeout:** 5s per GeckoTerminal request. If a single asset's probe fails, log and skip.

**Abort-signal propagation:** The GT probe respects the cron's `AbortSignal`. It runs after primary consensus and authoritative overrides. If the sync is running low on time, the GT probe is the first thing skipped.

**Ordering in sync flow:**
1. Primary consensus (CG + DL list + Pyth/CEX/Curve/DEX) -- Sections 1-2
2. Authoritative overrides (protocol-redeem)
3. GT probe for remaining single-source CG-only assets -- Section 3
4. Fallback enrichment (DL contract, CMC, DexScreener)
5. Post-enrichment validation

**Fallback behavior:** If GT is entirely unavailable, nothing changes from today's behavior except the honest confidence reclassification from Sections 1-2. The pipeline is strictly better than the status quo regardless of GT availability.

### Section 5: Downstream Consumer Updates

The `"coingecko+defillama"` source label will no longer be produced. Several downstream consumers pattern-match on this value and must be updated.

**Depeg confirmation pipeline:**

`worker/src/cron/confirm-pending-depegs.ts` checks `priceSource === "coingecko+defillama"` (lines 143-145, 259) to decide whether to use DL or CG as the secondary confirmation source. After this change:
- `"coingecko+defillama-list"` replaces `"coingecko+defillama"` for assets with DL list price
- `"coingecko"` for single-source assets
- Update the pattern match to check for `priceSource.startsWith("coingecko")` or maintain an explicit set including `"coingecko+defillama-list"`

**DEWS scoring -- first-deploy spike mitigation:**

`worker/src/lib/dews.ts` scores `priceConfidence` in `computePriceSignal()`:
- `high` = 0 points, `single-source` = 25 points (weight 0.15 = ~3.75 DEWS points)
- On first deploy, assets shifting from `high` to `single-source` also trigger the `prevPriceConfidence` degradation bonus (+15 points), potentially adding ~6 DEWS points total

**Mitigation:** On the first sync cycle after deploy, suppress the `prevPriceConfidence` degradation bonus. Detect this by checking if the previous confidence was `"high"` and the current is `"single-source"` with `priceSource === "coingecko"` (i.e., the shift is due to the pipeline change, not a real data quality degradation). Alternatively, accept the one-time spike and let it resolve naturally on the next cycle (since `prevPriceConfidence` will then match `priceConfidence`).

**PriceSourceHealth type and status dashboard:**

- `shared/types/status.ts` -- `PriceSourceHealth.sourceDistribution` has a hardcoded `"coingecko+defillama"` key. Replace with `"coingecko+defillama-list"` and add `"geckoterminal"`.
- `src/components/status/price-source-health.tsx` -- renders `sd["coingecko+defillama"]` as "CG+DL". Update to render the new keys.
- `worker/src/cron/sync-stablecoins.ts` (lines 691-765) -- source distribution counting logic. Update the hardcoded `"coingecko+defillama"` bucket and add `"defillama-list"` and `"geckoterminal"` to the `INDIVIDUAL_SOURCE_KEYS` set (line 691).

**Price transparency card:**

`src/components/stablecoin-detail/price-transparency-card.tsx` has a `KNOWN_SOURCES` array. Add `"defillama-list"` and `"geckoterminal"` with display labels.

**Documentation:**
- `docs/api-reference.md` -- lists `"coingecko+defillama"` as a known `priceSource` value
- `docs/depeg-detection.md` -- references `"coingecko+defillama"` in secondary confirmation logic

**Coverage page:**

`src/lib/coverage.ts` uses `priceConfidence` and `consensusSources` for coverage status. Assets shifting from "high" to "single-source" will change coverage results. This is an accurate reflection of reality -- no code change needed, but worth noting as a visible change.

### Section 6: Observability and Monitoring

**Source distribution tracking:** Update `priceSourceHealth.sourceDistribution` buckets:
- Remove `"coingecko+defillama"` (will no longer be produced)
- Add `"coingecko+defillama-list"` -- assets where DL list price participated in consensus
- Add `"geckoterminal"` -- assets where GT probe contributed

**Confidence shift logging:** `[primary-prices] N assets: X high, Y single-source (Z CG-only probed via GT)`

**GT probe summary log:** `[gt-probe] Probed N assets: M prices obtained, K divergences >500bps, J skipped (low TVL)`

**`priceSource` label changes:** New source names appear in labels: `coingecko+defillama-list`, `coingecko+geckoterminal`, etc. The existing `buildSourceLabel()` compression works unchanged.

---

## File Change Summary

| File | Change |
|------|--------|
| `worker/src/cron/enrich-prices.ts` | Remove DL coins API fetch from primary consensus; accept `dlListPrices` param; add GT second-pass |
| `worker/src/cron/sync-stablecoins.ts` | Extract DL list prices before `fetchPrimaryPrices()`; pass to function; update source distribution counting |
| `worker/src/lib/geckoterminal.ts` | **New.** GT fetch, response parsing, TVL gate, base/quote token matching |
| `worker/src/lib/constants.ts` | Add `CIRCUIT_SOURCE.GECKO_TERMINAL`, GT constants |
| `worker/src/cron/sync-stablecoins/shared.ts` | New source distribution buckets |
| `worker/src/cron/confirm-pending-depegs.ts` | Update `"coingecko+defillama"` pattern matches for new source labels |
| `worker/src/lib/dews.ts` | Add first-deploy spike mitigation for confidence reclassification |
| `shared/types/status.ts` | Update `PriceSourceHealth.sourceDistribution` keys |
| `src/components/status/price-source-health.tsx` | Update rendering for new source distribution keys |
| `src/components/stablecoin-detail/price-transparency-card.tsx` | Add `defillama-list` and `geckoterminal` to `KNOWN_SOURCES` |
| `docs/pricing-pipeline.md` | Update source table, document DL list + GT sources, remove DL coins from primary |
| `docs/api-reference.md` | Update known `priceSource` values |
| `docs/depeg-detection.md` | Update secondary confirmation source logic docs |
| `src/app/methodology/methodology-sections.tsx` | Update pricing methodology copy |
| `worker/src/cron/__tests__/enrich-prices.test.ts` | Update hardcoded `"coingecko+defillama"` fixture |
| `worker/src/cron/__tests__/sync-stablecoins.test.ts` | Update hardcoded `"coingecko+defillama"` fixtures |
| `worker/src/api/__tests__/status.test.ts` | Update `PriceSourceHealth` fixture keys |
| `worker/src/api/__tests__/stablecoin-summary.test.ts` | Update `priceSource` fixture |
| Tests (new) | Unit tests for GT fetch, consensus with DL list source |

## Migration Notes

- No D1 schema changes required.
- Confidence distribution will shift on first deploy. Approximately 130 assets with both `geckoId` and `llamaId` will recover real `high` confidence via DL list price (Section 2). The remaining ~27 assets with `geckoId` only will show as `single-source` until the GT probe (Section 3) provides an independent signal.
- The `priceSource` field value `"coingecko+defillama"` will no longer be produced. New values include `"coingecko+defillama-list"`, `"coingecko+geckoterminal"`, and plain `"coingecko"`.
- DEWS scores for affected assets may temporarily spike by ~3.75 points on the first cycle due to the confidence reclassification. This resolves on the second cycle. See Section 5 for mitigation options.
- The `"coingecko+defillama"` key in `PriceSourceHealth.sourceDistribution` must be replaced before deploy, otherwise the status dashboard will show stale data.
