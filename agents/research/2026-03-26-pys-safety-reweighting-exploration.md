# PYS Safety Reweighting Exploration

Date: 2026-03-26

Implementation follow-up:

- Final implementation shipped this safety-curve change as yield methodology `v5.5`
- The implementation also retuned `PYS_SCALING_FACTOR` from `5` to `8` so score distribution stayed readable after the steeper safety curve

## Question

Does the current Pharos Yield Score (PYS) overweight raw yield relative to Safety Score, causing too many C-grade names to dominate the leaderboard?

## Current Formula

Source of truth:

- `shared/lib/yield-scoring.ts`
- mirrored at read time in `worker/src/api/cache-handlers.ts`

Current formula:

```text
riskPenalty        = max(0.5, (101 - safetyScore) / 20)
yieldEfficiency    = apy30d / riskPenalty
sustainabilityMult = max(0.3, 1.0 - apyVarianceScore)
PYS                = min(100, round(yieldEfficiency * sustainabilityMult * scalingFactor))
```

Current constants:

- `PYS_RISK_PENALTY_FLOOR = 0.5`
- `PYS_SUSTAINABILITY_FLOOR = 0.3`
- `PYS_SCALING_FACTOR = 5`
- default unrated safety input = `40`

## Why The Current Curve Feels Too Yield-Led

Ignoring stability for a moment, PYS is proportional to:

```text
apy30d / ((101 - safetyScore) / 20)
```

That means the safety term is only a linear divisor.

Example: compare a safe A- coin at safety `82` with a C- coin at safety `52`.

- A- risk penalty: `0.95`
- C- risk penalty: `2.45`
- Required yield ratio for the C- coin to tie the A- coin: `2.45 / 0.95 = 2.58x`

So if an A- coin yields `4.55%`, a C- coin only needs about `11.73%` to tie it under the current formula.

That is the core issue: a mid/low-grade asset does not need an extreme yield advantage to outrank a much safer name.

## Live Snapshot Used For Calibration

Source:

- `https://api.pharos.watch/api/yield-rankings`

Snapshot observed:

- `2026-03-26T10:20:37Z`

Current top rows from the live API:

| Rank | Coin | Grade | Safety | APY (30d) | PYS |
| --- | --- | --- | ---: | ---: | ---: |
| 1 | USP | C- | 52 | 27.36% | 56 |
| 2 | meUSD | C- | 54 | 23.17% | 49 |
| 3 | apxUSD | C+ | 64 | 13.92% | 38 |
| 4 | USDU | C | 56 | 12.75% | 27 |
| 5 | MSUSD | C+ | 60 | 12.31% | 26 |
| 6 | DOLA | B- | 67 | 8.82% | 26 |
| 7 | USDC | A- | 82 | 4.55% | 23 |
| 8 | DAI | A- | 81 | 4.44% | 22 |

Composition:

- current top 10: `7` C-range, `1` B-range, `2` A-range
- current top 20: `12` C-range, `4` B-range, `4` A-range

This matches the user concern: the board is still mostly sorting by who can print the fattest yield rather than who can deliver the best safe yield.

## Candidate Changes Explored

### Option 1: Steepen The Existing Risk Penalty Curve

Keep the current formula shape, but raise the penalty to a power:

```text
riskPenalty        = max(0.5, (101 - safetyScore) / 20)
yieldEfficiency    = apy30d / (riskPenalty ^ alpha)
sustainabilityMult = max(0.3, 1.0 - apyVarianceScore)
PYS                = min(100, round(yieldEfficiency * sustainabilityMult * scalingFactor'))
```

Where `alpha > 1`.

Tested values:

- `alpha = 1.35`
- `alpha = 1.50`
- `alpha = 1.75`

How much APY a lower-grade coin needs to beat a `4.55%` A- coin (`safety=82`):

| Safety | Grade | Current (`alpha=1.0`) | `alpha=1.5` | `alpha=1.75` |
| ---: | --- | ---: | ---: | ---: |
| 73 | B | 6.71% | 8.14% | 8.97% |
| 67 | B- | 8.14% | 10.89% | 12.60% |
| 64 | C+ | 8.86% | 12.36% | 14.61% |
| 56 | C | 10.78% | 16.58% | 20.57% |
| 52 | C- | 11.73% | 18.84% | 23.88% |
| 40 | D | 14.61% | 26.17% | 35.04% |

