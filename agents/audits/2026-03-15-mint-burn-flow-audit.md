# Mint/Burn Flow Tracker — Reliability Audit

**Date:** 2026-03-15
**Scope:** End-to-end audit of the mint/burn flow tracking feature: cron ingestion, shared pipeline, API endpoints, scoring, contract configs, frontend, and test coverage.
**Method:** Code review of all feature files, test suite verification (231 files / 2043 tests — all green), live API probe, and cross-layer consistency checks.

---

## Executive Summary

The mint/burn flow tracker is a **well-engineered, production-stable feature**. The core pipeline — event parsing, hourly aggregation, scoring, and API serving — is architecturally sound with good separation of concerns (shared pipeline, two-lane cron, cache fallback). The live API returns fresh data with no warnings, and 82 coins are tracked with full coverage status.

The feature is **healthy enough to expand coverage** but has specific reliability gaps that should be addressed first. The most impactful findings are in **test coverage** and **operational observability**, not in the core data path. No data corruption or silent data loss was found in production.

### Findings by Severity

| Severity | Count | Summary |
|----------|-------|---------|
| High | 3 | Test gaps for custom event parsing, cross-run roundtrip detection gap, N+1 admin query |
| Medium | 6 | Price heal provenance, FTQ fallback gap, hourly gap-fill ambiguity, partial coverage edge case, documentation drift, reclassify performance |
| Low | 5 | Sorting UX choice, schema strictness, minor frontend edge cases |

---

## High Severity

### H1. Zero test coverage for USDT Issue/Redeem and reUSD custom event parsing

**Impact:** These are the two non-standard event types in the tracker. If parsing breaks (wrong data slot, wrong amount encoding), events silently disappear from the flow data with no test to catch the regression.

**Details:**
- USDT uses `Issue(uint256)` / `Redeem(uint256)` events with `amountEncoding: "first-data-uint256"`. The `Issue()` function does NOT emit a Transfer event, so this is the **only** way to detect USDT treasury mints. Zero test coverage.
- reUSD uses two vault contracts with `Deposited(address,address,uint256)` (`dataSlot=2`, `amountEncoding: "nth-data-uint256"`) and `InstantRedemptionProcessed(address,uint256,uint256)` (`first-data-uint256`). Zero test coverage for either.
- The parser at `worker/src/lib/mint-burn-pipeline/parse.ts:69-70` handles these via `decodeUint256AtSlot()`, but no test exercises it with `dataSlot > 0` or `first-data-uint256` encoding.

**Recommendation:** Add targeted unit tests for `parseMintBurnLogs()` with mock logs using each non-standard `amountEncoding` and `dataSlot` value. These tests should verify the correct amount is decoded and that dust filtering works at the right scale.

### H2. Cross-run atomic roundtrip detection is structurally incomplete

**Impact:** If a mint and its corresponding burn land in different cron runs (e.g., budget splits them across two 20-minute cycles), the roundtrip is not detected because `detectAtomicRoundtrips()` only sees the current run's `allParsedRows`.

**Details:**
- `worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts:8-33` groups by `(tx_hash, stablecoin_id)` within the current batch only.
- Within a single run, roundtrip detection works correctly — it runs BEFORE `insertMintBurnRows()` at `sync-mint-burn.ts:636-648`, so the mutated `flow_type` IS persisted to the database.
- The `POST /api/reclassify-atomic-roundtrips` admin endpoint exists as a safety net for historical cleanup.
- However, there is **no automated mechanism** to catch cross-run roundtrips. The admin endpoint must be manually triggered.

**Recommendation:** Add a periodic automated scan (e.g., weekly cron or post-cron sweep) that checks for `(tx_hash, stablecoin_id)` groups with both directions but `flow_type = 'standard'`. Alternatively, run the reclassification logic at the end of each cron job for the recently-inserted time window. This becomes more important as coverage expands to more chains where block reorgs and split scans are more common.

### H3. N+1 query pattern in `reclassify-atomic-roundtrips` admin endpoint

**Impact:** The endpoint issues up to 1001 separate D1 queries per invocation (1 discovery + up to 1000 per-group lookups). On a large backlog, this risks hitting D1's 30-second per-statement timeout or overall CPU limits.

