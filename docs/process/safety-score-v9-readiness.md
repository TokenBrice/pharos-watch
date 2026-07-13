# Safety Score v9 Readiness

This document describes the pre-v9 compiler, calibration corpus, and current activation gate. It does not define an active Safety Score methodology. Production remains on Safety Score v8.17 and P4 same-notional scoring remains shadow-only.

## Durable Artifacts

- `shared/data/safety-score-v9/historical-fixtures-v1.json`: 26 point-in-time fixtures (12 adverse, 14 resilient). Every source publication is at or before the fixture `asOf`; adverse outcome windows start at or after `asOf`.
- `shared/data/safety-score-v9/calibration-cohort-v1.json`: 24 active assets spanning fiat anchors, CDPs, wrappers, private credit, synthetic designs, RWA funds, bridge scope, dependencies, and missing-evidence cases.
- `shared/data/safety-score-v9/matched-invariants-v1.ts`: expectation-free transformations for redemption, optional routes, reserve and bridge materiality, dependency availability, oracle common mode, evidence criticality, and parent propagation.
- `shared/data/safety-score-v9/exit-route-calibration-v1.json`: all-active P4 producer coverage, calibrated coverage floors, legacy-versus-active score movements, and the activation disposition.
- `shared/data/safety-score-v9/readiness-baseline-v1.json`: final all-active compiler output, itemized manual-evidence audit, calibration-cohort dispositions, historical calibration, route coverage, shadow evaluation, and go/no-go recommendation.

## Compiler Boundary

`shared/lib/safety-score-v9-compiler.ts` converts the exact active `StablecoinMeta` and fixed report-card sets into `CompiledV9AssetInput` records. Compilation fails on duplicate, missing, or unexpected report-card IDs. The readiness generator keeps the report-card observation time separate and sets `compilerEvidenceAsOf` to the latest accepted report-card, DEX-row, or exact-route observation time; `generatedAt` may not precede that evidence clock.

The compiler may carry structured pillar, peg, parent, evidence, implementation-age, failure-domain, and unresolved facts. It must not accept or store:

- desired v9 grades or scores;
- scenario-supplied cap values;
- asset-specific exceptions;
- post-outcome evidence in historical fixtures.

Numeric weights, evidence ceilings, track-record ceilings, bounded-compensability rules, and structural signal caps live only in `shared/lib/safety-score-v9-research.ts`. They are provisional research constants, not production methodology.

Missing critical facts produce reason-coded `NR`. Every unresolved fact is emitted as an itemized audit record with asset, pillar, code, classification, criticality, path, and reason; unsupported designs and unresolved methodology are not silently treated as missing data. The 24-asset calibration cohort also carries per-asset cohorts, candidate grade, disposition, and sorted critical facts. Parent evaluation is deterministic and parent-first; missing parents and cycles remain explicit. Fuzzy implementation dates use the conservative range end, and variants inherit the newest critical implementation layer.

## Current Result

Baseline generated at `2026-07-13T01:30:00.000Z` from report cards observed at `2026-07-13T01:00:16.000Z`; the latest compiler evidence is `2026-07-13T01:10:29.000Z`. The inputs use the fixed v8.16 legacy replay and complete P4a generation `dex-liquidity-1783905029`.

| Gate                                                      |               Result |
| --------------------------------------------------------- | -------------------: |
| Active registry / active report cards                     |            360 / 360 |
| Compiler exceptions / silent omissions                    |                0 / 0 |
| Candidate rateable / reason-coded `NR`                    |              0 / 360 |
| Manual audit items, critical / noncritical                |          2,736 / 130 |
| Manual audit classes, missing / methodology / unsupported |      2,692 / 1 / 173 |
| Calibration cohort, critical-complete / unresolved `NR`   |               0 / 24 |
| Historical adverse / resilient fixtures                   |              12 / 14 |
| Historical rateable / `NR` fixtures                       |               8 / 18 |
| Historical false negatives / false positives              |                0 / 9 |
| Historical look-ahead validation                          |               passed |
| P4 DEX populated / unsupported / unknown assets           |        7 / 173 / 180 |
| Retained-pool assets / retained pools                     |          180 / 4,641 |
| Exact observations / score-eligible observations          |               21 / 0 |
| Raw positive-observation / calibrated DEX-eligible assets |                7 / 0 |
| Calibrated DEX / redemption eligible assets               |               0 / 31 |
| Calibrated DEX / redemption floors                        |              45 / 27 |
| Calibrated coverage floor met                             |                   no |
| Shadow candidate grades / grade changes / new `NR`        | 360 `NR` / 305 / 305 |
| P4 activation decision                                    |                 hold |
| V9 readiness decision                                     |                no-go |

