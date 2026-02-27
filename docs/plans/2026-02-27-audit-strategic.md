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

## 2. DefiLlama Redundancy and Circuit Breaker

**Severity:** Critical (architectural)
**Finding:** DefiLlama's stablecoins API and yields API are each single points of failure with no fallback. A 24-hour DefiLlama outage means no fresh supply, price, or liquidity data. The dashboard serves increasingly stale data with only the health endpoint reporting "stale" status — no degradation signal reaches the user or triggers recovery.

**Approach — Phase 1: Circuit breaker (1 day)**
1. Track consecutive failures per source in a D1 counter table
2. After N consecutive failures (e.g., 3), enter "circuit open" state
3. In circuit-open state: skip the fetch, serve stale cache, add a `Warning` header and set health status to "degraded"
4. Every M minutes (e.g., 30), allow a single "probe" request through
5. If probe succeeds, close the circuit and resume normal operation
6. Alert on circuit open/close transitions

**Approach — Phase 2: CoinGecko supply fallback (3–5 days)**
1. When DefiLlama stablecoins API is unavailable (circuit open), fall back to CoinGecko for supply data
2. CoinGecko `/coins/markets` can provide market cap and price for coins with `geckoId`
3. Map CoinGecko mcap to the DefiLlama `circulating` shape
4. Mark the data as `source: "coingecko-fallback"` so downstream consumers know it is approximate
5. Limitations: CoinGecko does not provide per-chain breakdown or peg-type-specific circulating. These fields would be null during fallback.

**Approach — Phase 3: DeFiLlama yields fallback (2 days)**
1. When yields API is unavailable, fall back to CoinGecko Onchain pool discovery
2. CG Onchain already runs during `sync-dex-liquidity` — extend it to be the primary source during yields outage
3. Quality will be lower (no DeFiLlama pool metadata, fewer pools discovered) but liquidity scores will still update

**Effort:** 3–5 days total across phases
**Dependencies:** CoinGecko API key (already configured)
**Verify:** Simulate DefiLlama downtime by blocking the URLs in wrangler dev. Confirm:
- Circuit opens after 3 failures
- Fallback data appears with appropriate source labels
- Health endpoint shows "degraded"
- Circuit closes when DeFiLlama comes back

---

## 3. Allow DEX Liquidity Cron to Continue Without Protocols API

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
- [ ] Item 2: Circuit breaker + CoinGecko fallback for DefiLlama
- [ ] Item 3: DEX liquidity cron resilience without protocols API
- [ ] Item 4: PSI freshness awareness + stale band
- [ ] Item 5: Price source transparency in UI
- [ ] Item 6: Expanded alerting coverage
- [ ] Item 7: Automated data quality test suite
- [ ] Item 8: Graceful degradation across all failure modes
