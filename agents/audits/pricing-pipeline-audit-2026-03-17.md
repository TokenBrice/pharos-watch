# Pricing Pipeline Audit — 2026-03-17

**Scope**: Exhaustive code review + two live production cron runs (priceUpdatedAt 1773734446 and 1773735346, 15 min apart) across 15 representative coins.

**Pipeline version**: v2.1 (post-consensus-honesty fix)

---

## Executive Summary

The v2.1 pricing pipeline is architecturally sound: 8 independent source types, N-source consensus clustering, pool challenge guard, 4-pass fallback enrichment, and two-stage depeg detection. Major stablecoins (USDC, USDT, crvUSD, GHO) show excellent multi-source coverage and stable cross-run behavior.

However, the audit identified **3 bugs**, **5 design issues**, and **6 improvement opportunities** — several affecting depeg detection accuracy for the long tail of assets.

---

## Live Run Observations (15 Target Coins)

### Cross-Run Comparison

| Coin | Run 1 Dev | Run 2 Dev | Sources | Agree | Conf | Issues |
|------|-----------|-----------|---------|-------|------|--------|
| USDT | +5 bps | +5 bps | 8 | 8/8 | high | None — gold standard |
| USDC | +2 bps | +1 bps | 6 | 6/6 | high | None |
| GHO | +4 bps | — | 6 | 6/6 | high | None |
| crvUSD | +2 bps | +2 bps | 6 | 6/6 | high | None — Curve oracle + on-chain |
| PAXG | +26 bps | — | 6 | 6/6 | high | None — commodity working well |
| XAUT | -35 bps | — | 5 | 5/5 | high | None |
| FRAX | -66 bps | -67 bps | 6 | 5/6 | high | Pyth disagrees (DESIGN-1) |
| BOLD | +51 bps | +51 bps | 4 | 4/4 | high | DL-list absent (DESIGN-2) |
| U | +2 bps | — | 3 | 3/3 | high | Soft-only (IMPROVE-3) |
| iUSD | +2 bps | +2 bps | 1 | 1/1 | high | Single-source override (DESIGN-3) |
| dUSD | -514 bps | -510 bps | 3 | 3/3 | **low** | Pool challenge correct, depeg undetected (BUG-1) |
| KAG | -36 bps | -11 bps | 2 | 2/2 | high | 2 soft sources only (DESIGN-4) |
| ZCHF | +4 bps | — | 3 | 3/3 | high | Soft-only, no hard sources |
| GYEN | +305 bps | +282 bps | 3 | 3/3 | high | Active depeg, chronic (DESIGN-5) |
| JPYC | 0 bps | 0 bps | 3 | 2/3 | high | DEX divergence ignored (BUG-2) |
| FPI | — | — | — | — | — | Missing from peg-summary (BUG-3) |

---

## Bugs

### BUG-1 (CRITICAL): Pool-challenge-driven depegs can never be confirmed

**Observed**: dUSD shows -510 to -514 bps deviation via pool-tvl-weighted pricing with `low` confidence. The pool challenge is **correct** — dUSD is genuinely severely depegged, and the pool challenge caught what all aggregator sources (CG, DL, DEX aggregate) missed. However, `activeDepeg` is `False`: the depeg goes completely undetected.

**Root cause — circular trust failure**: The pool challenge correctly identifies that aggregators are lying about dUSD's price, replaces the price with the honest TVL-weighted pool mean, and downgrades confidence to `low`. But then the depeg detection system, seeing `low` confidence, routes the depeg to `depeg_pending` for secondary confirmation. The confirmation system checks the **exact same unreliable aggregator sources** that the pool challenge already proved wrong:

1. **Pool challenge** (`enrich-prices.ts:407-455`): Finds individual DEX pools with $100K+ TVL showing dUSD at ~$0.949. Correctly replaces the soft consensus price (~$1.00) with the TVL-weighted pool mean. Sets `confidence = "low"`, `source = "pool-tvl-weighted"`.

2. **Depeg detection** (`detect-depegs.ts:327-330`): `classifyPrimaryDepegTrust()` maps `low` confidence → `confirm_required`. Therefore `requiresConfirmation = true`, `pendingReason = "low-confidence"`. Inserts into `depeg_pending`.

