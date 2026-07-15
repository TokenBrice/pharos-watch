# Safety Score v9 Readiness

This document describes the Safety Score V9 candidate compiler, evaluator,
shadow pipeline, calibration corpus, and current activation gate. It does not
define an active Safety Score methodology. Production remains on Safety Score
v8.17 and P4 same-notional scoring remains shadow-only.

Release mechanics are governed by the
[single-publisher V9 rollout contract](./safety-score-v9-rollout.md). Candidate
readiness and rollout readiness are independent: neither can override the
other.

## Durable Artifacts

- `shared/data/safety-score-v9/historical-fixtures-v1.json`: 26 point-in-time fixtures (12 adverse, 14 resilient). Every source publication is at or before the fixture `asOf`; adverse outcome windows start at or after `asOf`. Each source now declares its capture state, and each fixture separates fact-freeze from outcome-annotation provenance. The legacy corpus honestly records all 26 sources as unarchived and all authoring controls as retrospective/unverified, so it cannot clear activation evidence integrity.
- `shared/data/safety-score-v9/calibration-cohort-v1.json`: 24 active assets spanning fiat anchors, CDPs, wrappers, private credit, synthetic designs, RWA funds, bridge scope, dependencies, and missing-evidence cases.
- `shared/data/safety-score-v9/matched-invariants-v1.ts`: expectation-free transformations for redemption, optional routes, reserve and bridge materiality, dependency availability, oracle common mode, evidence criticality, and parent propagation.
- `shared/data/safety-score-v9/methodology-policy-candidate-v1.json`: the explicit candidate-only methodology policy, including formula order and constants, evidence dispositions, exit and materiality policy, structural limits, and the complete reason-code registry. It has lifecycle `candidate` and no release version; it is not an active `9.0` policy.
- `shared/data/safety-score-v9/golden-scenarios-v1.ts`: the durable 30-case archetype corpus and 28 ordering constraints used for policy sensitivity and the research evaluator. Expectations remain outside production-shaped scoring inputs.
- `shared/data/safety-score-v9/exit-route-calibration-v1.json`: all-active P4 producer coverage, calibrated coverage floors, legacy-versus-active score movements, and the activation disposition.
- `shared/data/safety-score-v9/readiness-baseline-v1.json`: final all-active compiler output, itemized manual-evidence audit, calibration-cohort dispositions, historical calibration, route coverage, shadow evaluation, and go/no-go recommendation.

## Implementation Status

The V9 implementation establishes candidate infrastructure without changing production scoring:

- `shared/types/safety-score-v9.ts` defines and cross-validates the strict methodology-policy schema, evidence-disposition vocabulary, and exhaustive reason registry.
- `shared/lib/safety-score-v9/policy.ts` loads the candidate policy, canonicalizes its semantic payload with code-unit ordering, computes a domain-separated SHA-256 semantic digest, and makes the closed reason registry authoritative for rateability, treatment, reason-coded ceiling resolution, and audit classification. Lifecycle labels and release metadata are excluded from the semantic digest, so a later promotion can prove that its scoring semantics are unchanged.
- `shared/lib/safety-score-v9-research.ts` and `shared/lib/safety-score-v9-compiler.ts` now require an explicit validated policy. Compiled inputs bind the semantic digest that produced them, and scoring rejects a mismatched policy. Score traces carry both the evaluation policy ID and semantic digest. Production-shaped scoring inputs cannot supply arbitrary numeric caps; that capability is confined to the phase-zero scenario adapter used by the research harness.
- `shared/types/report-cards-base-input.ts` and `shared/lib/report-cards-base-input-identity.ts` define the model-neutral, canonical base-input identity and deterministic generation ID shared by the V8 publisher and V9 candidate.
- `shared/lib/safety-score-v9/exit-observation-set.ts` provides deterministic DEX/redemption observation merging, stable route ordering, duplicate handling, conflict rejection, and per-lane diagnostics.
- `scripts/maintenance/run-safety-score-v9-policy-sensitivity.ts` perturbs one numeric semantic field at a time over the durable golden corpus and reports affected archetypes, grade cliffs, full cap-candidate and binding-cap changes, score saturation, and all 28 pairwise ordering gaps/pass transitions. Its parameter listing contains only fields whose two default isolated perturbations both satisfy the policy schema; coupled fields are not advertised, and explicit invalid attempts fail closed.
- The runtime-neutral `facts`, archetype, Backing, Exit, Control, access-posture,
  dependency, formula, score, trace, stress, coverage, validation, and public
  projection modules under `shared/lib/safety-score-v9/` form one strict
  candidate evaluator. Critical missing facts produce reason-coded `NR`; no
  unrelated pillar can compensate for a binding structural path.
