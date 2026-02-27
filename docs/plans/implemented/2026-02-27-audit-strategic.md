# Data Pipeline Audit — Strategic Improvements (This Quarter)

> Remediation plan for architectural gaps, resilience improvements, and ongoing practices.
> These are multi-day efforts that address systemic risk rather than individual bugs.

---

## 1. Runtime Schema Validation on External API Responses

**Severity:** Critical (systemic)
**Finding:** Every cron job uses TypeScript `as { ... }` casts on external JSON without runtime validation. If any upstream API changes its response shape (field renames, type changes, added nesting), the code throws at unpredictable points — potentially after partial writes to D1. This affects `sync-stablecoins`, `enrich-prices`, `sync-dex-liquidity`, `sync-bluechip`, `sync-fx-rates`, and `sync-usds-status`.

**Affected files:**
- `worker/src/cron/sync-stablecoins.ts:284` — DefiLlama stablecoins response
- `worker/src/cron/enrich-prices.ts:306` — CMC quotes response
- `worker/src/cron/sync-dex-liquidity.ts:613` — DeFiLlama yields response
- `worker/src/cron/sync-bluechip.ts:72` — bluechip.org response
- `worker/src/cron/sync-fx-rates.ts:107` — frankfurter.app response

**Approach:**
1. Add a lightweight validation library (Zod or valibot — prefer valibot for bundle size in Workers)
2. Define schemas for each external API response shape
3. Parse with `schema.safeParse()` instead of `as` casts
4. On parse failure: log the shape mismatch, skip the write, alert via webhook, serve stale cache
5. Start with the two most critical: DefiLlama stablecoins and DefiLlama yields

**Benefits:**
- Shape mismatches caught at parse time with descriptive errors
- No partial writes — validation happens before any DB operations
- Webhook alerts when upstream APIs change shape
- Self-documenting API contracts

**Effort:** 1–2 days
**Dependencies:** None
**Verify:** Mock a malformed DefiLlama response in local wrangler dev. Confirm the cron logs a validation error, sends an alert, and does NOT write corrupted data to D1.

---

## 2. ~~Dual-Primary Prices, Supply Fallback, and Circuit Breakers~~ IMPLEMENTED

**Status:** Implemented 2026-02-27 — circuit breakers, dual-primary price validation, CG supply fallback, DEX graceful degradation. See `worker/src/lib/circuit-breaker.ts`, updated `enrich-prices.ts`, `sync-stablecoins.ts`, `sync-dex-liquidity.ts`.

**Severity:** Critical (architectural)
**Finding:** DefiLlama's stablecoins API and yields API are each single points of failure with no fallback. A 24-hour DefiLlama outage means no fresh supply, price, or liquidity data. The dashboard serves increasingly stale data with only the health endpoint reporting "stale" status — no degradation signal reaches the user or triggers recovery.

Additionally, the current pipeline treats prices as a single-source value (DL primary, CG only as a late fallback). Both DL and CG provide spot prices for nearly all tracked stablecoins — fetching both in parallel enables cross-validation that catches data quality issues during normal operation, not just during outages.

### Phase 1: Circuit breaker framework (1 day)

Generic circuit breaker that wraps any external fetch. Reused across all phases.

1. Track consecutive failures per source in a D1 counter table (`circuit_state`: source, failures, state, last_probe_at)
2. After N consecutive failures (e.g., 3), enter "circuit open" state
3. In circuit-open state: skip the fetch, serve stale cache, add a `Warning` header and set health status to "degraded"
4. Every M minutes (e.g., 30), allow a single "probe" request through
5. If probe succeeds, close the circuit and resume normal operation
6. Alert on circuit open/close transitions

### Phase 2: Dual-primary price validation (2–3 days)

Upgrade prices from single-source-with-fallback to dual-primary-with-cross-validation. This improves data quality during normal operation and provides seamless resilience during outages.

