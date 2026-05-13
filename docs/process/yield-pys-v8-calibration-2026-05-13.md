# Yield PYS v8 Golden Fixture Calibration Artifact

Generated: 2026-05-13T19:36:30.000Z

Scope: golden-fixture calibration for the methodology v8 PYS source-risk layer. This artifact proves source-risk driver behavior on controlled rows, including zero and negative APY rows that may not appear in a production snapshot. It is not a production-universe calibration and does not change runtime behavior.

## Candidate Formula For Analysis

```text
sourceRiskPenalty = clamp(row.sourceRisk?.sourceRiskPenalty ?? legacy row.sourceRiskPenalty ?? derivedNeutralPenalty, 1, 2.5)
sourceAdjustedUtility = current effectiveYield / sourceRiskPenalty
yieldEfficiency = sourceAdjustedUtility / adjustedRiskPenalty
pysV8 = clamp(round(yieldEfficiency * sustainabilityMultiplier * scalingFactor), 0, 100)
```

Unknown source-risk inputs are neutral. The before column recomputes the v7 baseline without source-risk penalties; the after column applies the v8 candidate penalty.

## Distribution

Rows analyzed: 10

| metric | PYS v8 candidate |
| --- | ---: |
| p10 | 0 |
| p50 | 47 |
| p90 | 55 |
| max | 65 |

## Capped Scores

| side | count capped at 100 |
| --- | ---: |
| before | 1 |
| after | 0 |

## Null-Rate Coverage

| field | present | null/missing | null rate |
| --- | ---: | ---: | ---: |
| sourceRiskScore | 10 | 0 | 0.0% |
| sourceRiskPenalty | 10 | 0 | 0.0% |
| rewardShare | 10 | 0 | 0.0% |
| sourceDepthRatio | 10 | 0 | 0.0% |
| sourceAgeSeconds | 10 | 0 | 0.0% |
| sourceSwitchCount30d | 10 | 0 | 0.0% |
| observationCount30d | 10 | 0 | 0.0% |
| venueRiskTier | 10 | 0 | 0.0% |

## Non-USD Cohort Checks

| cohort | rows | p50 PYS | p90 PYS | max PYS | capped at 100 |
| --- | ---: | ---: | ---: | ---: | ---: |
| EUR | 1 | 33 | 33 | 33 | 0 |

## Top 20 Before

| rank | id | symbol | APY 30d | PYS | source | driver |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 1 | reward-heavy | RWD | 14 | 100 | Calibration source | reward-heavy |
| 2 | low-depth | DEP | 11 | 86 | Calibration source | low-depth |
| 3 | bootstrap | BOOT | 10 | 78 | Calibration source | bootstrap |
| 4 | stale-source | STL | 9 | 69 | Calibration source | stale |
| 5 | source-switch | SWI | 8 | 61 | Calibration source | source-switch |
| 6 | clean-usd | CLN | 7 | 53 | Calibration source | apy-or-baseline |
| 7 | eur-coin | EURC | 4.50 | 33 | Calibration source | apy-or-baseline |
| 8 | missing-safety | MISS | 6 | 7 | Calibration source | missing-safety |
| 9 | zero-yield | ZERO | 0 | 0 | Calibration source | negative-zero |
| 10 | negative-yield | NEG | -1 | 0 | Calibration source | negative-zero |

## Top 20 After

| rank | id | symbol | APY 30d | PYS | source | driver |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 1 | bootstrap | BOOT | 10 | 65 | Calibration source | bootstrap |
| 2 | low-depth | DEP | 11 | 55 | Calibration source | low-depth |
| 3 | reward-heavy | RWD | 14 | 53 | Calibration source | reward-heavy |
| 4 | clean-usd | CLN | 7 | 53 | Calibration source | apy-or-baseline |
| 5 | stale-source | STL | 9 | 48 | Calibration source | stale |
| 6 | source-switch | SWI | 8 | 47 | Calibration source | source-switch |
| 7 | eur-coin | EURC | 4.50 | 33 | Calibration source | apy-or-baseline |
| 8 | missing-safety | MISS | 6 | 7 | Calibration source | missing-safety |
| 9 | zero-yield | ZERO | 0 | 0 | Calibration source | negative-zero |
| 10 | negative-yield | NEG | -1 | 0 | Calibration source | negative-zero |

## Largest Rank Movers

| before | after | delta | id | symbol | before PYS | after PYS | driver | source penalty |
| ---: | ---: | ---: | --- | --- | ---: | ---: | --- | ---: |
| 1 | 3 | -2 | reward-heavy | RWD | 100 | 53 | reward-heavy | 2.10 |
| 3 | 1 | 2 | bootstrap | BOOT | 78 | 65 | bootstrap | 1.20 |
| 6 | 4 | 2 | clean-usd | CLN | 53 | 53 | apy-or-baseline | 1 |
| 4 | 5 | -1 | stale-source | STL | 69 | 48 | stale | 1.45 |
| 5 | 6 | -1 | source-switch | SWI | 61 | 47 | source-switch | 1.30 |
| 2 | 2 | 0 | low-depth | DEP | 86 | 55 | low-depth | 1.55 |
| 8 | 8 | 0 | missing-safety | MISS | 7 | 7 | missing-safety | 1 |
| 7 | 7 | 0 | eur-coin | EURC | 33 | 33 | apy-or-baseline | 1 |
| 9 | 9 | 0 | zero-yield | ZERO | 0 | 0 | negative-zero | 1 |
| 10 | 10 | 0 | negative-yield | NEG | 0 | 0 | negative-zero | 1 |

## Golden Fixture List

| fixture | required assertion |
| --- | --- |
| reward-heavy | high rewardShare produces a driver label and cannot improve from source-risk treatment alone |
| stale | stale sourceAgeSeconds produces a freshness driver when it is the largest penalty |
| low-depth | low sourceDepthRatio produces a depth driver and avoids top-rank promotion from APY alone |
| source-switch | sourceSwitchCount30d or provenance.sourceSwitch labels churn-driven movement |
| bootstrap | low observationCount30d labels bootstrap uncertainty without breaking seed rows |
| negative-zero | zero or negative APY scores 0 and preserves deterministic rank behavior |
| missing-safety | null safetyScore keeps existing default-safety behavior and records coverage |

## Implementation Notes

- This report uses controlled fixture rows generated under `/agents/` so every v8 source-risk driver remains reviewable independent of live-market coverage.
- Shared tests reuse the same driver cases for scoring and evaluation coverage.
- Keep scratch calibration inputs under `/agents/`; committed rollout evidence belongs under `docs/process/`.
- Pair this fixture report with `docs/process/yield-pys-v8-production-sample-calibration-2026-05-13.md` for live null-rate coverage, rank churn, capped rows, and non-USD cohorts.
