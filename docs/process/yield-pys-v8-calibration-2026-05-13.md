# Yield PYS v8 Golden Fixture Calibration Artifact

Generated: 2026-05-13T17:55:00.000Z

Scope: golden-fixture calibration for the methodology v8 PYS source-risk layer. This artifact proves source-risk driver behavior on controlled rows; it is not a production-universe calibration and does not change runtime behavior.

## Candidate Formula For Analysis

```text
sourceRiskPenalty = clamp(row.sourceRisk?.sourceRiskPenalty ?? legacy row.sourceRiskPenalty ?? derivedNeutralPenalty, 1, 2.5)
sourceAdjustedUtility = current effectiveYield / sourceRiskPenalty
yieldEfficiency = sourceAdjustedUtility / adjustedRiskPenalty
pysV8 = clamp(round(yieldEfficiency * sustainabilityMultiplier * scalingFactor), 0, 100)
```

Unknown source-risk inputs are neutral. The before column recomputes the v7 baseline without source-risk penalties; the after column applies the v8 candidate penalty.

## Distribution

Rows analyzed: 9

| metric | PYS v8 candidate |
| --- | ---: |
| p10 | 0 |
| p50 | 47 |
| p90 | 63 |
| max | 63 |

## Capped Scores

| side | count capped at 100 |
| --- | ---: |
| before | 1 |
| after | 0 |

## Null-Rate Coverage

| field | present | null/missing | null rate |
| --- | ---: | ---: | ---: |
| sourceRiskPenalty | 9 | 0 | 0.0% |
| rewardShare | 8 | 1 | 11.1% |
| sourceDepthRatio | 9 | 0 | 0.0% |
| sourceAgeSeconds | 9 | 0 | 0.0% |
| sourceSwitchCount30d | 9 | 0 | 0.0% |
| observationCount30d | 9 | 0 | 0.0% |
| venueRiskTier | 9 | 0 | 0.0% |

## Non-USD Cohort Checks

| cohort | rows | p50 PYS | p90 PYS | max PYS | capped at 100 |
| --- | ---: | ---: | ---: | ---: | ---: |
| EUR | 1 | 29 | 29 | 29 | 0 |

## Top 20 Before

| rank | id | symbol | APY 30d | PYS | source | driver |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 1 | reward-heavy | RWD | 14 | 100 | Calibration source | reward-heavy |
| 2 | low-depth | DEP | 11 | 84 | Calibration source | low-depth |
| 3 | bootstrap | BOOT | 10 | 76 | Calibration source | bootstrap |
| 4 | stale-source | STL | 9 | 67 | Calibration source | stale |
| 5 | source-switch | SWI | 8 | 59 | Calibration source | source-switch |
| 6 | clean-usd | CLN | 7 | 51 | Calibration source | apy-or-baseline |
| 7 | missing-safety | MISS | 6 | 43 | Calibration source | apy-or-baseline |
| 8 | eur-coin | EURC | 4.50 | 33 | Calibration source | apy-or-baseline |
| 9 | zero-yield | ZERO | 0 | 0 | Calibration source | negative-zero |

## Top 20 After

| rank | id | symbol | APY 30d | PYS | source | driver |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 1 | bootstrap | BOOT | 10 | 63 | Calibration source | bootstrap |
| 2 | low-depth | DEP | 11 | 54 | Calibration source | low-depth |
| 3 | reward-heavy | RWD | 14 | 52 | Calibration source | reward-heavy |
| 4 | clean-usd | CLN | 7 | 51 | Calibration source | apy-or-baseline |
| 5 | stale-source | STL | 9 | 47 | Calibration source | stale |
| 6 | source-switch | SWI | 8 | 46 | Calibration source | source-switch |
| 7 | missing-safety | MISS | 6 | 43 | Calibration source | apy-or-baseline |
| 8 | eur-coin | EURC | 4.50 | 29 | Calibration source | apy-or-baseline |
| 9 | zero-yield | ZERO | 0 | 0 | Calibration source | negative-zero |

## Largest Rank Movers

| before | after | delta | id | symbol | before PYS | after PYS | driver | source penalty |
| ---: | ---: | ---: | --- | --- | ---: | ---: | --- | ---: |
| 6 | 4 | 2 | clean-usd | CLN | 51 | 51 | apy-or-baseline | 1 |
| 1 | 3 | -2 | reward-heavy | RWD | 100 | 52 | reward-heavy | 2.10 |
| 3 | 1 | 2 | bootstrap | BOOT | 76 | 63 | bootstrap | 1.20 |
| 4 | 5 | -1 | stale-source | STL | 67 | 47 | stale | 1.45 |
| 5 | 6 | -1 | source-switch | SWI | 59 | 46 | source-switch | 1.30 |
| 2 | 2 | 0 | low-depth | DEP | 84 | 54 | low-depth | 1.55 |
| 8 | 8 | 0 | eur-coin | EURC | 33 | 29 | apy-or-baseline | 1.15 |
| 9 | 9 | 0 | zero-yield | ZERO | 0 | 0 | negative-zero | 1 |
| 7 | 7 | 0 | missing-safety | MISS | 43 | 43 | apy-or-baseline | 1 |

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

## Production Calibration Status

- Production-snapshot baseline evidence is recorded separately in `docs/process/yield-pys-v8-production-sample-calibration-2026-05-13.md`.
- Regenerate a production report after the v8 publisher has emitted live `sourceRisk.*` fields to measure final rank churn with populated source-risk coverage.
- Keep scratch calibration reports under `/agents/`; committed rollout evidence belongs under `docs/process/`.
- Keep this fixture report with the v8 rollout notes so source-risk driver behavior remains reviewable.
