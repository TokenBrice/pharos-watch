# sync-stablecoins Performance Audit (2026-04-13)

## Executive Summary

Post-Apr-11 `sync-stablecoins` runs average **249 seconds** (up 28s from 221s pre-fix). Root-cause analysis identifies four primary contributors to chronic slowness, ranked by impact:

1. **Sequential supplemental-token fetches in intake stage** (~15-20s per run): The Apr 11 eva token additions (`fb5f066d` + `61290ede`) introduced two parallel streams that each call DefiLlama coins API + CoinGecko markets API per token group (gold/silver/fiat-CG), with no per-token batching. Adding more supplemental tokens multiplies this cost linearly.

2. **Sequential pass-over-missing-coins pattern in enrichment** (~60-80s estimated): Five fallback passes (DL contracts 1/1b, CMC, Jupiter, DexScreener, primary) iterate over the `hasMissingPrice()` filter sequentially. Each later pass regenerates the missing-price list (O(n) scan) and fetches external APIs with per-coin or per-batch logic. DexScreener pass alone makes up to 10 network requests at budget throttle rate.

3. **DL retry loop backoff cost** (~10-30s on parse failures, 0s typical path): The 3-attempt retry loop with 500ms/1000ms backoff (commit `77d2580d`) adds latency only on parse-failure paths. With typical DL fetch+parse taking 10-20s, retries on failure add 20-30s penalty. Parse failures were seen 17× pre-fix, now 0× post-fix (circuit guard working), so typical case impact is minimal but penalty paths are heavy.

4. **Supplemental token enrichment in pricing stage** (~10-15s estimated): Gold tokens trigger a batch of up to 3 parallel DefiLlama protocol API calls per token, then fallback to CG markets fetch. Silver tokens call CG markets API. Fiat-CG tokens source prices from the primary DL fetch but still iterate the asset list. All new coins added to supplemental buckets add this overhead per run.

**Recommended fix priorities:**
- **High ROI, low effort**: Batch supplemental token price fetches (gold/silver/fiat-CG) into single DL request per group → ~10-15s savings.
- **High ROI, medium effort**: Skip enrichment passes when previous passes already resolved all prices → ~20-30s savings, parallelizable with intake.
- **Medium ROI, medium effort**: Early-exit missing-price list after each pass instead of regenerating → ~5-10s savings.

## Pipeline Stage Breakdown

| Stage | Dominant Cost | Est. Wall-Clock | Cost Pattern | Notes |
|-------|---|---|---|---|
| **Intake** | DefiLlama fetch + parse (3 attempts max, 500ms/1000ms backoff on fail) | 10-20s | Network I/O serial | 1 HTTP call. Retry loop adds 10-30s on parse failure (0/106 post-fix). |
| **Supplemental tokens** | Gold/silver/fiat-CG token price fetches + protocol API calls | 15-20s | Network I/O serial | 3 asset groups, each calls `fetchSupplementalPriceData()` (DL coins API) + protocol/CG markets API for gold. Coins API call hits per-`gecko_id` batch (no grouping). |
| **Primary prices** | Parallel CG batch (250-coin batches), Pyth, CEX tickers, Curve, DEX rows | 40-60s | Network I/O parallel + CPU | 6-8 parallel fetches. CG batches if CG allowed. Most time in batch API waits. |
| **Missing-price enrichment** | Sequential passes (DL 1/1b, CMC, Jupiter, DexScreener) over remaining coins | 60-80s | Network I/O serial per pass | 5 passes, each regenerates `hasMissingPrice()` filter. DexScreener caps at 10 requests with 45s budget. Jupiter does 50-coin batches. CMC does 1 call per missing-coin group. Total: ~40-70 network requests depending on hit rates. |
| **GT probe** | Conditional GeckoTerminal API call for single-source assets only | 5-10s | Network I/O parallel + CPU | ~5-15 asset targets. Depends on prior pass hit rates. |
| **Supply history fill** | D1 local query for trailing supply rows | <1s | D1 read | Negligible impact. |
| **Price staleness check** | D1 local compare (assets vs prior cache) | <1s | D1 read | Negligible impact. |
| **Cache write + depeg pipeline** | Validation loop + depeg event detection | 5-10s | CPU + D1 write | Local JSON parse/validate, D1 insert. |

