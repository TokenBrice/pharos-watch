# Peg Score Rebalance Design

**Date:** 2026-02-20
**Problem:** Peg score over-indexes on centralized stables — coins with tight arbitrage and zero events score 100, while decentralized stables with minor threshold-crossing events get penalized. The severity curve (`sqrt`) is too forgiving for large deviations.

## Changes

### 1. Steeper severity curve (linear)

**Current:** `sqrt(peakBps / 100)` per event
**New:** `peakBps / 100` per event (linear)

Full severity penalty per event:
```
(peakBps / 100) * (durationDays / 30) * recencyWeight
```

A 500bps event now penalizes 5x more than 100bps (was 2.2x). Catastrophic events like DOLA's 6707bps or sUSD's 4143bps are no longer softened.

### 2. Deviation spread penalty (volatility proxy)

Compute standard deviation of `|peakDeviationBps|` across all events. Erratic, unpredictable depeg magnitudes indicate instability beyond what frequency or severity alone captures.

```
stdDev = standardDeviation(events.map(e => |e.peakDeviationBps|))
spreadPenalty = min(15, stdDev / 1000 * 15)
```

- 0 events or all-identical deviations: 0 penalty
- stdDev of 500: ~7.5 penalty
- stdDev >= 1000: capped at 15 penalty

Only applies when >= 2 events exist (stddev undefined for 0-1 events).

### 3. New composite formula

```
raw = 0.5 * pegPct + 0.5 * severityScore - activeDepegPenalty - spreadPenalty
```

### 4. Interface change

`PegScoreResult` gains `spreadPenalty: number` field for transparency in the API response and leaderboard.

## Files to modify

1. `src/lib/peg-score.ts` — Core algorithm: linear severity, spread penalty, new composite
2. `src/lib/types.ts` — Add `spreadPenalty` to PegScoreResult if defined there
3. `worker/src/api/peg-summary.ts` — Pass through new field in API response
4. `src/components/peg-leaderboard.tsx` — Display spread penalty if shown
5. `src/app/about/page.tsx` — Update methodology description

## Data requirements

No new data sources. Computed entirely from existing depeg events.