3. **Depeg confirmation** (`confirm-pending-depegs.ts:140-198`): Checks secondary sources:
   - **Off-chain** (CG or DL): Fetches CoinGecko price → ~$1.00 → deviation ~0 bps → `offchainAgrees = false` (0 bps < 50 bps secondary bar)
   - **DEX aggregate** (`dex_prices.dex_price_usd`): ~$0.9988, deviation ~12 bps → `dexAgrees = false` (12 bps < 50 bps secondary bar)
   - **CEX** (Binance): dUSD not listed → `cexAgrees = null`

4. **Decision** (`confirm-pending-depegs.ts:265-269`): `offchainAgrees === false && dexAgrees === false` → **REJECTED as false positive**. The pending depeg row is deleted.

**The fundamental problem**: The pool challenge exists precisely because aggregators can be wrong. But the confirmation system trusts those same aggregators to validate what the pool challenge found. This creates a dead end: pool-challenge-driven depegs will **always** be rejected, because the confirmation sources are the ones the pool challenge proved unreliable.

The DEX aggregate (`dex_price_usd`) is particularly misleading here — it shows ~$0.9988 (only -12 bps) while individual pools show prices as low as $0.80. The aggregate appears to use different weighting or filtering than the raw pool prices in `price_sources_json`.

**Impact**: Any stablecoin that is genuinely depegged but where aggregators still report ~$1.00 (because they weight small pools, or use stale orderbooks, or cache prices) will have its depeg silently rejected. dUSD is the live example: -510 bps real depeg, `activeDepeg: False`.

**Files**:
- `worker/src/cron/enrich-prices.ts:407-455` (pool challenge — working correctly)
- `worker/src/lib/depeg-helpers.ts:139-145` (classifies `low` → `confirm_required`)
- `worker/src/cron/detect-depegs.ts:327-330` (routes to pending)
- `worker/src/cron/confirm-pending-depegs.ts:186-198, 265-269` (checks same bad sources, rejects)

**Fix**: Add individual pool prices as a fourth confirmation source type in `confirm-pending-depegs.ts`. Alongside the existing `offchainAgrees`, `dexAgrees`, and `cexAgrees` checks, add a `poolAgrees` check that loads `loadDexPoolChallengers()` and checks whether any pool with significant TVL shows deviation ≥ the secondary bar. The promotion logic (`if (offchainAgrees === true || dexAgrees === true || cexAgrees === true)`) becomes `|| poolAgrees === true`.

This keeps the existing confirmation architecture intact (including the 15-minute cooling-off window), follows the established pattern, and benefits all pending depegs — not just pool-challenge ones. For dUSD: individual pools show -510 bps, secondary bar is 50 bps → `poolAgrees = true` → promoted.

### BUG-2 (MEDIUM): JPYC 221 bps DEX divergence gets "high" confidence

**Observed**: JPYC has 2 soft-only agreeing sources (CG + DL-list) showing 0 bps deviation, but `dex-promoted` is in consensus and disagrees — DEX pools with $23.82M TVL show +221 bps. The pool challenge doesn't fire because 221 bps < 500 bps threshold.

**Root cause**: The pool challenge threshold (500 bps) is a fixed constant that doesn't account for peg type. For JPY stablecoins, 221 bps is significant (more than the 150 bps depeg threshold for non-USD pegs). Two soft aggregators agreeing within 50 bps while a $24M TVL DEX says +221 bps should lower confidence.

**Impact**: JPYC gets `primaryTrust: authoritative` based on two potentially-correlated soft sources while strong on-chain evidence suggests a different price. If JPYC actually depegged by 221 bps, the system would not detect it.

**File**: `worker/src/cron/enrich-prices.ts:412` (constant `POOL_CHALLENGE_BPS = 500`)

**Fix**: Make the pool challenge threshold peg-type-aware. For non-USD pegs, use `getDepegThresholdBps()` as the challenge threshold (150 bps) or a multiple of it (e.g., 2x = 300 bps). This catches JPYC's 221 bps divergence.