**Details:**
- `worker/src/api/reclassify-atomic-roundtrips.ts` first discovers up to 1000 `(tx_hash, stablecoin_id)` groups, then queries each group individually.
- A compound `IN` query or a single `JOIN`-based approach would reduce this to 2-3 queries total.

**Recommendation:** Rewrite to batch-fetch all candidate rows in a single query, then process in memory. This is especially important if automated periodic sweeps are added (per H2).

---

## Medium Severity

### M1. Price heal uses `cached.updatedAt` as `price_timestamp` — minor provenance concern

**Details:** At `worker/src/lib/mint-burn-pipeline/price-heal.ts:83`, the `price_timestamp` column is set to the `price_cache` table's last update time, not the event's block timestamp. This is semantically correct — `price_timestamp` tracks when the price was sourced, not when the event occurred (the `timestamp` column holds that). However, the field name is ambiguous, and if `price_cache` hasn't been updated in days, the `price_timestamp` could suggest stale pricing even if the price is still accurate.

**Recommendation:** No code change needed. Add a comment clarifying the semantic meaning of `price_timestamp` ("when this price was last refreshed in the cache, not the event time") in the schema documentation.

### M2. FTQ classification has no fallback when report-card-cache is unavailable

**Details:** When `report_card_cache` is stale or missing, flight-to-quality detection is silently disabled — `safeNet24h` and `riskyNet24h` remain 0, so FTQ never triggers. The API correctly sets `classificationSource: "unavailable"` and `classificationWarning`, but a comment at `worker/src/api/mint-burn-flows.ts:109` misleadingly says "falls back to hardcoded SAFE_HAVEN_IDS" — no such fallback is implemented.

**Recommendation:** Either implement the hardcoded fallback as the comment describes, or update the comment to match the actual behavior. Given that report-card-cache is refreshed hourly and the FTQ signal is supplementary (not a core data path), updating the comment is sufficient.

### M3. Flow chart gap-filling creates ambiguity between "zero activity" and "no data"

**Details:** `src/components/flow-chart.tsx:34-53` fills hourly gaps with zero values. If a coin is newly tracked and only has 48 hours of data but the user selects a 7-day view, the chart shows 5 days of flat zeros followed by 2 days of real data. Users cannot distinguish "no events recorded" from "genuinely zero mint/burn activity."

**Recommendation:** Add visual differentiation (e.g., dashed line or reduced opacity) for interpolated zero-fill periods, or clip the chart to the coin's actual coverage start.

### M4. Partial-coverage hourly aggregation edge case

**Details:** When a cron run partially covers a block range (budget exhausted or API error), `collectAffectedHours()` and `recalcAffectedHours()` at `persistence.ts:81-119` rebuild hourly buckets for the affected time windows. The rebuild queries ALL events in those hour windows from the database (not just newly inserted ones), so the aggregation is correct. However, if the same hour spans across two configs (Config A fully scanned, Config B partially scanned), the hourly bucket reflects Config A's complete data plus Config B's partial data. This is a minor accuracy concern during active catch-up periods.

**Recommendation:** This is acceptable for steady-state operation but worth noting for expansion planning. Document that during initial sync of new coins, hourly aggregates may be incomplete until the config catches up to chain head.

### M5. Documentation drift — 3 inconsistencies found

1. `docs/mint-burn-flows.md:163` states FTQ "falls back to hardcoded safe-haven list" — no fallback implemented (see M2).
2. `docs/mint-burn-flows.md:274-276` pressure shift thresholds say "improving: score > 10" — code uses strict `>` which is correct, but docs are ambiguous about the boundary value of exactly 10.
3. `docs/mint-burn-flows.md:76` says "83 contract configs across 82 stablecoin IDs" — should be verified against actual config count after any recent additions.

**Recommendation:** Fix all three in a single doc update pass.

### M6. Incomplete bridge-burn classification test coverage

**Details:** Tests at `worker/src/lib/__tests__/mint-burn-pipeline.test.ts` mock `classifyBridgeAwareBurnRows` entirely, so the actual CCIP router/pool address matching and `bridgeSignalTopics` topic matching are never exercised. If the address comparison logic has a case-sensitivity bug or the topic hash is wrong, no test would catch it.