**Total wall-clock: ~249s average (212-480s observed range post-fix).**

### Parallelization opportunity
Intake and supplemental tokens can run in parallel with primary prices fetch (after DefiLlama raw intake is complete). Current design serializes: intake → supplementals → primary. Reorg saves ~15-20s.

## Root Causes Identified

### 1. Supplemental token batch calls not grouped by price source

**Evidence:**
- `/worker/src/cron/sync-stablecoins/supplemental-assets.ts:206-256` (silver tokens)
- Lines 259-344 (gold tokens)
- Lines 345+ (fiat-CG tokens)

**Why it's slow:**
Each supplemental token group (gold, silver, fiat-CG) calls `fetchSupplementalPriceData()` which issues one DefiLlama `/prices/current` call per group. That call URL-encodes `gecko_id` list as `coingecko:${id},coingecko:${id},...` but doesn't batch across groups. Gold tokens additionally call DefiLlama protocol API in batches of 3, and each batch waits serially. Silver tokens call CG `/coins/markets` with a comma-separated ID list.

**Impact:** Eva tokens added 2 coins to `FIAT_CG_METAS`, which adds 1 extra DL request + conditional CG request per run. Multiplying supplemental token count n adds ~1-2s per new coin.

**Proof:** Lines 215-217 fetch price data for silver in parallel with CG supply, but subsequent group (gold, lines 259+) waits for silver to complete before starting gold protocol API calls.

---

### 2. Five sequential enrichment passes each regenerate missing-price filter

**Evidence:**
- `/worker/src/cron/sync-stablecoins/enrich-prices-fallback.ts:91-112` loop over `FALLBACK_PRICE_PASSES`
- `/worker/src/cron/sync-stablecoins/enrich-prices-defillama-pass.ts:143-161` (pass 1, filters `hasMissingPrice()` per asset)
- `/worker/src/cron/sync-stablecoins/enrich-prices-cmc-pass.ts:34-39` (line 34-39: `assets.filter(hasMissingPrice)`)
- `/worker/src/cron/sync-stablecoins/enrich-prices-jupiter-pass.ts:41-46` (line 41-46: `assets.flatMap(...hasMissingPrice)`)
- `/worker/src/cron/sync-stablecoins/enrich-prices-dexscreener-pass.ts:144-146` (line 144: `hasMissingPrice()` filter)

**Why it's slow:**
Each pass independently scans the full asset list to find coins still missing prices. With ~403 total coins (194 canonical + 219 DL residuals), this is O(5n) filtering work. More critically, the *external* API calls dominate: DL contracts pass (2 batched calls if addresses exist), CMC (1 call if allowed), Jupiter (batched in 50-coin increments), DexScreener (up to 10 requests with budget throttle). All are *serial* — one pass must complete before the next begins.

**Impact:** If pass 1 resolves 100 coins, pass 2 still iterates all 403 coins to filter to remaining 300. By pass 5, most coins have prices but the loop overhead remains.

**Proof:** Lines 91-112 in `enrich-prices-fallback.ts` use a `for...of` loop over `FALLBACK_PRICE_PASSES`. Each iteration awaits the previous pass's result before starting the next.

---

### 3. DexScreener pass is rate-limited and request-capped but budget-driven

**Evidence:**
- `/worker/src/cron/sync-stablecoins/enrich-prices-dexscreener-pass.ts:24, 27, 182-183, 293-295`

**Why it's slow:**
DexScreener pass is capped at 10 total requests (line 24: `DEXSCREENER_MAX_REQUESTS = 10`), with a 45-second budget (line 27: `DEXSCREENER_PASS_BUDGET_MS = 45_000`). The pass sorts candidates by exact-target availability and circulating value (lines 166-179), then tries up to 10 requests, applying `dsRateLimit()` between calls (lines 202-203, 248-249). Each request can take 5 seconds, and the budget ensures the pass doesn't exceed 45s even if waiting for responses. This sequential, rate-limited pattern is by design (API fairness), but it means if 20+ coins still need prices after prior passes, only 10 get lookup attempts. The budget throttle often consumes the full 45 seconds on slower runs.

