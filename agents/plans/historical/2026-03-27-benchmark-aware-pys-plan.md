# Benchmark-Aware PYS Plan

## Goal

Adjust Pharos Yield Score so rows get explicit credit for clearing their local benchmark without replacing the core nominal-yield signal with a pure excess-yield ranker.

## Implementation

1. Add a shared benchmark-aware effective-yield term in `shared/lib/yield-scoring.ts`.
2. Pass row benchmark context into worker-time scoring and read-time rankings hydration.
3. Update leaderboard/detail PYS breakdowns so the benchmark adjustment is visible to users.
4. Update methodology docs, changelog metadata, and the public methodology page.
5. Validate with targeted tests plus the local merge gate, then push.

## Chosen Formula

```text
benchmarkSpread = apy30d - benchmarkRate
effectiveYield  = max(0, apy30d + 0.25 * benchmarkSpread)
PYS             = min(100, round((effectiveYield / riskPenalty^1.75) * sustainability * scalingFactor))
```

## Rationale

- Keeps raw APY as the anchor, so PYS still reflects nominal income opportunity.
- Rewards non-USD and other tighter-benchmark rows when they clear a harder local hurdle.
- Penalizes materially below-benchmark rows without making benchmark spread the only ranking input.