- `worker/src/lib/safety-score-v9-fact-set.ts` builds a schema-versioned fact
  set from one normalized base input plus a V9 extension. Reviewed adapters
  preserve per-component URLs, review dates, content hashes, confidence, and
  freshness and reject future, stale-as-current, or registry-drifted evidence.
  They do not infer permissionlessness, immutable upgrades, incident-free
  history, bridge materiality, or numeric mint caps.
- `worker/src/lib/safety-score-v9-candidate.ts` and
  `worker/scripts/replay-safety-score-v9.ts` compile and evaluate the exact
  candidate deterministically. The current policy semantic digest is
  `6b6f819eb06740634239467ed6041125d7971f8df0fbedf0e4bd836cac405053`;
  the current evaluation-build digest is
  `d86b48b412107d9ecd7ee634850c3d42261f2372d1f5fe99342a372727722b7f`.
- The 2026-07-15 candidate-v2 queue-binding revision adds explicit
  `local-component` paths to seven reason allowlists already emitted as
  aggregate facts. The revision changes evidence-work-queue metadata only;
  treatments, ceilings, dispositions, grade bands, and same-input scores are
  unchanged.
- The 2026-07-14 `safety-score-v9-candidate-v2` policy revision implements the
  rating-parity re-tier: missing research evidence no longer reason-codes
  `NR`. Thirty-two registry codes moved from `NR` to `ceiling` treatments
  through a new `named-ceiling` rule source
  (`semantic.structural.namedReasonCeilings`: control/oracle-unverified 55,
  backing-unverified 60, exit-unverified 65, peg-unverified 60); the two
  dependency-availability codes use the limited-evidence ceiling. Pillar
  evaluators score the corresponding absences at explicit bounded-unknown
  levels (`control.boundedUnknownQuality` 45, backing
  `boundedUnknownQuality` 35, `exit.boundedUnknownScore` 35) instead of
  nulling the pillar, a missing applicable peg floors the multiplier at par
  under the peg-unverified ceiling, bound-only exit costs score at
  `exit.boundedCostScore`, cap candidates deduplicate by (source, kind,
  limit), and the centralized-mint structural severity graduates to `high`
  when unbounded minting is reconciled against reserves. `NR` remains for
  integrity and classification failures only; that stays-NR set is frozen by
  a policy test, and `scripts/maintenance/check-safety-score-v9-parity.mjs`
  gates that every V8-graded asset is V9-rateable up to that allowlist.
  Against the 2026-07-14T04:49Z exact capture (replayed with the local
  extension builder across registry drift, so a labeled drift measurement
  rather than activation evidence) the candidate rates 358 of 361 assets and
  100.00% of tracked supply weight; the three `NR` assets are
  unresolved-archetype classifications. Grade-band re-anchoring against the
  resulting compressed distribution remains an open owner calibration
  decision recorded in the research corpus.
- The 2026-07-15 shadow mechanism-review revision makes CDP metric
  applicability explicit: a null ratio is valid only as source-cited
  structural N/A and is excluded only from its corresponding threshold, while
  measured nulls fail schema validation. Measurement completeness describes
  controller and issuance coverage rather than health, so a fully enumerated
  shutdown or non-redeemable branch remains complete while retaining its
  health warnings and failed mechanism facts. Structural N/A also requires a
  cited rationale whose source URL is present in the measurement evidence; it
  cannot be used as an unsourced substitute for a failed or unavailable read.
  This is candidate-only evaluator behavior and does not change active V8.17;
  its final identity must be carried by a regenerated evaluation-build digest
  before replay or freeze, coordinated with the release owner.