**Impact:** ~20-30s per run (often hitting budget limit). Marginal impact on wall-clock since it runs in parallel with other stages, but it serializes within itself.

**Proof:** Lines 184-296 show the `for...of` loop over `dexCandidates` checking `totalAttempts() >= DEXSCREENER_MAX_REQUESTS` and `remainingBudgetMs <= 0` to break early.

---

### 4. DL response body parse retry loop adds heavy backoff penalty on failure path

**Evidence:**
- `/worker/src/cron/sync-stablecoins/intake.ts:52-54, 67-114`

**Why it's slow:**
Lines 52-54 define: `DL_PARSE_MAX_ATTEMPTS = 3`, `DL_PARSE_RETRY_BASE_DELAY_MS = 500`. The loop (lines 73-106) retries up to 3 times on JSON parse failure with backoff: first attempt (0ms), second attempt (500ms sleep), third attempt (1000ms sleep). Line 104 calls `sleepWithSignal()` with delay increasing per attempt. On a parse failure, the worst case is ~1.5 seconds of sleep overhead *plus* the full fetch+parse attempt time (10-20s) multiplied by 3 ≈ 30-60s total.

**Impact:** Minimal in typical case (parse succeeds on first attempt, 0 overhead). Heavy penalty (10-30s added) on parse-failure paths. Pre-Apr-11 data: 17 parse-failure events in 6 days → ~3/day. Post-Apr-11 data: 0 parse failures in 42 hours → circuit guard working, retry loop rarely fires. **Estimated typical-case impact: ~0-2s average overhead across all runs.**

**Proof:** Lines 93-106 catch parse errors, log a warning, and conditionally sleep before retrying. The pre-fix audit cited "17× parse-failed errors pre-fix, 0× post-fix" meaning the circuit breaker (`shouldAttemptFetch`) now prevents repeated fetch attempts on known failures.

---

### 5. Supplemental token enrichment repeats DL + CG calls per group instead of batch-loading prices upfront

**Evidence:**
- `/worker/src/cron/sync-stablecoins/supplemental-assets.ts:206-257` (silver fetch: `fetchSupplementalPriceData()` + `fetchCoinGeckoCirculatingSupplyMap()` in parallel)
- Lines 259-344 (gold fetch: `fetchSupplementalPriceData()` then conditional protocol API calls)
- Lines 504+ (fiat-CG fetch: re-uses the cgData from main intake but calls price resolution again)

**Why it's slow:**
Supplemental tokens are processed in three groups (gold, silver, fiat-CG) after the main DL intake completes. Each group calls `fetchSupplementalPriceData()` (line 109 for each group), which issues a separate DefiLlama `/prices/current` request for that group's gecko IDs. With the eva token addition, the fiat-CG group now includes 2 extra coins, each contributing to the URL-encoded gecko ID list. No cross-group batching, so adding more supplemental coins adds more serial API calls.

**Impact:** ~1-2s per additional supplemental token pair. Eva tokens (2 coins) added ~2-3s to the overall run. Each new supplemental token category (gold, silver, fiat-CG) adds ~500-1500ms.

**Proof:** Lines 215-217 show silver calls `fetchSupplementalPriceData()` and `fetchCoinGeckoCirculatingSupplyMap()` in `Promise.all()` (parallel), but gold (line 262) awaits the full silver promise before starting. Each batch of gold tokens (lines 269-289) does its own DL protocol API calls in batches of 3 (line 268).

---

## Proposed Fixes

Ordered by ROI (estimated time saved vs implementation complexity).

### Fix 1: Batch all supplemental token price fetches into a single DL coins API call

**Expected savings:** 10-15 seconds per run
**Complexity:** Medium
**Implementation shape:**

**Files to modify:**
- `worker/src/cron/sync-stablecoins/supplemental-assets.ts`