**Recommendation:** Add an integration test that exercises the real classification function with mock Alchemy transaction context, verifying that known CCIP router addresses produce `bridge_burn` and unknown addresses produce `effective_burn`.

---

## Low Severity

### L1. Net flow sorting uses absolute value — intentional design choice, not a bug

**Details:** `src/components/flow-table-logic.ts:68-70` sorts net flow columns by `Math.abs()`, so -$50M and +$50M sort equally. This is tested and intentional (shows "most active" first regardless of direction), but some users may expect signed sorting to separate minting coins from burning coins.

**Recommendation:** No change needed. If user feedback indicates confusion, consider adding a secondary sort by sign within the same absolute value.

### L2. Zod schema allows non-finite numbers in some fields

**Details:** `trackedMcapUsd` at `shared/types/index.ts` is typed as `z.number()` without `.finite()`. If the backend ever serializes `Infinity` or `NaN`, the schema would pass it through, potentially breaking gauge calculations.

**Recommendation:** Add `.finite().nonnegative()` to `trackedMcapUsd` and similar numeric fields in the mint-burn Zod schemas.

### L3. 31 of 82 tracked coins show zero 24h mint/burn activity

**Details:** Live API probe shows 31 coins with `mintVolume24hUsd === 0 AND burnVolume24hUsd === 0`. This is expected for low-volume extended-lane coins (many are bond tokens, commodity-backed tokens, or low-cap stablecoins with minimal Ethereum activity). However, it's worth verifying that zero activity is genuine and not caused by a sync issue for any specific coin.

**Recommendation:** Spot-check 3-5 of the zero-activity coins against Etherscan to confirm they genuinely had no mint/burn events in the last 24h. Add a periodic operational check that flags configs where zero activity persists for >7 days despite the coin having on-chain supply changes.

### L4. Flow event feed shows "0 SYMBOL" with "Unpriced" badge for zero-amount events

**Details:** `src/components/flow-event-feed.tsx:200-210` — if both `amountUsd` and `amount` are zero/null, the display is confusing. This shouldn't happen in practice (dust filter removes sub-threshold events), but defensive handling would improve robustness.

**Recommendation:** Add a conditional display for `amount === 0` showing "Dust event" or similar.

### L5. Missing accessibility labels on gauge knobs

**Details:** Both `flow-brrr-overview.tsx:324-327` and `minting-pressure-gauge.tsx:123-126` render slider knobs without `aria-label` attributes. Screen readers cannot describe the gauge value.

**Recommendation:** Add `aria-label={`Gauge at ${score}`}` to both knob elements.

---

## Test Coverage Assessment

### Well-Covered Areas
- Pressure shift formula (12 test cases) including edge cases, clamping, floor denominator
- Gauge bands (all score ranges)
- Composite gauge (mcap weighting, null handling, all-null returns null)
- Flight-to-quality ($100M threshold, intensity clamping)
- Pipeline convergence (inserted vs ignored accounting, affected-hour recomputation)
- API response shapes (aggregate vs per-coin, Zod schema validation)
- Backfill chunking and sync state progression
- Shared signal interpretation (direction + pressure state + composite)
- Flow table sorting logic (absolute value, pressure null handling, tie-breaking)

### Key Gaps (action items)
1. **USDT Issue/Redeem parsing** — zero coverage (see H1)
2. **reUSD custom event parsing** — zero coverage (see H1)
3. **Bridge classification address matching** — mocked away (see M6)
4. **Price resolution fallback chain** — supply-history -> price_cache -> null path never tested end-to-end
5. **Sync state monotonic-max mode** — SQL CASE statement never verified
6. **Price heal** — 48-hour lookback, affected-hours collection, edge cases all untested
7. **Per-config request cap enforcement** — tested indirectly but no targeted test for the 60/25 cap split
8. **API freshness edge cases** — no test for zero cron runs, failed cron run, or extended-lane-only freshness

---

## Live Production Health Check

| Metric | Value | Assessment |
|--------|-------|------------|
| Sync freshness | `fresh` | Healthy |
| Sync warning | `null` | No issues |
| Tracked coins | 82 | Matches config count |
| Coverage status | All `full` | No lagging or partial configs |
| Gauge score | -20.73 (CAUTIOUS) | Plausible for current market |
| Null pressure scores | 38 of 82 | Expected (low-activity / <7 days history) |
| Zero 24h activity | 31 of 82 | Expected for long-tail extended coins |
| FTQ status | `false` | No flight-to-quality detected |
| Test suite | 2043/2043 passing | Clean |

