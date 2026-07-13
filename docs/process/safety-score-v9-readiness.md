# Safety Score v9 Readiness

This document describes the pre-v9 compiler, calibration corpus, and current activation gate. It does not define an active Safety Score methodology. Production remains on Safety Score v8.16 and P4 same-notional scoring remains shadow-only.

## Durable Artifacts

- `shared/data/safety-score-v9/historical-fixtures-v1.json`: 26 point-in-time fixtures (12 adverse, 14 resilient). Every source publication is at or before the fixture `asOf`; adverse outcome windows start at or after `asOf`.
- `shared/data/safety-score-v9/calibration-cohort-v1.json`: 24 active assets spanning fiat anchors, CDPs, wrappers, private credit, synthetic designs, RWA funds, bridge scope, dependencies, and missing-evidence cases.
- `shared/data/safety-score-v9/matched-invariants-v1.ts`: expectation-free transformations for redemption, optional routes, reserve and bridge materiality, dependency availability, oracle common mode, evidence criticality, and parent propagation.
- `shared/data/safety-score-v9/exit-route-calibration-v1.json`: all-active P4 producer coverage and legacy-versus-active score movements.
- `shared/data/safety-score-v9/readiness-baseline-v1.json`: final all-active v9 compiler, historical calibration, route coverage, and go/no-go output.

## Compiler Boundary

`shared/lib/safety-score-v9-compiler.ts` converts current `StablecoinMeta` and a fixed report-card replay into `CompiledV9AssetInput` records. The compiler may carry structured pillar, peg, parent, evidence, implementation-age, failure-domain, and unresolved facts. It must not accept or store:

- desired v9 grades or scores;
- scenario-supplied cap values;
- asset-specific exceptions;
- post-outcome evidence in historical fixtures.

Numeric weights, evidence ceilings, track-record ceilings, bounded-compensability rules, and structural signal caps live only in `shared/lib/safety-score-v9-research.ts`. They are provisional research constants, not production methodology.

Missing critical facts produce reason-coded `NR`. Parent evaluation is deterministic and parent-first; missing parents and cycles remain explicit. Fuzzy implementation dates use the conservative range end, and variants inherit the newest critical implementation layer.

## Current Result

Baseline time: `2026-07-13T01:30:00.000Z`, using a fixed v8.16 legacy replay and the complete P4a generation `dex-liquidity-1783905029`.

| Gate                                            |        Result |
| ----------------------------------------------- | ------------: |
| Active registry/report cards compiled           |     360 / 360 |
| Compiler exceptions / silent omissions          |         0 / 0 |
| Candidate rateable / NR                         |     219 / 141 |
| Critical unresolved facts                       |           179 |
| Historical adverse / resilient fixtures         |       12 / 14 |
| Historical look-ahead validation                |        passed |
| P4 DEX populated / unsupported / unknown assets | 7 / 173 / 180 |
| Positive score-eligible DEX observations        |            18 |
| P4 activation decision                          |          hold |
| V9 readiness decision                           |         no-go |

The largest current evidence queues are 340 unreviewed reserve envelopes, 275 same-notional route-coverage gaps, 85 missing exit inputs, 55 missing peg inputs, 36 missing implementation dates, and 3 reviewed unresolved archetypes. These are work queues, not implied defaults.

The historical research pass has no adverse false negatives under the provisional thresholds, but 18 fixtures are `NR` and 9 resilient fixtures are conservative false positives because critical point-in-time evidence was unresolved. That is calibration debt; it is not a reason to weaken the no-look-ahead or critical-evidence rules.

## Reproduction

```bash
npm run report-cards:replay -- \
  --input agents/safety-score-v9/artifacts/fixed-v8.16-p4-calibration.json \
  --output agents/safety-score-v9/artifacts/replay-v8.16-p4-legacy.json \
  --allow-methodology-mismatch

npm run report-cards:calibrate-exit-routes -- \
  --input agents/safety-score-v9/artifacts/fixed-v8.16-p4-calibration.json \
  --output shared/data/safety-score-v9/exit-route-calibration-v1.json \
  --generation-id dex-liquidity-1783905029 \
  --producer-generation-status complete \
  --activation-decision hold \
  --decision-reason "Exact DEX capacity coverage is below the general activation floor" \
  --minimum-dex-eligible-assets 45 \
  --minimum-redemption-eligible-assets 27 \
  --allow-methodology-mismatch

npm run safety-score-v9:readiness -- \
  --report-cards agents/safety-score-v9/artifacts/replay-v8.16-p4-legacy.json \
  --dex-liquidity agents/safety-score-v9/artifacts/dex-liquidity-p4a.json \
  --output shared/data/safety-score-v9/readiness-baseline-v1.json \
  --generated-at 2026-07-13T01:30:00.000Z
```

Files under `agents/` are ignored fixed-input/research working artifacts. The two committed JSON reports are the durable decision records.