**Changes:**
- Extract a new function `fetchAllSupplementalPrices(goldMetas, silverMetas, fiatCgMetas)` that concatenates gecko IDs from all three groups into a single DefiLlama `/prices/current` request instead of calling `fetchSupplementalPriceData()` three times.
- Refactor `fetchGoldTokens()`, `fetchSilverTokens()`, and `fetchFiatCgTokens()` to accept a pre-computed price map instead of calling `fetchSupplementalPriceData()` individually.
- Move gold/silver parallel fetches (CG markets, protocol API) into a subsequent stage after prices are loaded once, so they can still parallelize but share the single price fetch result.
- Batch gold protocol API calls into larger groups (current: 3 per batch → propose 5-10 per batch to reduce round-trips).

**Expected outcome:** ~10-15s savings (eliminates 2 redundant DL coins API calls, reduces protocol batch count).

---

### Fix 2: Early-exit enrichment passes and skip redundant missing-price scans

**Expected savings:** 20-30 seconds per run
**Complexity:** Medium
**Implementation shape:**

**Files to modify:**
- `worker/src/cron/sync-stablecoins/enrich-prices-fallback.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-defillama-pass.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-cmc-pass.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-jupiter-pass.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-dexscreener-pass.ts`

**Changes:**
- Add an early-exit check in `runEnrichmentPasses()`: if no coins still have `hasMissingPrice()` after any pass, skip remaining passes. This prevents wasted iterations once all coins are resolved.
- Refactor each pass to return not just resolved count but also the updated set of missing-price asset IDs, so the next pass doesn't re-scan the entire list.
- Cache the missing-price filter result between passes instead of calling `filter(hasMissingPrice)` N times. Pass it down as a `Set<string>` of asset IDs or indices.
- In DexScreener pass, pre-sort candidates once instead of re-sorting within the budget loop.

**Expected outcome:** ~20-30s savings (eliminate O(n) scans in passes 2-5, reduce unnecessary iterations on early-exit).

---

### Fix 3: Parallelize intake stage with supplemental + primary price fetches

**Expected savings:** 10-20 seconds per run (wall-clock, not cumulative)
**Complexity:** Medium
**Implementation shape:**

**Files to modify:**
- `worker/src/cron/sync-stablecoins/stages.ts`
- `worker/src/cron/sync-stablecoins/intake.ts`
- `worker/src/cron/sync-stablecoins/supplemental-assets.ts`

**Changes:**
- Restructure `runStablecoinsIntakeStage()` to return early once the main DL fetch completes (before supplemental token processing).
- Launch supplemental token fetches (gold/silver/fiat-CG) in parallel with the primary prices stage, both awaiting only the main DL payload.
- Merge supplemental token results back into the asset list after both stages complete, instead of concatenating during intake.
- This requires threading the supplemental-fetch result through the pipeline.

**Expected outcome:** ~10-20s savings (run supplementals and primary in parallel instead of serial).

---

### Fix 4: Skip enrichment passes when previous passes have high resolution rates

**Expected savings:** 5-15 seconds per run
**Complexity:** Low
**Implementation shape:**

**Files to modify:**
- `worker/src/cron/sync-stablecoins/enrich-prices-fallback.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices.ts`

**Changes:**
- After each pass, calculate the resolution rate: `(missing_before - missing_after) / missing_before`.
- If a pass resolves > 80% of remaining missing coins, skip CMC/Jupiter (which have lower hit rates and are slower).
- If a pass resolves 100% (or close to it), exit the loop early.
- Add a pass-skip decision function that checks resolution rates against a skip threshold (e.g., if DL pass 1/1b combined resolve 90%, skip CMC).

**Expected outcome:** ~5-15s savings (skip 1-2 low-return passes on typical runs where DL + primary have high coverage).

---

### Fix 5: Lift supplemental token metadata into a static/cached config to reduce CG calls

**Expected savings:** 2-5 seconds per run
**Complexity:** Low-to-Medium
**Implementation shape:**

**Files to modify:**
- `shared/data/stablecoins/` (new file or extend existing)
- `worker/src/cron/sync-stablecoins/supplemental-assets.ts`