**How it works:**
1. In `enrich-prices`, fetch DL (`coins.llama.fi/prices/current`) and CG (`/simple/price`) prices **in parallel** for all coins that have a `geckoId`
2. **Both agree** (within threshold, e.g., 50bps) → use DL price, mark `priceConfidence: "high"`
3. **Disagree** (beyond threshold) → flag for investigation, use the value closer to the peg target, mark `priceConfidence: "low"`, log the discrepancy
4. **One source down** → seamlessly use the other with no degradation, mark `priceConfidence: "single-source"`
5. **Both down** → fall through to existing pass 3.5 (CMC) and pass 4 (DexScreener)
6. Store both raw prices in D1 for audit trail and historical divergence analysis

**Changes to existing enrichment pipeline:**
- Pass 1 (DL address lookup) and Pass 3 (CG direct) currently run sequentially as fallbacks. Instead, run them as parallel primary fetches for all coins with both identifiers.
- Coins with only a DL address but no `geckoId` → DL single-source (no change)
- Coins with only a `geckoId` → CG single-source (no change)
- Keep Pass 3.5 (CMC) and Pass 4 (DexScreener) as late fallbacks for coins that fail both primaries

**Benefits over the current fallback chain:**
- Catches bad prices from either source during normal operation (not just outages)
- Provides built-in depeg confirmation for all coins (currently only done for >$1B coins in `confirm-pending-depegs.ts`)
- Zero-latency failover when one source goes down — no circuit breaker delay needed for prices
- Price confidence signal available to downstream consumers (PSI, report cards, depeg detection)

**CG API budget consideration:** CG `/simple/price` accepts up to 250 comma-separated IDs per call. With ~143 stablecoins, this is a single API call per cycle. Well within free tier limits, negligible on the paid plan.

### Phase 3: CoinGecko supply fallback (2–3 days)

When the DefiLlama stablecoins API is unavailable (circuit open), fall back to CoinGecko for supply data. This is a **degraded fallback**, not a co-primary — DL provides structured data CG cannot replicate.

**What DL provides that CG cannot:**
- Per-chain circulating breakdown (`chainCirculating`)
- Peg-type-specific values (`peggedUSD`, `peggedEUR`, etc.)
- Day/week/month supply deltas (`circulatingPrevDay/Week/Month`)
- The stablecoin classification itself (peg type, peg mechanism)

**Fallback approach:**
1. When DL circuit is open, fetch CG `/simple/price?ids=...&vs_currencies=usd&include_market_cap=true` for all coins with `geckoId`
2. Map CG `usd_market_cap` → DL `circulating` shape (total only, no chain breakdown)
3. For non-USD pegs: divide `usd_market_cap` by the FX rate to approximate native-unit circulating (lossy but better than nothing)
4. Null out fields CG cannot provide: `chainCirculating`, `circulatingPrevDay/Week/Month`
5. Mark all data as `supplySource: "coingecko-fallback"` so downstream consumers know it is approximate
6. Downstream impact: chain-level views show "unavailable", supply change columns show "—", but totals and prices remain live

### Phase 4: DeFiLlama yields fallback (1–2 days)

1. When yields API circuit is open, promote CG Onchain to primary source for pool discovery
2. CG Onchain already runs during `sync-dex-liquidity` — extend it to cover all tracked coins (not just supplemental chains) during yields outage
3. Quality will be lower (no DeFiLlama pool metadata like `sigma`/`exposure`, fewer pools discovered) but liquidity scores will still update
4. Mark pools as `poolSource: "coingecko-onchain"` during fallback

**Effort:** 5–7 days total across phases
**Dependencies:** CoinGecko API key (already configured)
**Verify:**
- **Phase 1:** Block DL URLs in wrangler dev → circuit opens after 3 failures, closes on probe success
- **Phase 2:** Mock DL returning a wrong price for USDT → dual-primary flags the discrepancy, uses CG value. Block DL entirely → CG prices used seamlessly with `single-source` confidence
- **Phase 3:** Block DL stablecoins endpoint → supply data populated from CG mcap with fallback labels, chain views show "unavailable"
- **Phase 4:** Block DL yields endpoint → CG Onchain pools used, liquidity scores update with `coingecko-onchain` source label
- **All phases:** Health endpoint shows "degraded" during fallback, "healthy" when recovered

---

## 3. ~~Allow DEX Liquidity Cron to Continue Without Protocols API~~ IMPLEMENTED

