# Yield Feature Maturation — Design Document

**Date:** 2026-03-09

---

## Problem

The `/yield` feature is marked experimental despite having a complete data pipeline, scoring system, and frontend. Three concrete deficiencies prevent graduating it:

1. **Coverage gaps.** 40 of 156 tracked coins have yield data (25.6%). Some yield-bearing coins miss DeFiLlama pools due to stale UUIDs or symbol drift. The lending protocol allowlist (17 protocols) excludes established platforms that would surface lending opportunities for more coins.

2. **Silent data degradation.** When a DeFiLlama pool UUID disappears from their API, the coin silently loses yield data with no operational signal. No cross-source validation catches mismatches. No per-coin stale detection exists — only a blanket 60-min frontend banner.

3. **Limited UX.** Yield data lives only on the `/yield` page. Stablecoin detail pages show no yield information. The leaderboard has no filtering, no history charts, no score breakdown. Warning signals are computed and stored but never surfaced to users.

---

## Goal

Graduate `/yield` from experimental to mature by fixing coverage gaps, adding reliability guardrails, and building a richer frontend experience — including yield history charts, a yield section on stablecoin detail pages, leaderboard tabs/filters, PYS score transparency, and tiered warning signal display.

---

## Current Architecture

### Data Pipeline

```
DeFiLlama Yields API ──┐
                        ├──▶ sync-yield-data (30 min) ──▶ yield_data (snapshot) ──▶ cache "yield-rankings"
RPC eth_call (sUSDe) ───┘                              ──▶ yield_history (append)
                                                        ──▶ report_card_cache (safety scores)
FRED DGS3MO ──────────────▶ fetch-tbill-rate (daily) ──▶ cache "risk_free_rate"
```

### Three-Tier APY Resolution

| Tier | Source | Current Coverage |
|------|--------|-----------------|
| 1 | On-chain vault exchange rates | sUSDe only (1 coin) |
| 2 | DeFiLlama Yields API (3 layers: static map → variant map → symbol fallback) | ~35 coins |
| 3 | Price-derived from supply_history (30d appreciation) | NAV tokens + BUIDL |

### Auto-Discovery (Wave 2)

For non-gold/silver coins with safety score >= 50: searches `LENDING_PROTOCOL_ALLOWLIST` (17 protocols) in DeFiLlama pools. Appends `lending-opportunity` rows alongside native yield sources.

### Key Files

| File | Role | Lines |
|------|------|-------|
| `worker/src/cron/sync-yield-data.ts` | Main sync pipeline | ~972 |
| `worker/src/cron/yield-helpers.ts` | Pure functions (APY, PYS, stability, warnings, pool matching) | ~199 |
| `worker/src/cron/yield-config.ts` | Static config (pool maps, variant maps, allowlist) | ~366 |
| `worker/src/cron/fetch-tbill-rate.ts` | Daily T-bill rate fetch | ~114 |
| `worker/src/api/yield-history.ts` | GET /api/yield-history handler | ~49 |
| `worker/src/api/cache-handlers.ts` | GET /api/yield-rankings (cache-backed) | ~21 |
| `src/app/yield/page.tsx` | SSG page wrapper (experimental badge) | ~81 |
| `src/app/yield/client.tsx` | Interactive page (stats, scatter, leaderboard) | ~199 |
| `src/components/yield-leaderboard.tsx` | Sortable rankings table | ~330 |
| `src/components/yield-scatter-plot.tsx` | Risk-adjusted scatter chart | ~431 |
| `src/hooks/use-yield-rankings.ts` | TanStack Query hook | ~12 |
| `shared/types/index.ts` | YieldRanking, AltYieldSource, YieldRankingsResponse | — |
| `shared/lib/yield-rankings.ts` | dedupeYieldRankings | ~38 |
| `src/app/stablecoin/[id]/client.tsx` | Detail page (no yield section yet) | ~150 |

---

## Schema/Type Changes

### D1 Migration: `yield_history` table

```sql
-- New column
ALTER TABLE yield_history ADD COLUMN warning_signals TEXT;
```

No new tables. No column removals. No index changes.

### TypeScript Type Changes

**`shared/types/index.ts` — `YieldRankingsResponse`:**
```diff
 interface YieldRankingsResponse {
   rankings: YieldRanking[];
   riskFreeRate: number;
   scalingFactor: number;
+  medianApy: number;
   updatedAt: number;
 }
```

**`shared/types/index.ts` — `YieldHistoryPoint` (create if absent):**
```diff
+interface YieldHistoryPoint {
+  date: string;
+  apy: number;
+  apyBase: number | null;
+  apyReward: number | null;
+  exchangeRate: number | null;
+  sourceTvlUsd: number | null;
+  warningSignals: string[];
+}
```

---

## API Changes

### `GET /api/yield-rankings`

Response shape gains one field:

```diff
 {
   rankings: [...],
   riskFreeRate: 4.25,
   scalingFactor: 5,
+  medianApy: 5.3,
   updatedAt: 1772000000
 }
```

Backward compatible — additive field only. No breaking changes.

### `GET /api/yield-history`

Response data points gain one field:

```diff
 {
   date: "2026-03-09",
   apy: 8.2,
   apyBase: 6.1,
   apyReward: 2.1,
   exchangeRate: 1.05,
   sourceTvlUsd: 500000000,
+  warningSignals: ["yield-spike"]
 }
```

Backward compatible — additive field only.

---

## Migration Strategy

No breaking changes. All changes are additive:

1. **Schema migration** runs first (adds nullable column — no data migration needed)
2. **Backend code** deploys next (starts writing new fields, computing median). Old cached responses continue serving until next sync cycle writes the new format.
3. **Frontend code** deploys last (reads new fields with fallback defaults — `medianApy ?? 0`, `warningSignals ?? []`)