- The shadow extension builder now maps reviewed repository evidence into the
  strict fact set instead of clamping every fact to an unresolved state: peg
  references from the registry peg currency, chain-supply bridge materiality
  reconciled against reviewed bridge-route rows, reviewed route semantics for
  every captured DEX/redemption observation, faithful mint/upgrade/oracle/
  bridge control mapping from mint-authority and risk-review evidence, and
  conservative fiat/tbill mechanism reviews whose evidence-backed components
  are bounded-unknown at the policy's bounded quality. Bounded mechanism
  components gap as the non-critical `bounded-mechanism-review` reason;
  excluded optional exit routes stay on per-route traces instead of imposing
  critical reasons once a score-eligible route carries the exit claim. Full-
  supply redemption rows that quantify no immediate capacity gain a bounded
  observation derived from the row's own reviewed model (redemption
  methodology `v4.18`); the extension retains the identical derivation for
  captures that predate the producer emitting it. Documented-terms route
  evidence lives on the policy's `documentedTermsMaxAgeSec` review cadence
  instead of the producer cron cadence. Capability matrix `p4a.4` reports DEX
  completeness only when every retained pool with a reviewed score-eligible
  execution capability carries a score-eligible exact observation. Generic
  shaped rows remain diagnostic and are excluded from that denominator, while
  malformed, gated, missing, stale, or failed exact-capability rows remain in
  it and fail coverage closed. Legacy matrices and envelopes without the
  explicit capability count cannot be reconstructed and stay bounded-unknown
  rather than arming the reviewed-complete zero-score path. Pure NAV tokens
  (`flags.navToken`) publish a known not-applicable peg fact (the v8 pure NAV
  carve-over): they have no fixed peg by design, so the formula skips the peg
  multiplier instead of reason-coding `missing-applicable-peg`. Under the
  candidate-v2 bounded re-tier, unverified control, backing, exit, and peg
  evidence scores at bounded-unknown levels beneath labeled reason ceilings,
  so the 2026-07-14 drift-labeled replay rates 358 of 361 assets (100.00%
  supply weight) with only unresolved-archetype assets reason-coded `NR`.
  The rateability floors are met in that research measurement, but every
  shadow day remains non-qualifying until a publication-exact capture with a
  matching registry reproduces it and the remaining activation gates pass.
- The `sync-cl-exit-depth` producer now captures generation-fenced Uniswap V3,
  PancakeSwap V3, and Fluid measured-depth profiles. All reviewed deployment
  cohorts are explicitly `activation-pending`: their observations stay
  score-ineligible until archive replay, executed-swap equivalence, independent
  cross-checks, drift analysis, and the required prospective shadow evidence
  are approved. Curve CryptoSwap remains a separate shadow adapter and is never
  interpreted through the StableSwap model.
- After a valid V8 publication commits, the Worker runs V9 in a separate
  failure domain. It retains latest candidate/diff state and one compact daily
  summary. Full replay artifacts are retained only for selected first, final,
  or distinct anomaly evidence. The four-hour slowest producer cadence is
  proven from elapsed time and source generations, not by archiving every
  producer cycle. A V9 compile, retention, or D1 failure cannot suppress or
  replace V8, and a later same-day retry may still select a success.
- `GET /api/admin-safety-score-v9` and the internal admin workspace expose only
  exact retained candidate state. Material movements use append-only semantic
  review keys through `POST /api/admin-safety-score-v9/reviews`; a review record
  cannot activate V9.
- The read-only `safety-score-v9:shadow-gate` evaluator accepts compact daily
  summaries plus the selected immutable artifact rows and derives replay status
  by rebuilding each candidate. It requires at least 14 consecutive UTC days,
  at least two elapsed cycles of the four-hour slowest score-bearing producer,
  and at least two distinct observed and archived `liveReserves` and
  `redemption` generations for one frozen candidate/policy/build/capability and
  operational-policy identity. It also requires exact active-ID and coverage
  evidence, resolved reviews/blockers, and passed first/final/anomaly replays.
  It cannot authorize or activate production at runtime.
- The `ratified-release-coverage` floor intentionally fails closed until the
  frozen V9-9 release cohort and its passing report are wired into the shadow
  producer. Every daily run therefore remains non-qualifying and activation is
  hard-blocked even if the operational shadow infrastructure is deployed.
- Safety history now dual-writes identity-rich V2 rows while preserving the
  public V8 compatibility response. Methodology-boundary rows are excluded from
  continuous V8 history, and no V9 cutover baseline writer exists yet.

These are implemented candidate and operational boundaries, not completed
readiness gates. Report-card fixed-input capture, calibration, replay, and
readiness share canonical registry, DEX, redemption, producer-methodology, and
base-input identities; declared provenance is not trusted on its own.
Production remains on v8.17. The candidate policy is neither independently
validated nor authorized as Safety Score 9.0, and the public V9/consumer cutover
path is deliberately absent.