The manual-evidence audit contains 2,866 itemized records: 2,692 `missing-data`, 173 `unsupported-design`, and 1 `unresolved-methodology`; 2,736 are critical. The largest reason-coded queues are 544 material reserve slices without structured evidence, 373 unknown control-cap authorities, 340 unreviewed reserve envelopes, 329 missing upgradeability reviews, 209 unresolved control identities, 180 missing and 173 unsupported same-notional routes, 145 unavailable runtime bridge-materiality facts, 125 missing custody profiles, 95 unresolved selected bridge routes, 76 mint-control questions, 55 missing peg inputs, 36 missing implementation dates, 7 incomplete DEX route-coverage records, and 3 unresolved archetypes. Another 127 missing latest assurance reports are noncritical. These are work queues, not implied defaults.

All 24 calibration-cohort assets are currently `reason-coded-critical-unresolved` and candidate `NR`; the stored dispositions expose the exact blocking facts for manual audit. The shadow pass likewise produces `NR` for all 360 active assets, including 305 entries from currently graded assets. That is a deliberate fail-closed result of the stricter itemized contracts, not a compiler omission.

The historical outcome-blind research pass has no adverse false negatives under the provisional thresholds, but 18 fixtures are `NR` and 9 resilient fixtures are conservative false positives because critical point-in-time evidence was unresolved. That is calibration debt; it is not a reason to weaken the no-look-ahead or critical-evidence rules. P4 remains on `hold` because calibrated DEX coverage is 0 eligible assets against the 45-asset floor; redemption coverage clears its 27-asset floor at 31. The historical P4 generation predates the per-pool `scoreEligiblePoolCount` field, so its 21 observations remain visible but fail closed as incomplete pool coverage. Active replay makes 244 exit scores `NR` and changes 140 overall grades.

## Reproduction

```bash
npm run report-cards:capture-fixed-input -- \
  --exact-cache-export agents/safety-score-v9/artifacts/report-cards-fixed-input-cache.json \
  --output agents/safety-score-v9/artifacts/fixed-v8.16-p4-calibration.json

npm run report-cards:replay -- \
  --input agents/safety-score-v9/artifacts/fixed-v8.16-p4-calibration.json \
  --output agents/safety-score-v9/artifacts/replay-v8.16-p4-legacy.json \
  --dex-max-age-sec 3600 \
  --redemption-max-age-sec 28800

npm run report-cards:calibrate-exit-routes -- \
  --input agents/safety-score-v9/artifacts/fixed-v8.16-p4-calibration.json \
  --output shared/data/safety-score-v9/exit-route-calibration-v1.json \
  --generation-id dex-liquidity-1783905029 \
  --producer-generation-status complete \
  --activation-decision hold \
  --decision-reason "Exact DEX capacity coverage is below the general activation floor" \
  --minimum-dex-eligible-assets 45 \
  --minimum-redemption-eligible-assets 27 \
  --dex-max-observation-age-sec 3600 \
  --live-redemption-max-observation-age-sec 28800

npm run safety-score-v9:readiness -- \
  --report-cards agents/safety-score-v9/artifacts/replay-v8.16-p4-legacy.json \
  --dex-liquidity agents/safety-score-v9/artifacts/dex-liquidity-p4a.json \
  --output shared/data/safety-score-v9/readiness-baseline-v1.json \
  --generated-at 2026-07-13T01:30:00.000Z
```

The exact-cache export may be either the raw private cache envelope or Wrangler's D1 JSON query result. The public endpoint reconstruction mode instead requires `--baseline-output`, `--captured-at`, `--registry-revision`, and `--dex-generation-id`; it is not exact release-calibration evidence. The committed calibration was conservatively rebuilt as a historical drift record from the pre-exact public reconstruction and therefore cannot authorize activation. Replay offers `--allow-methodology-mismatch` but intentionally has no registry-mismatch bypass. Calibration separately offers `--allow-methodology-mismatch` and `--allow-registry-mismatch`; use either only for an explicitly labeled drift study, never for activation evidence. The `p4b-activation-v1` policy defaults to, and refuses any override below, 45 eligible DEX assets and 27 eligible redemption assets. An `activate` request throws instead of writing a contradictory report whenever producer or coverage blockers remain.

Files under `agents/` are ignored fixed-input/research working artifacts. The committed exit-route calibration and readiness baseline are the durable decision records. Production remains on v8.17, P4 remains shadow-only, and no v9 activation is authorized while the recorded dispositions are `hold` and `no-go`.