Observed leaderboard effect:

- `alpha=1.35`: still yield-led, but safer A/B names start entering the top 10 earlier
- `alpha=1.50`: materially better balance; C names still win when yield is genuinely huge
- `alpha=1.75`: strongest safe-yield orientation without becoming absurdly binary

Top-10 grade mix under `alpha=1.75`:

- `4` A-range
- `2` B-range
- `4` C-range

This is the cleanest fix because it is:

- continuous, not bucketed
- easy to explain
- easy to test
- backward-compatible with the existing mental model

### Option 2: Add Grade-Band Multipliers

Example shape:

```text
basePys = current formula
gradeMultiplier =
  A-range: 1.35
  B-range: 1.10
  C-range: 0.75
  D-range: 0.45
  F/NR:    0.20
PYS = basePys * gradeMultiplier
```

Pros:

- very direct product behavior
- easy to tune by feel
- immediately surfaces A/B names

Cons:

- hard discontinuities at grade boundaries
- gameable around thresholds (`79 -> 80` suddenly matters too much)
- less elegant than a smooth curve

This works, but it is cruder than Option 1.

### Option 3: Add Explicit Warning Penalties

Example shape:

```text
warningPenalty =
  0.80 if yield-spike
  0.85 if reward-heavy
  0.90 if tvl-outflow

PYS = basePys * product(all warning penalties)
```

Pros:

- directly attacks temporary or incentive-juiced yield
- aligns with the intuition that unstable yield should not rank as highly

Cons:

- does not solve the current problem on its own
- many current top rows have no active warning flags
- warning detection quality would need to be trusted more if score-affecting

This is a good secondary layer, not the primary fix.

### Option 4: Score Excess Yield Over T-Bills Instead Of Raw APY

Example shape:

```text
effectiveYield = max(0, apy30d - riskFreeRate)
PYS = effectiveYield / (riskPenalty ^ alpha) * sustainability
```

This performed poorly for the user goal.

Reason:

- it crushes safe `3.5% - 5%` names too aggressively
- it makes the board more of a spread-over-cash board than a safe-yield discovery board

Conclusion:

- useful as a supporting metric
- not a good primary replacement for PYS

## Recommendation

Recommended first change:

### Raise the safety penalty to a power and start with `alpha = 1.75`

Proposed formula:

```text
riskPenalty        = max(0.5, (101 - safetyScore) / 20)
yieldEfficiency    = apy30d / (riskPenalty ^ 1.75)
sustainabilityMult = max(0.3, 1.0 - apyVarianceScore)
PYS                = min(100, round(yieldEfficiency * sustainabilityMult * scalingFactor'))
```

Rationale:

- preserves the current architecture and intuition
- makes safety matter much more without forbidding risky names from winning
- still lets truly massive yields rank at the top
- forces C/D assets to post exceptional yield before they outrank quality A/B names

Behavioral interpretation:

- A/B names no longer need to be obviously underpriced in yield to appear competitive
- C names can still lead, but only if their yield is very high
- D names need extreme yield, which fits the intended discovery posture better

## Implementation Notes

If this is implemented, update:

- `shared/lib/yield-scoring.ts`
- `worker/src/api/cache-handlers.ts`
- `shared/lib/__tests__/yield-scoring.test.ts`
- `worker/src/cron/__tests__/yield-helpers.test.ts`
- `docs/yield-intelligence.md`
- `docs/yield-intelligence-timeline.md`
- `src/app/methodology/sections/monitoring-sections.tsx`
- `shared/lib/yield-methodology-version.ts`

Additional cleanup worth doing in the same change:

- stop duplicating the PYS formula in `worker/src/api/cache-handlers.ts`; reuse the shared scoring helper so live safety hydration cannot drift from cron-time scoring

## Suggested Rollout

1. Ship the smooth safety-curve change first (`alpha = 1.75`).
2. Re-check the live top 20 after a few hourly cycles.
3. If transient farming yields still feel too high, add score-affecting warning penalties as a second methodology revision.