## Compiler Boundary

`shared/lib/safety-score-v9-compiler.ts` converts the exact active `StablecoinMeta` and fixed report-card sets into `CompiledV9AssetInput` records. Compilation fails on duplicate, missing, or unexpected report-card IDs. The readiness generator combines DEX observations with redemption observations from the fixed publication input before compiling exit evidence. It uses the fixed publication clock as `compilerEvidenceAsOf`; later observations are rejected by the compiler and counted as provenance blockers instead of moving the as-of boundary forward. Exact fixed-input normalization rejects missing DEX methodology provenance or declared producer-version sets that disagree with the score-bearing DEX, peg, and redemption rows; calibration reprojects those versions instead of copying the declaration. The readiness generator validates the fixed-input shape and binds schema-v3 registry, generation, fingerprint, methodology, normalized report-card replay payload, and replay metadata to the committed calibration. It also imports the calibration artifact's decision, activation-ready flag, consistency flag, and blocker list into the final recommendation; recomputed coverage cannot override an explicit hold. Readiness remains blocked unless the fixed capture is schema v3 `exact-publication-inputs`, the calibration source records `exact-publication-inputs`, no mismatch bypass was used, the calibration explicitly authorizes activation, and every binding agrees.

The compiler may carry structured pillar, peg, parent, evidence, implementation-age, failure-domain, and unresolved facts. The historical compiler accepts `HistoricalV9FactsInput`, a strict facts-only projection that excludes outcome labels and outcome annotation provenance at the type and runtime schema boundary. It must not accept or store:

- desired v9 grades or scores;
- scenario-supplied cap values;
- asset-specific exceptions;
- post-outcome evidence in historical fixtures.

Numeric weights, evidence ceilings, track-record ceilings, bounded-compensability rules, structural signal caps, and exit-model constants now live in the explicit candidate policy. The scorer reads them through the validated policy envelope rather than hidden defaults. They remain provisional candidate semantics, not production methodology.

Missing critical facts produce their exact reason-coded `NR`. Bounded facts with a `ceiling` treatment emit an executable reason cap that references an existing evidence or minimum track-record ceiling; a ceiling treatment cannot validate without such a rule. Every unresolved fact is emitted as an itemized audit record with asset, pillar, code, classification, criticality, path, and reason; its owner, fact class, boundedness, treatment, release severity, and public label are declared once in the candidate registry rather than duplicated on every row. Unsupported designs and unresolved methodology are not silently treated as missing data. The 24-asset calibration cohort also carries per-asset cohorts, candidate grade, disposition, and sorted critical facts. Parent evaluation is deterministic and parent-first; missing parents and cycles remain explicit. Fuzzy implementation dates use the conservative range end, and variants inherit the newest critical implementation layer.

## Latest Recorded Result

Baseline generated at `2026-07-13T02:00:00.000Z` from report cards observed at `2026-07-13T01:00:16.000Z`; the fixed compiler evidence boundary is `2026-07-13T01:02:53.000Z`. The inputs use the fixed v8.16 legacy replay and the P4a observations stored in that fixed input. The available fixed input is schema v1 `legacy-unverified`, not a publication-exact schema v3 capture. It also cannot bind generation/fingerprint metadata to the committed calibration, its normalized replay payload and methodology differ from the calibrated replay, and 381 supplied evidence timestamps are later than its clock. The committed P4 calibration is itself a public reconstruction produced with methodology and registry mismatch allowances. Each condition independently blocks readiness.