### BUG-3 (LOW): FPI-FRAX invisible in peg-summary API

**Observed**: FPI (Frax Price Index) is a tracked stablecoin (in `TRACKED_STABLECOINS`, has geckoId) but doesn't appear in the `/api/peg-summary` response.

**Root cause**: `peg-summary.ts:164` — `if (meta.flags.navToken) continue;` filters out all NAV tokens. FPI has `navToken: true` and `pegCurrency: "VAR"` (defined in `shared/lib/stablecoins/non-usd.ts:91-109`). While FPI's variable peg makes deviation scoring against a fixed reference meaningless, the blanket skip removes it from the API entirely — users checking Pharos for FPI pricing data get nothing.

**Impact**: FPI is invisible in the peg summary. Its price, source information, and confidence level are all unavailable through this API surface.

**File**: `worker/src/api/peg-summary.ts:164`

**Fix**: Include navToken/VAR-peg coins in peg-summary with deviation fields set to null, or add them to a separate section. Alternatively, if FPI intentionally shouldn't appear in peg-summary, document this and ensure another API endpoint exposes its pricing data.

---

## Design Issues

### DESIGN-1 (MEDIUM): FRAX Pyth persistent disagreement is uninvestigated

**Observed**: Across both runs, Pyth is in `consensusSources` but NOT in `agreeSources` for FRAX. The 5-source cluster (CG, DL-list, RedStone, Curve, DEX) agrees at ~$0.993, while Pyth disagrees.

**Concern**: Either Pyth has a stale/misconfigured FRAX feed (in which case the Pyth price is wasted bandwidth), or Pyth is seeing something the other sources miss. Currently there's no logging or alerting when a hard source persistently disagrees with the cluster.

**Recommendation**: Add disagree-source logging when a source with weight >= 2 disagrees in consecutive runs. Investigate the FRAX Pyth feed (feed ID `0x735f...`) for staleness or configuration issues.

### DESIGN-2 (LOW): BOLD missing from DL stablecoins list prices

**Observed**: BOLD has `llamaId: "269"` (tracked by DefiLlama) but `defillama-list` doesn't appear even in `consensusSources`. The DL stablecoins API apparently returns null/missing price for BOLD.

**Impact**: BOLD loses one potential consensus voice. Not critical since 4 other sources agree, but reduces coverage redundancy.

**Recommendation**: Monitor which tracked coins lack DL list prices and log periodically for coverage awareness.

### DESIGN-3 (MEDIUM): Protocol-redeem overrides bypass multi-source consensus

**Observed**: iUSD shows `consensusSources: ["protocol-redeem"]`, `agree: ["protocol-redeem"]`, confidence `high`. The protocol override (applied in `sync-stablecoins.ts:531-544`) completely replaces whatever the multi-source consensus found.

**Concern**: A single on-chain `eth_call` (to `RedeemController.receiptToAsset`) determines iUSD's price. If the contract returns stale data (e.g., due to a paused oracle or contract upgrade), the override is trusted blindly. The `validatePriceCandidate` bounds check only catches extreme outliers.

**Recommendation**:
- Change protocol overrides to participate as a high-weight consensus voice (weight 4-5) rather than post-consensus override
- Or: add a secondary check — if the protocol price diverges >100 bps from the consensus price (when available), log a warning and keep the consensus price

### DESIGN-4 (MEDIUM): CG+DL "high" confidence is illusory for thin assets

**Observed**: KAG (Kinesis Silver) has only 2 sources (CG + DL-list) and gets `high` confidence. Across runs, KAG swung from -36 bps to -11 bps (25 bps swing on 2 soft sources). The GT probe only targets CG-ONLY single-source assets, not CG+DL duos.