---

## Recommendations for Coverage Expansion

Before expanding to additional EVM chains or adding more contract configs:

1. **Fix H1 first** — add tests for non-standard event parsing. This is the highest-risk gap for introducing new event types on new chains.
2. **Automate roundtrip reclassification (H2)** — cross-run roundtrips will be more common with more chains and tighter block ranges.
3. **Fix H3** — the N+1 reclassify query will be a bottleneck at scale.
4. **Add per-chain budget isolation** — currently all chains share the global 200-call budget. Multi-chain expansion needs per-chain budgets or at least per-chain caps to prevent one slow chain from starving others.
5. **Add chain-specific safety margins** — different EVM chains have different finality characteristics. The current 75-block Ethereum safety margin should be configurable per chain.
6. **Verify dust thresholds per chain** — the 10,000 default dust threshold assumes USD-pegged tokens. Gold and non-USD tokens already have overrides, but new chains may have different gas/dust economics.

---

## Files Audited

### Core Pipeline
- `worker/src/cron/sync-mint-burn.ts` — cron orchestration
- `worker/src/lib/mint-burn-pipeline/parse.ts` — log parsing + price resolution
- `worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts` — atomic roundtrip detection
- `worker/src/lib/mint-burn-pipeline/classification.ts` — bridge burn classification
- `worker/src/lib/mint-burn-pipeline/persistence.ts` — event writes + hourly recompute
- `worker/src/lib/mint-burn-pipeline/price-heal.ts` — null price healing
- `worker/src/lib/mint-burn-pipeline/sync-state.ts` — sync state management
- `worker/src/lib/mint-burn-pipeline/context.ts` — price context loaders
- `worker/src/lib/mint-burn-pipeline/types.ts` — shared types

### Configuration & Scoring
- `worker/src/lib/mint-burn-contracts.ts` — contract configs (82 coins, 83 configs)
- `worker/src/lib/mint-burn-scoring.ts` — pressure shift, gauge, FTQ
- `worker/src/lib/mint-burn-health-config.ts` — freshness thresholds
- `shared/lib/mint-burn-signals.ts` — shared signal interpretation

### API Endpoints
- `worker/src/api/mint-burn-flows.ts` — aggregate + per-coin handler
- `worker/src/api/mint-burn-flows-shared.ts` — cache, freshness, baseline, coverage
- `worker/src/api/mint-burn-events.ts` — paginated event feed
- `worker/src/api/backfill-mint-burn.ts` — admin backfill
- `worker/src/api/backfill-mint-burn-prices.ts` — admin price backfill
- `worker/src/api/reclassify-atomic-roundtrips.ts` — admin roundtrip reclassification

### Frontend
- `src/app/flows/page.tsx`, `layout.tsx` — /flows page
- `src/hooks/use-mint-burn-flows.ts` — TanStack Query hooks
- `src/components/flow-brrr-overview.tsx` — Bank Run Gauge
- `src/components/flow-chart.tsx` — Recharts flow chart
- `src/components/flow-table.tsx`, `flow-table-logic.ts` — sortable table
- `src/components/flow-event-feed.tsx` — event feed
- `src/components/minting-pressure-gauge.tsx` — minting pressure gauge
- `src/components/flow-summary-card.tsx` — detail page card
- `src/components/homepage-flow-overview.tsx` — homepage snapshot

### Tests
- `worker/src/lib/__tests__/mint-burn-scoring.test.ts`
- `worker/src/lib/__tests__/mint-burn-pipeline.test.ts`
- `worker/src/cron/__tests__/sync-mint-burn.test.ts`
- `worker/src/api/__tests__/backfill-mint-burn.test.ts`
- `worker/src/api/__tests__/mint-burn-flows.test.ts`
- `shared/lib/__tests__/mint-burn-signals.test.ts`
- `src/components/__tests__/flow-table-logic.test.ts`

### Documentation
- `docs/mint-burn-flows.md`