| Gate                                                      |                 Result |
| --------------------------------------------------------- | ---------------------: |
| Baseline active registry / active report cards            |              360 / 360 |
| Fixed input schema / capture kind                         | v1 / legacy-unverified |
| Compiler exceptions / silent omissions                    |                  0 / 0 |
| Candidate rateable / reason-coded `NR`                    |                0 / 360 |
| Manual audit items, critical / noncritical                |            2,228 / 759 |
| Manual audit classes, missing / methodology / unsupported |        2,820 / 0 / 167 |
| Calibration cohort, critical-complete / unresolved `NR`   |                 0 / 24 |
| Historical adverse / resilient fixtures                   |                12 / 14 |
| Historical rateable / `NR` fixtures                       |                 8 / 18 |
| Historical adverse rateable / `NR`                        |                  3 / 9 |
| Historical resilient rateable / `NR`                      |                  5 / 9 |
| Historical false negatives / false positives              |                  0 / 9 |
| Historical timestamp chronology validation                |                 passed |
| Historical source immutability / authoring blinding       |                blocked |
| P4 DEX populated / unsupported / unknown assets           |          7 / 173 / 180 |
| Retained-pool assets / retained pools                     |            180 / 4,641 |
| DEX observations / score-eligible observations            |                 21 / 0 |
| Redemption observation assets / observations              |              108 / 108 |
| Redemption score-eligible assets / observations           |                31 / 31 |
| Redemption resolved / unresolved / unknown outputs        |           48 / 46 / 14 |
| Raw positive-observation / calibrated DEX-eligible assets |                  7 / 0 |
| Calibrated DEX / redemption eligible assets               |                 0 / 31 |
| Calibrated DEX / redemption floors                        |                45 / 27 |
| Calibrated coverage floor met                             |                     no |
| Shadow candidate grades / grade changes / new `NR`        |   360 `NR` / 305 / 305 |
| P4 activation decision                                    |                   hold |
| V9 readiness decision                                     |                  no-go |

The manual-evidence audit contains 2,987 itemized records: 2,820 `missing-data` and 167 `unsupported-design`; 2,228 are critical under the candidate registry and 759 are noncritical. The largest reason-coded queues are 544 material reserve slices without structured evidence, 373 unknown control-cap authorities, 340 unreviewed reserve envelopes, 329 missing upgradeability reviews, 209 unresolved control identities, 184 missing and 167 unsupported same-notional routes, 145 unavailable runtime bridge-materiality facts, 127 missing latest assurance reports, 125 missing custody profiles, 95 unresolved selected bridge routes, 81 CDP oracle branch-applicability decisions, 76 mint-control questions, 55 missing peg inputs, 36 missing implementation dates, 22 unresolved exit outputs, 21 future-dated route facts, 7 incomplete DEX route-coverage records, and 3 unresolved archetypes. Material reserve slices, missing implementation dates, unresolved optional exit outputs, and missing assurance reports are noncritical pillar/ceiling/diagnostic cases under the current policy; their old compiler-authored booleans no longer force `NR`. These are work queues, not implied defaults.

The separate static P7 audit has exact route rows for all 218 applicable multi-deployment profiles, but only 9 profiles are semantically complete. The other 209 profiles contain unresolved rows: 1,124 of 1,216 total routes remain unresolved, while 92 are reviewed. The 95 unresolved selected bridge routes above are only the runtime-selected scoring subset of that larger static research queue.

All 24 calibration-cohort assets are `reason-coded-critical-unresolved` and candidate `NR` in the recorded baseline; the stored dispositions expose the exact blocking facts for manual audit. That shadow pass likewise produced `NR` for all 360 snapshot assets, including 305 entries that were graded in its V8 input. These figures remain bound to the dated artifact above; the live active registry can change independently. The result is a deliberate fail-closed outcome of the stricter itemized contracts, not a compiler omission.

Only 3 of 12 adverse fixtures and 5 of 14 resilient fixtures are currently rateable; the other 9 in each outcome class are `NR`. There are no false negatives among the three rateable adverse cases, while all nine resilient `NR` cases count as conservative false positives because critical point-in-time evidence was unresolved. Those denominators make the limitation explicit: this is calibration debt, not evidence that the candidate has already proved broad historical separation. The corpus has passed only source-date chronology. Its source pages are mutable and unarchived, and its original author separation/outcome access was not preserved; readiness therefore records both conditions as explicit no-go blockers rather than presenting a look-ahead-proof claim. P4 remains on `hold` because its source is a public reconstruction with methodology/registry bypasses and calibrated DEX coverage is 0 eligible assets against the 45-asset floor; redemption coverage clears its 27-asset floor at 31. The historical P4 generation predates the per-pool `scoreEligiblePoolCount` field, so its 21 observations remain visible but fail closed as incomplete pool coverage. Active replay makes 244 exit scores `NR` and changes 140 overall grades.

## Local Artifact Reproduction

The following commands reproduce the tracked decision records only in a workspace that retains the ignored historical inputs under `agents/safety-score-v9/artifacts/`. Those inputs are research working data, not a clean-clone archive.