**Status:** Implemented 2026-02-27 as part of item 2 (Phase 4). Both DL yields and DL protocols are now circuit-breaker-protected with graceful degradation.

**Severity:** High
**Finding:** If the DeFiLlama protocols fetch fails, the entire dex-liquidity cron aborts — even though Curve API, subgraph, and CoinGecko Onchain data was already fetched successfully. The protocols list is used for filtering dead/rugged protocols, which is useful but not critical.

**File:** `worker/src/cron/sync-dex-liquidity.ts:607`

**Approach:**
1. Make the protocols fetch best-effort: if it fails, proceed with an empty exclusion set
2. Log a warning that dead-protocol filtering is degraded
3. The impact is that pools from dead protocols may appear in results, but this is far better than losing all DEX data

**Effort:** 2 hours
**Dependencies:** None
**Verify:** Block the protocols URL in dev. Confirm cron completes with pools from all sources.

---

## 4. PSI Freshness Awareness and "DATA STALE" Band

**Severity:** Medium (architectural)
**Finding:** When upstream data is stale (DefiLlama hasn't updated), no depegs are detected and PSI shows BEDROCK (100). The health endpoint reports "stale" but the PSI itself has no freshness awareness. Users interpret "BEDROCK" as "all is well" when the dashboard may actually be blind.

**Approach:**
1. Add a freshness check in the stability-index cron: read the stablecoins cache `updated_at` and skip computation if it is > 30 minutes old
2. Store a "stale" flag in the stability_index row when input data is degraded
3. In the API response, add `inputFreshness: "fresh" | "stale"` to the current score object
4. In the frontend, when `inputFreshness === "stale"`, show a yellow warning: "PSI is based on data that may be delayed. Treat with caution."
5. Consider a dedicated "UNKNOWN" band (gray color) that displays when the score cannot be reliably computed

**Effort:** 1 day
**Dependencies:** None
**Verify:** Set the stablecoins cache `updated_at` to 1 hour ago in local D1. Confirm the PSI cron skips or marks as stale, and the frontend shows the warning.

---

## 5. Price Source Transparency in UI

**Severity:** Medium
**Finding:** The `StablecoinData` type includes a `priceSource` field ("defillama", "coingecko", "coinmarketcap", "dexscreener") but this is never displayed in the UI. A user viewing a price has no way to know if it came from CoinGecko (reliable) or DexScreener (best-effort fallback with symbol-only matching).

**Files to change:**
- `src/components/stablecoin-table.tsx` — add price source icon/tooltip in the price column
- `src/app/stablecoin/[id]/client.tsx` — show price source in the key info section
- `src/components/peg-heatmap.tsx` — add indicator for non-DefiLlama price sources

**Approach:**
- Small icon or badge next to the price: a subtle indicator (e.g., "DL", "CG", "DS") with a tooltip explaining the source
- For DexScreener specifically (least reliable), use a more prominent warning: "Price from DEX search — may be approximate"

**Effort:** 1 day
**Dependencies:** None
**Verify:** Find a coin using DexScreener as its price source. Confirm the indicator appears on the table, detail page, and heatmap.

---

## 6. Expanded Alerting Coverage

**Severity:** Medium (operational)
**Finding:** Alerts currently fire only for cron failures (thrown exceptions) and stalecoins cache staleness (>30 min). There is no alerting for: persistent enrichment failures, DEX data degradation, FX rate staleness, budget exhaustion in blacklist sync, or repeated CoinGecko 403s.

**Approach:**
1. **Enrichment failure rate alert:** If >10% of coins still have missing prices after all 5 enrichment passes, fire an alert
2. **FX rate staleness alert:** If `fx-rates` cache is >2 hours old, alert
3. **DEX data degradation alert:** If dex_liquidity updated_at for any major coin (top 20 by mcap) is >1 hour old, alert
4. **Budget exhaustion alert:** If `contractsSkipped > 0` for 3 consecutive blacklist sync runs, alert
5. **Digest failure alert:** If daily-digest cron fails, alert (it already does via `logCronRun`, but the 1-hour dedup means a morning failure won't retry until admin trigger)

**Implementation:** Extend the existing `sendAlert()` calls in each cron. Add metadata to `cron_runs` for tracking consecutive failure patterns. Consider a simple "health roll-up" function that runs at the end of each 15-min trigger and checks all subsystems.

**Effort:** 1 day
**Dependencies:** Webhook URL already configured
**Verify:** Simulate each failure condition in dev. Confirm alerts fire with descriptive messages.

---

## 7. Automated Data Quality Tests

**Severity:** Medium (process)
**Finding:** Metric computation logic has no regression test suite. The scoring functions (`computePegScore`, `computeStabilityIndex`, `scorePegStability`, `scoreDependencyRisk`, etc.) are pure functions that are ideal for unit testing but have zero tests. Bugs like CR-1 (NaN propagation) and CR-4 (active depeg cap) would have been caught by even basic tests.

**Approach — Phase 1: Unit tests for scoring functions (1–2 days)**
1. Set up Vitest (already a common choice for Workers projects)
2. Test `computePegScore` with the three scenarios from the audit report (perfect coin, recent depeg, chronic depegs)
3. Test `computeStabilityIndex` with edge cases: NaN inputs, zero mcap, extreme values
4. Test `scorePegStability`, `scoreDependencyRisk`, `scoreResilience` with boundary values
5. Test `scoreToGrade` with NaN, negative, and boundary scores

**Approach — Phase 2: Integration reconciliation (2–3 days)**
1. Nightly CI job that queries the live API and compares key metrics against CoinGecko reference data
2. Check: USDT/USDC prices within 50bps of CoinGecko, total supply within 5% of CoinGecko, no NaN/null in PSI score
3. Alert on discrepancies exceeding thresholds
4. Historical regression: store reference snapshots and compare week-over-week for unexpected jumps

**Effort:** 3–5 days total
**Dependencies:** Vitest setup, CI pipeline access
**Verify:** Run `npx vitest` and confirm all scoring function tests pass. Break a formula intentionally and confirm the test catches it.

---

## 8. Graceful Degradation Strategy

This section summarizes what the dashboard should show users when data is uncertain, rather than showing potentially wrong data with false confidence.

| Failure Condition | Current Behavior | Proposed Behavior |
|---|---|---|
| DefiLlama stablecoins down | Serve stale cache silently | Show "Data may be delayed" banner, add ⚠️ to header, `Warning` header on API |
| DefiLlama yields down | Serve stale liquidity scores | Show "Liquidity data delayed" on liquidity page, gray out liquidity column in table |
| FX rates stale > 2 hours | Compute peg deviations from stale rates | Show "(stale rate)" next to non-USD peg deviations, widen depeg threshold by 50bps |
| PSI input data stale | Show BEDROCK (100) | Show "UNKNOWN" band with gray indicator, skip daily digest PSI section |
| Price from DexScreener | Show price without source | Show "≈" prefix and "DEX estimate" tooltip |
| All enrichment passes fail | Show null price | Show "Price unavailable" explicitly, exclude from peg heatmap |
| Blacklist sync budget exhausted | Skip remaining contracts silently | Show "Partial data" indicator on blacklist page, alert operator |

**Effort:** Varies per item — implement incrementally alongside other fixes
**Principle:** Never show a confident-looking value that is actually derived from stale or degraded inputs. Either show the value with a qualification, or show an explicit "unavailable" state.

---

## Checklist

- [ ] Item 1: Runtime schema validation (Zod/valibot) for external API responses
- [ ] Item 2a: Circuit breaker framework
- [ ] Item 2b: Dual-primary price validation (DL + CG in parallel)
- [ ] Item 2c: CoinGecko supply fallback (degraded)
- [ ] Item 2d: DeFiLlama yields fallback (CG Onchain promoted)
- [ ] Item 3: DEX liquidity cron resilience without protocols API
- [ ] Item 4: PSI freshness awareness + stale band
- [ ] Item 5: Price source transparency in UI
- [ ] Item 6: Expanded alerting coverage
- [ ] Item 7: Automated data quality test suite
- [ ] Item 8: Graceful degradation across all failure modes