**Root cause**: The consensus algorithm treats 2 agreeing sources as "high" regardless of source independence. CG and DL-list may share upstream data (DL's stablecoins list prices likely come from CoinGecko for many assets, creating illusory agreement).

**Scope**: KAG, JPYC, and likely dozens of other thin assets have only CG+DL-list with no hard source.

**Recommendation**: Downgrade CG+DL-list-only consensus to `single-source` unless at least one hard source is present. This would surface these assets for GT probe treatment.

### DESIGN-5 (LOW): GYEN chronic depeg may be a pricing artifact

**Observed**: GYEN shows +282-305 bps deviation with 790 depeg events over its history. 3 sources agree (CG, DL-list, RedStone). The peg score is 14/100.

**Concern**: GYEN trades on exchanges at a premium to the JPY/USD rate, possibly because the exchanges CG/DL track have a persistent premium (e.g., crypto-native exchanges vs spot FX). The "depeg" may reflect market microstructure rather than genuine peg failure.

**Recommendation**: Investigate whether GYEN's peg reference (JPY/USD from FX rates) accounts for the correct benchmark. If GYEN is genuinely redeemable at the JPY/USD rate, the depeg is real. If it's a market premium, consider adjusting the threshold or annotating the coin.

**Investigation (2026-03-17)**:

- **GYEN is redeemable 1:1 for JPY** through GMO Trust (NYDFS-chartered trust company). The correct peg reference is 1 GYEN = 1 JPY.
- **CoinGecko reports GYEN/JPY at ¥1.022**, confirming a persistent ~2.2% premium over par in the crypto market.
- **Spot JPY/USD rate**: ~$0.006283. CoinGecko USD price: ~$0.006423 → **~223 bps premium** vs spot FX.
- **Exchange breakdown**: Very thin liquidity across venues. Mercado Bitcoin ~$0.00654, Uniswap V2 ~$0.00500 (stale pool), StellarTerm ~$0.00625. The CG aggregated price reflects a real market premium, not a data artifact.
- **Conclusion**: The premium is **real but reflects low liquidity and market microstructure**, not a peg failure. GYEN remains fully redeemable at par. The chronic depeg score (14/100) is overly punitive for a coin that maintains full redemption backing.
- **Action**: No code change needed now. Future consideration: add a "low-liquidity premium" annotation or adjust depeg scoring to account for coins with proven redemption that trade at small persistent premiums due to limited DEX/CEX liquidity.

---

## Improvement Opportunities

### IMPROVE-1 (HIGH): Pyth confidence interval not used in consensus weighting

**Current**: Pyth provides `confidenceBps` per feed, but this is only stored as metadata. A Pyth price with 500 bps confidence interval is weighted the same (weight 2) as one with 5 bps.

**Recommendation**: Reduce Pyth's weight to 1 when `confidenceBps > 100`, or exclude it from consensus when `confidenceBps > 200`. This would prevent low-quality Pyth feeds (like potentially FRAX) from polluting consensus while keeping high-quality feeds influential.

### IMPROVE-2 (HIGH): RedStone venue agreement not used in consensus

**Current**: RedStone returns `venueAgreementPct` (percentage of internal venues within 50 bps of median) but this is metadata-only. A RedStone price where 30% of venues agree gets the same weight as one where 100% agree.

**Recommendation**: Reduce RedStone's weight to 0 (exclude) when `venueAgreementPct < 50%`. This leverages RedStone's internal quality signal.

### IMPROVE-3 (MEDIUM): Soft-only "high" confidence coins not flagged

**Current**: U (United Stables), ZCHF, and many other coins have CG+DL+DEX consensus — all soft aggregators — classified as "high" confidence. The pool challenge only fires at 500 bps divergence.

**Recommendation**: Introduce a `"soft-high"` confidence tier for results where all agreeing sources are in the `isAllSoftSources()` set. Display this distinctly in the UI and treat it as `confirm_required` for depeg detection.

### IMPROVE-4 (MEDIUM): Disagree source logging for operational monitoring

**Current**: When a source disagrees with the cluster, it's silently noted in `disagreeSources` but not logged. Persistent disagreements (like FRAX/Pyth) go unnoticed.

**Recommendation**: Log when any weight >= 2 source disagrees for 3+ consecutive runs. This catches stale feeds, API regressions, and genuine price divergences early.

### IMPROVE-5 (LOW): Coinbase coverage could expand

**Current**: `COINBASE_KNOWN_SYMBOLS` has only 6 entries (USDT, DAI, PAXG, USDS, USD1, HONEY). Several coins in the audit set (GHO, crvUSD, BOLD) are on Coinbase Exchange but not in this list.

**Recommendation**: Verify active Coinbase Exchange USD pairs for: GHO, crvUSD, BOLD, FRAX, XAUT, TUSD, FDUSD. Each addition adds a hard source voice.

### IMPROVE-6 (LOW): Source label should preserve full source list

**Current**: `buildSourceLabel()` returns `"source1+Nmore"` for 3+ sources, hiding which sources agreed. This makes production debugging harder.

**Recommendation**: Store the full agree-sources list in the `priceSource` field (or a separate field) rather than truncating to a label. The current `agreeSources` array is already stored separately, but the label in `priceSource` is the primary observability surface.

---

## Test Coverage Assessment

Dedicated pricing test files exist for all major modules:

| File | Tests |
|------|-------|
| `price-consensus.test.ts` | Consensus algorithm, clustering, edge cases |
| `price-validation.test.ts` | Bounds checking, peg-type-aware validation |
| `enrich-prices.test.ts` | Enrichment pipeline, fallback passes |
| `pyth.test.ts` | Pyth parsing, staleness guard |
| `redstone.test.ts` | RedStone parsing, batch/retry logic |
| `curve-onchain.test.ts` | Curve get_dy, hop pricing, Vyper truncation |
| `cex-tickers.test.ts` | Binance/Coinbase parsing |
| `geckoterminal-price-probe.test.ts` | GT probe pool extraction |
| `detect-depegs.test.ts` | Depeg detection logic |
| `confirm-pending-depegs.test.ts` | Multi-source confirmation |

### Test Gaps

1. **Pool challenge logic**: No dedicated test for the pool challenge pass in `enrich-prices.ts:407-455`. The TVL-weighted replacement, threshold comparison, and `isAllSoftSources()` check are untested.
2. **Pool-challenge-driven depeg confirmation**: No integration test covering the full BUG-1 flow — pool challenge fires, routes to pending, confirmation rejects because aggregators disagree.
3. **Cross-source disagreement scenarios**: No test for when Pyth disagrees with the cluster while other sources agree (the FRAX scenario).
4. **Protocol override vs consensus conflict**: No test for when `fetchAuthoritativeLivePriceOverrides` returns a price that disagrees with the consensus.
5. **GT probe re-consensus**: The `runGtProbePass` rebuilds consensus from CG+GT but doesn't test the case where GT and CG disagree.
6. **DL list price extraction timing**: No test verifying that `dlListPrices` captures pre-override DL prices.
7. **Peg-type-aware pool challenge threshold**: No test verifying that non-USD coins (JPYC, GYEN) get appropriate challenge thresholds.

---

## Run Stability Analysis

Comparing Run 1 (t=1773734446) vs Run 2 (t=1773735346):

- **Stable coins**: USDT, USDC, crvUSD, BOLD, iUSD — deviation unchanged across runs. These have strong multi-source agreement.
- **Drifting coins**: GYEN moved from +305 to +282 bps (23 bps swing), KAG from -36 to -11 bps (25 bps swing), FRAX from -66 to -67 bps (1 bps). The swings correlate inversely with source count.
- **KAG volatility**: 25 bps swing on 2 soft sources in 15 minutes. This exceeds normal market noise for a silver-pegged token and suggests the CG+DL prices are jittery. With only 2 sources and no hard validation, this noise flows directly into depeg detection.
- **dUSD stable at low confidence**: Both runs show pool-tvl-weighted at -510 to -514 bps. The pool challenge produces a consistent and correct result — the downstream depeg detection failure is the problem, not the pricing.

---

## Architectural Observations

### Strengths
1. **Circuit breakers per source**: Graceful degradation when APIs fail
2. **Parallel fetch with sequential fallback**: Efficient use of the 6-connection pool
3. **Two-stage depeg detection**: Large-cap confirmation prevents false alerts on USDT/USDC
4. **Price validation at every boundary**: Pre-reject, post-consensus, post-enrichment
5. **Pool challenge concept**: Catching aggregator-consensus failures is forward-thinking — dUSD proves it works

### Weaknesses
1. **Circular trust in depeg confirmation**: The pool challenge proves aggregators are wrong, then the confirmation system asks those same aggregators whether the depeg is real. This is the core flaw exposed by BUG-1.
2. **Confidence is binary when it should be gradual**: "high" means anything from 8 independent sources to 2 correlated soft aggregators. A numeric confidence score (0-100) would be more informative.
3. **No source-level staleness tracking**: Individual source ages (Pyth publish_time, RedStone timestamp, DL list freshness) are checked at fetch time but not compared across sources. A consensus of 5 stale sources is still "high" confidence.
4. **Post-consensus override breaks consensus guarantees**: Protocol overrides applied after consensus can produce a price that no market source agrees with, yet it gets "high" confidence.
5. **DEX aggregate vs individual pool divergence**: The `dex_price_usd` aggregate can differ dramatically from individual pool prices (dUSD: aggregate shows -12 bps, pools show -510 bps). Any system relying on the aggregate for validation should be aware of this gap.

---

## Priority Recommendations

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| P0 | BUG-1: Fix pool-challenge depeg confirmation dead end | Medium | dUSD depeg undetected; affects any future pool-challenge coin |
| P0 | BUG-2: Peg-type-aware pool challenge threshold | Small | Prevents missed depegs on non-USD coins (JPYC) |
| P1 | DESIGN-4: Downgrade CG+DL-only to single-source | Small | Honest confidence for ~30+ thin assets |
| P1 | IMPROVE-1: Use Pyth confidence in consensus | Small | Better signal-to-noise on Pyth feeds |
| P1 | DESIGN-3: Protocol override as consensus voice | Medium | Safer iUSD/cUSD pricing |
| P1 | Test gap: Pool challenge + confirmation integration tests | Medium | Prevent regressions on BUG-1 fix |
| P2 | IMPROVE-2: Use RedStone venue agreement | Small | Better RedStone signal quality |
| P2 | IMPROVE-4: Disagree source logging | Small | Operational visibility |
| P2 | DESIGN-1: Investigate FRAX Pyth feed | Small | Resolve persistent disagreement |
| P2 | IMPROVE-5: Expand Coinbase coverage | Small | More hard sources |
| P3 | BUG-3: FPI in peg-summary | Small | UX completeness |
| P3 | IMPROVE-3: Soft-high confidence tier | Medium | Better confidence model |
| P3 | IMPROVE-6: Full source label | Small | Debugging convenience |

---

## Appendix: File Index

| File | Role |
|------|------|
| `worker/src/cron/enrich-prices.ts` | Primary consensus orchestration + pool challenge |
| `worker/src/cron/enrich-prices-passes.ts` | 4-pass fallback enrichment (DL, CMC, DexScreener) |
| `worker/src/cron/sync-stablecoins.ts` | Master orchestrator: fetch, enrich, override, validate, write |
| `worker/src/lib/price-consensus.ts` | N-source clustering algorithm |
| `worker/src/lib/price-validation.ts` | Peg-type-aware price bounds checking |
| `worker/src/lib/authoritative-price-sources.ts` | Protocol redeem overrides (cUSD, iUSD, crvUSD oracle) |
| `worker/src/lib/pyth.ts` | Pyth Hermes API client with staleness guard |
| `worker/src/lib/redstone.ts` | RedStone API client with batch/retry |
| `worker/src/lib/cex-tickers.ts` | Binance batch + Coinbase sequential |
| `worker/src/lib/curve-onchain.ts` | Curve get_dy on-chain pricing |
| `worker/src/lib/curve-pool-configs.ts` | Pool configs (19 pools across 3 patterns) |
| `worker/src/lib/geckoterminal-price-probe.ts` | GT pool-level cross-check for CG-only assets |
| `worker/src/lib/depeg-helpers.ts` | DEX row loading, trust classification, pool challengers |
| `worker/src/lib/constants.ts` | Thresholds, circuit breaker names |
| `worker/src/cron/detect-depegs.ts` | Stage 1 depeg detection |
| `worker/src/cron/confirm-pending-depegs.ts` | Stage 2 multi-source confirmation |
| `shared/lib/pricing-pipeline-version.ts` | Version tracking and changelog |