```bash
npm run report-cards:calibrate-exit-routes -- \
  --input agents/safety-score-v9/artifacts/fixed-v3-public-p4-calibration.json \
  --output shared/data/safety-score-v9/exit-route-calibration-v1.json \
  --generation-id dex-liquidity-1783905029 \
  --producer-generation-status complete \
  --activation-decision hold \
  --decision-reason "No retained-pool asset has score-eligible complete DEX coverage under the per-pool gate, below the 45-asset activation floor; strict active replay makes 244 exit scores NR and changes 140 overall grades, so v8 scoring remains legacy until publication-exact complete-pool coverage improves" \
  --minimum-dex-eligible-assets 45 \
  --minimum-redemption-eligible-assets 27 \
  --dex-max-observation-age-sec 3600 \
  --live-redemption-max-observation-age-sec 28800 \
  --allow-methodology-mismatch \
  --allow-registry-mismatch

npm run safety-score-v9:readiness -- \
  --report-cards agents/safety-score-v9/artifacts/replay-v8.16-p4-legacy.json \
  --fixed-input agents/safety-score-v9/artifacts/fixed-v8.16-p4-calibration.json \
  --output shared/data/safety-score-v9/readiness-baseline-v1.json \
  --generated-at 2026-07-13T02:00:00.000Z

npm run safety-score-v9:sensitivity -- \
  --output agents/safety-score-v9/results/v9-implementation/policy-sensitivity-candidate-v1.json
```

When those ignored files are present, each output above is byte-reproducible. A clean clone cannot rebuild the tracked calibration or readiness JSON until the corresponding fixed inputs are archived in a durable, content-addressed location. The calibration remains a historical drift record and cannot authorize activation; its two mismatch flags are intentional historical-drift allowances.

## Future Exact Capture

Once a private publication cache export is available, capture and replay it under distinct v9 filenames rather than overwriting the legacy baseline inputs:

```bash
npm run report-cards:capture-fixed-input -- \
  --exact-cache-export agents/safety-score-v9/artifacts/report-cards-fixed-input-cache.json \
  --output agents/safety-score-v9/artifacts/fixed-v9-publication-exact.json

npm run report-cards:replay -- \
  --input agents/safety-score-v9/artifacts/fixed-v9-publication-exact.json \
  --output agents/safety-score-v9/artifacts/replay-v9-publication-exact.json \
  --dex-max-age-sec 3600 \
  --redemption-max-age-sec 28800

npm run safety-score-v9:replay -- \
  --input agents/safety-score-v9/artifacts/fixed-v9-publication-exact.json \
  --output agents/safety-score-v9/artifacts/replay-v9-candidate.json \
  --published-at 2026-07-13T02:00:00.000Z \
  --publication-epoch 0
```

The exact-cache export may be either the raw private cache envelope or Wrangler's D1 JSON query result. The V9 replay accepts the resulting normalized exact JSON or the raw exact-cache envelope, uses only its explicit publication time and epoch, and emits the same candidate-pipeline intermediates and identities needed for byte comparison. An optional `v9-rc-N` ID labels the replay but does not promote the candidate policy or authorize release. No such publication-exact artifact is currently available in the research corpus. The public endpoint reconstruction mode instead requires `--baseline-output`, `--captured-at`, `--registry-revision`, and `--dex-generation-id`; it is not exact release-calibration evidence. V8 replay offers `--allow-methodology-mismatch` but intentionally has no registry-mismatch bypass. Calibration separately offers `--allow-methodology-mismatch` and `--allow-registry-mismatch`; use either only for an explicitly labeled drift study, never for activation evidence. The `p4b-activation-v1` policy defaults to, and refuses any override below, 45 eligible DEX assets and 27 eligible redemption assets. An `activate` request throws instead of writing a contradictory report whenever producer or coverage blockers remain.

Files under `agents/` are ignored fixed-input/research working artifacts. The committed candidate policy, exit-route calibration, and readiness baseline are durable decision records, but their ignored source captures are not yet a durable evidence archive. An exact schema-v3 `exact-publication-inputs` capture with matching registry, producer generation, fingerprint, methodology, and replay bindings remains an activation blocker. Production remains on v8.17, P4 remains shadow-only, and no v9 activation is authorized while the recorded dispositions are `hold` and `no-go`.