No maintenance window needed. No `[skip ci]` required. Each phase is independently deployable.

---

## Frontend Changes

### New Components

| Component | File | Used By |
|-----------|------|---------|
| `YieldHistoryChart` | `src/components/yield-history-chart.tsx` | Detail page yield section, leaderboard expandable row |
| `YieldDetailSection` | `src/components/yield-detail-section.tsx` | Stablecoin detail page |

### New Hooks

| Hook | File | Endpoint |
|------|------|----------|
| `useYieldHistory` | `src/hooks/use-yield-history.ts` | `GET /api/yield-history` |

### Modified Components

| Component | Changes |
|-----------|---------|
| `YieldLeaderboard` | Add tabs (Native/Lending), warning signals column, yield type + warning filters, PYS breakdown tooltip, expandable rows with history chart |
| Stablecoin detail `client.tsx` | Add "Yield" to DETAIL_SECTIONS, render YieldDetailSection |
| `src/app/yield/page.tsx` | Remove experimental status badge |
| `src/app/yield/client.tsx` | Pass `medianApy` + `riskFreeRate` to leaderboard, remove new-feature banner |

### No URL Changes

No new routes. No localStorage migration. No SEO impact beyond removing "experimental" from the yield page metadata.

---

## Coverage Expansion Details

### 1a. Audit & Fix DeFiLlama Pool Matching

Audit all `flags.yieldBearing: true` coins against the live DeFiLlama `/pools` endpoint. Fix stale UUIDs and add missing entries in `YIELD_POOL_MAP` / `YIELD_VARIANT_MAP`.

Known gaps: USDB (Blast native yield), BUIDL (BlackRock), YLDS (Figure Markets) — no DL pools exist. These remain on Tier 3 price-derived fallback.

### 1b. Expand Lending Protocol Allowlist

Quality gates for new protocols:
- Protocol >$10M total TVL on DeFiLlama
- Listed >3 months
- Has `exposure: "single"` pools

Candidates: Benqi, Radiant, Silo, Exactly, Moonwell, Seamless, Ionic, Lodestar, Granary, Notional. New additions enter Tier 3.

---

## Data Reliability Details

### 2a. Cross-Source Validation

Log operational warning when native and lending APY for the same coin deviate >50%. Logging only — no user-facing effect.

### 2b. Per-Coin Stale Detection

Add `data-stale` to a coin's `warning_signals` at cache-build time when `updated_at` is >90 min old (3 sync cycles). Read-time decoration — doesn't write back to `yield_data`.

### 2c. Graceful Per-Coin Fallback

When a static-mapped pool UUID is missing from the DL response, log a warning and fall through to Layer 2/3 instead of recording null. Track repeated fallbacks in cron status output.

---

## Frontend UX Details

### Yield Section on Detail Pages

Conditional section on `/stablecoin/[id]` for coins with yield data. Layout: header + yield type badge, warning callout (2+ signals), stat cards (Current APY, 30d APY, PYS with breakdown tooltip, Stability, Excess Yield), source info, alt sources, history chart. Empty state for yield-bearing coins with missing data. Returns null for non-yield coins.

### Yield History Chart

Shared `YieldHistoryChart` component. APY line + base/reward toggle + T-bill reference line + peer median reference line + warning signal markers. Time presets: 7d / 30d / 90d / 1y (default 90d). Compact mode for leaderboard rows.

### Leaderboard Enhancements

- **Tabs:** "Native Yield" vs "Lending Opportunities" (replaces data source filter). Count badges per tab.
- **Warning signals column:** Subtle amber icon for 1 signal (tooltip), filled icon + row border for 2+.
- **Filters:** Yield type pill toggles + "Hide warned" toggle within each tab.
- **PYS breakdown tooltip:** Shows yield efficiency, risk penalty (grade + multiplier), consistency.
- **Expandable rows:** Click to show inline `YieldHistoryChart` (compact mode).

### Warning Signal Labels

| Signal | User-facing label |
|--------|------------------|
| `yield-spike` | APY spiked 2x above 30d average |
| `yield-divergence` | APY is 3x the market median |
| `negative-trend` | APY declined 30%+ from average |
| `reward-heavy` | 80%+ of yield from incentive rewards |
| `tvl-outflow` | TVL dropped 20%+ in the past week |
| `data-stale` | Yield data hasn't refreshed in 90+ min |

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| DeFiLlama pool UUID changes break static map entries | Medium | Graceful per-coin fallback (2c) catches this at runtime. Cross-source validation (2a) flags anomalies. Repeated fallbacks logged for map maintenance. |
| New lending protocols in allowlist surface low-quality pools | Low | Quality gates enforced: >$10M TVL, >3 months listed, single exposure only. New protocols enter Tier 3. |
| `medianApy` is 0 when no coins have TVL data | Low | Frontend treats `medianApy ?? 0` and hides the reference line when value is 0. |
| Warning signal labels need internationalization | Low | Out of scope — labels are English-only, matching all other Pharos text. |
| Expandable leaderboard rows cause layout shifts | Low | Use CSS grid row animation with fixed height expansion. Compact chart mode at 200px. |
| Detail page yield section adds weight to already-heavy page | Medium | Component lazy-loaded (dynamic import). Data reused from existing `useYieldRankings` call — only the history chart triggers a new API call. |
| Schema migration on production D1 | Low | Single `ALTER TABLE ADD COLUMN` — nullable, no data migration, instant. D1 Time Travel available for rollback. |
| Cron writes warning_signals to yield_history but history endpoint doesn't return them yet | Low | Deploy backend (Phase 1A) fully before frontend (Phase 2+). During the gap, the column populates silently with no consumer. |