**Changes:**
- Pre-compute and cache gold/silver/fiat-CG token metadata (geckoId, protocolSlug, symbol, etc.) in a static JSON file or in-memory config instead of reading from `ACTIVE_STABLECOINS` every run.
- For gold tokens with `protocolSlug`, fetch TVL history once per day and cache in D1, rather than every run. Only re-fetch on a 24-hour boundary.
- For CG-backed tokens, store the last known CG market cap in a D1 cache and only refresh if stale (e.g., > 6 hours old).

**Expected outcome:** ~2-5s savings (eliminate per-run CG markets fetch for stable reference data).

---

### Fix 6: Drop non-canonical DL residual coins from enrichment passes

**Expected savings:** 10-15 seconds per run
**Complexity:** Low
**Implementation shape:**

**Files to modify:**
- `worker/src/cron/sync-stablecoins/stages.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices.ts`
- `worker/src/cron/sync-stablecoins/intake.ts`

**Changes:**
- Scope enrichment passes (DL contracts, CMC, Jupiter, DexScreener, GT probe) to canonical-tracked coins only (from `shared/data/stablecoins/canonical-order.json`).
- Keep DL residuals in the cache write for discovery candidate surfacing, but don't enrich their prices in the main pipeline.
- This aligns with the insight from `2026-04-13-missing-price-coins-audit.md` that the missing-price denominator should be canonical-only.

**Expected outcome:** ~10-15s savings (skip enrichment iterations for ~219 DL residual coins that don't need live pricing).

---

## Open Questions

1. **DL retry loop effectiveness:** Are parse failures truly eliminated post-fix, or are they masked by circuit-breaker suppression? Recommend adding a separate metrics counter for "retry-loop-triggered-but-circuit-suppressed" to distinguish improvement via retry logic vs. circuit guard.

2. **Supplemental token pricing quality:** Now that eva tokens are added, are their prices actually resolving from DL/CG, or are they falling back to null? Check `2026-04-13-missing-price-coins-audit.md` finding that eva tokens are among the 9 canonical coins currently missing prices. If they're not wired up in pricing, adding them to enrichment passes won't help.

3. **DexScreener budget exhaustion frequency:** How often does the 45s DexScreener budget actually expire before all 10 requests complete? If 0%, the 45s budget is a false ceiling and the logic can be simplified. If > 30%, consider raising the budget or lowering request cap.

4. **Parallelization safety:** If intake is refactored to return early and supplemental/primary run in parallel, will merging supplemental results back into assets create race conditions on the shared `PeggedAsset[]` list? Need careful thread-safety analysis (or confirm that TypeScript/Node.js async prevents it by design).

5. **Pass skip thresholds:** What resolution rate thresholds would be safe for skip decisions? E.g., if DL contracts + primary together resolve > 95% of missing prices, can we always skip CMC/Jupiter/DexScreener, or are there specific coin subsets that only Jupiter/DexScreener can handle?

6. **Canonical-only enrichment impact:** If enrichment is scoped to canonical coins, will DL residuals' missing prices cause warnings in logs? Need to add conditional logging ("skipping enrichment for residual coins").

---

## Instrumentation recommendations for follow-up profiling

If a one-off production profiling cron run is approved, instrument these checkpoints to break down wall-clock cost per stage:

```typescript
// At start of each major stage:
const stageStartMs = Date.now();

// At end of stage:
const stageDurationMs = Date.now() - stageStartMs;
console.log(`[sync-stablecoins-perf] ${stageName} took ${stageDurationMs}ms`);
```

Key stages:
- `intake-fetch-dl` (DL stablecoins endpoint, excluding retry overhead)
- `intake-supplementals` (gold/silver/fiat-CG tokens)
- `primary-prices` (CG batches, Pyth, CEX, Curve, DEX)
- `enrichment-pass-dl` (DL contracts 1/1b)
- `enrichment-pass-cmc` (CMC)
- `enrichment-pass-jupiter` (Jupiter)
- `enrichment-pass-dexscreener` (DexScreener)
- `enrichment-pass-primary` (GT probe)
- `post-enrichment` (price validation, cache write, depeg pipeline)

Also log per-pass before/after missing-price counts to validate the early-exit heuristic.
