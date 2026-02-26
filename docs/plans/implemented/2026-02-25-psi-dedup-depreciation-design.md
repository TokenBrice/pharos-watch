# PSI Deduplication, Depreciation & Per-Coin Contributors

**Date:** 2026-02-25
**Status:** Approved

## Problem

The Pharos Stability Index has three issues:

1. **Duplicate event double-counting.** When a stablecoin has multiple overlapping depeg events (common — CUSD, MIM, EURR, DEURO all had 2 concurrent events), each event contributes separately to both severity and breadth. A coin's market cap gets counted 2× or more in breadth, inflating the penalty by ~2 pts.

2. **Zombie coin pollution.** Chronically depegged coins (sUSD since Nov 2025, UUSD since Sep 2025, A7A5 since Dec 2025) permanently drag the score down even when all major stablecoins are perfectly stable. The PSI reads 86.5 STEADY when it should read ~92 BEDROCK.

3. **Black-box score.** The PSI shows aggregate severity/breadth/freezes/trend components but not which specific coins drive the penalty. Debugging requires paginating through thousands of depeg events and manually cross-referencing market caps.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Dedup location | JS in cron/backfill (not SQL, not compute) | Bug is at data-gathering layer; keeps pure compute simple |
| Dedup strategy | Worst current abs(bps) per coin, earliest `started_at` | Worst deviation = most meaningful signal; earliest start = true depeg duration |
| Depreciation curve | Linear decay after 30d grace, 120d to 25% floor | Simple, predictable, transparent; 25% floor keeps zombies visible |
| Per-coin contributors | Stored in `input_snapshot` JSON, served via existing `?detail=true` | Zero schema changes; naturally falls out of the dedup grouping |

## Formula Changes

### Depreciation factor (NEW)

```
depegAgeDays = (computationTime - earliestStartedAt) / 86400

if depegAgeDays ≤ 30:  factor = 1.0
else:                   factor = max(0.25, 1.0 - (depegAgeDays - 30) / 120)
```

Impact timeline:

| Day | Factor | Meaning |
|-----|--------|---------|
| 0-30 | 100% | Full impact — fresh depeg, market-relevant |
| 45 | 87% | Still significant |
| 60 | 75% | Fading |
| 90 | 50% | Half impact |
| 120 | 25% | Floor reached |
| 120+ | 25% | Permanent residual — coin is still depegged |

### Updated severity formula

```
severity_raw = Σ (abs(bps) / 100 × mcap_share × log₂(1 + mcap/$1B) × 60 × factor)
severity = min(60, severity_raw)
```

### Updated breadth formula

```
breadth_raw = Σ (sqrt(mcap / $1B) × 3 × factor)
breadth = min(15, breadth_raw)
```

### Deduplication

Before computing severity/breadth, group events by `stablecoin_id`:

1. For each coin with multiple active events, compute current bps for each event's `peg_reference`
2. Keep the event with the worst abs(bps) — most meaningful signal
3. Use the earliest `started_at` across all events — true depeg duration
4. Result: exactly one entry per depegged coin in the `depegs` array

## Architecture

### Pure compute function (`worker/src/lib/stability-index.ts`)

Add `depegAgeDays` to the input interface:

```typescript
export interface StabilityInput {
  depegs: { bps: number; mcapUsd: number; depegAgeDays?: number }[];
  totalMcapUsd: number;
  freezeCount24h: number;
  mcap7dChangePct: number;
}
```

Export `getDepreciationFactor()` as a named function. Apply factor to both severity and breadth contributions in the existing reduce loops. Backward-compatible: `depegAgeDays` is optional, defaults to 0 (factor = 1.0).

### Cron (`worker/src/cron/stability-index.ts`)

1. Add `started_at` to the depeg query
2. Group results by `stablecoin_id`
3. For each coin: compute bps per event, pick worst, use earliest `started_at`
4. Compute `depegAgeDays` relative to `now`
5. Build per-coin contributor objects for `input_snapshot`
6. Pass deduplicated depegs array (with `depegAgeDays`) to `computeStabilityIndex()`
7. Store contributors in `input_snapshot`

### Backfill (`worker/src/api/backfill-stability-index.ts`)

Same dedup logic. Group `activeDepegs` by `stablecoin_id`, pick worst bps (using `start_price` since we don't have live prices historically), use earliest `started_at`, compute age relative to backfill day.

### API (`worker/src/api/stability-index.ts`)

For the `current` object only: read `input_snapshot` from the DB row and include `contributors` in the response. History rows are unchanged (no `input_snapshot` in history — too much data).

```typescript
// current response gains:
{
  score: 91.2,
  band: "BEDROCK",
  components: { severity: 0.12, breadth: 5.41, freezes: 0, trend: 0.65 },
  contributors: [
    { id: "258", symbol: "A7A5", bps: -9871, mcapUsd: 507e6, severity: 1.12, breadth: 0.53, total: 1.65, ageDays: 61, factor: 0.74 },
    ...
  ],
  computedAt: 1771977600
}
```

### Frontend hook (`src/hooks/use-stability-index.ts`)

Add `contributors` to `StabilityIndexCurrent` interface:

```typescript
interface StabilityContributor {
  id: string;
  symbol: string;
  bps: number;
  mcapUsd: number;
  severity: number;
  breadth: number;
  total: number;
  ageDays: number;
  factor: number;
}

interface StabilityIndexCurrent {
  score: number;
  band: string;
  components: StabilityIndexComponents;
  contributors?: StabilityContributor[];  // only present on current
  computedAt: number;
}
```

### Frontend page (`src/app/stability-index/client.tsx`)

New `ContributorsTable` component placed between the Hero card and the Score History chart. Shows top contributors sorted by `total` descending. Columns: coin (linked to detail page), deviation (bps), mcap, depreciation factor, severity cost, breadth cost, total cost. Responsive: on mobile, collapse to coin + total + factor.

### Documentation (`docs/stability-index.md`)

Update the Components table (add depreciation column), add "Depreciation" section, add "Per-Coin Contributors" section, update calibration examples.

## What does NOT change

- Database schema — no migration needed
- `depeg_events` table — events are still created/ended as before
- History API response shape — only `current` gains `contributors`
- Homepage widget — it doesn't use `?detail=true`

## Backfill

After deploying the worker changes, run the existing `/api/backfill-stability-index` endpoint to recompute all historical scores with the corrected formula. Historical scores will shift (typically upward) since duplicate-counting and zombie pollution are removed retroactively.

## Expected Impact

With both fixes applied to today's data (22 events, 17 unique coins):

| Metric | Before | After (est.) |
|--------|--------|-------------|
| Active depeg entries | 22 (with dups) | 17 (unique coins) |
| Breadth | 13.13 | ~5-7 |
| Severity | 0.98 | ~0.3-0.5 |
| Score | 86.5 STEADY | ~92-94 BEDROCK |
