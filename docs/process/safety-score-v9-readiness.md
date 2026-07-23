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
- `shared/data/safety-score-v9/golden-scenarios-v1.ts`: the durable 30-case archetype corpus and 32 ordering constraints used for policy sensitivity and the research evaluator. Expectations remain outside production-shaped scoring inputs.
- `shared/data/safety-score-v9/exit-route-calibration-v1.json`: all-active P4 producer coverage, calibrated coverage floors, legacy-versus-active score movements, and the activation disposition.
- `shared/data/safety-score-v9/readiness-baseline-v1.json`: final all-active compiler output, itemized manual-evidence audit, calibration-cohort dispositions, historical calibration, route coverage, shadow evaluation, and go/no-go recommendation.

## Implementation Status

The V9 implementation establishes candidate infrastructure without changing production scoring:

- `shared/types/safety-score-v9.ts` defines and cross-validates the strict methodology-policy schema, evidence-disposition vocabulary, and exhaustive reason registry.
- `shared/lib/safety-score-v9/policy.ts` loads the candidate policy, canonicalizes its semantic payload with code-unit ordering, computes a domain-separated SHA-256 semantic digest, and makes the closed reason registry authoritative for rateability, treatment, reason-coded ceiling resolution, and audit classification. Lifecycle labels and release metadata are excluded from the semantic digest, so a later promotion can prove that its scoring semantics are unchanged.
- `shared/lib/safety-score-v9-research.ts` and `shared/lib/safety-score-v9-compiler.ts` now require an explicit validated policy. Compiled inputs bind the semantic digest that produced them, and scoring rejects a mismatched policy. Score traces carry both the evaluation policy ID and semantic digest. Production-shaped scoring inputs cannot supply arbitrary numeric caps; that capability is confined to the phase-zero scenario adapter used by the research harness.
- `shared/types/report-cards-base-input.ts` and `shared/lib/report-cards-base-input-identity.ts` define the model-neutral, canonical base-input identity and deterministic generation ID shared by the V8 publisher and V9 candidate.
- `shared/lib/safety-score-v9/exit-observation-set.ts` provides deterministic DEX/redemption observation merging, stable route ordering, duplicate handling, conflict rejection, and per-lane diagnostics.
- `scripts/maintenance/run-safety-score-v9-policy-sensitivity.ts` perturbs one numeric semantic field at a time over the durable golden corpus and reports affected archetypes, grade cliffs, full cap-candidate and binding-cap changes, score saturation, and all 32 pairwise ordering gaps/pass transitions. Its parameter listing contains only fields whose two default isolated perturbations both satisfy the policy schema; coupled fields are not advertised, and explicit invalid attempts fail closed.
- The runtime-neutral `facts`, archetype, Backing, Exit, Control, access-posture,
  dependency, formula, score, trace, stress, coverage, validation, and public
  projection modules under `shared/lib/safety-score-v9/` form one strict
  candidate evaluator. Critical missing facts produce reason-coded `NR`; no
  unrelated pillar can compensate for a binding structural path.
- `worker/src/lib/safety-score-v9-fact-set.ts` builds a schema-versioned fact
  set from one normalized base input plus a V9 extension. Reviewed adapters
  preserve per-component URLs, review dates, content hashes, confidence, and
  freshness and reject future, stale-as-current, or registry-drifted evidence.
  The producer derives canonical chain and deployment supply shares only from
  the exact USD-denominated chain-supply input and reviewed route matches; it
  does not infer permissionlessness, immutable upgrades, incident-free history,
  or numeric mint caps.
- `worker/src/lib/safety-score-v9-candidate.ts` and
  `worker/scripts/replay-safety-score-v9.ts` compile and evaluate the exact
  candidate deterministically. The selected shadow calibration candidate is
  policy `5d90e0bdb2990844ea3af0de7cf05044bf81900203774e64bfc5e406baa31719`,
  evaluation build `10d76e3e6d38556841c9175c83d0850ce111e6c0477877cc32bf1a39fdf0b30c`,
  compiler schema `4707f71439205b75a875726e759534f60e4ef363137052bd3126c80a2177d6e0`,
  producer capability `6b2a7a9287636425b75304d2f88bdb7a422ed3e8b53a3ffe1971796798e35ad8`,
  and candidate ID
  `safety-score-v9-candidate:v1:9589f4bec11e7a066232cc2167a6c6ea9438a5bcc76c0a0fa4c70b5a0de4fecd`.
  It has not been deployed or frozen for qualification.
- **IDENTITY FREEZE RESCINDED BY OWNER RULING 2026-07-16; CALIBRATION SPRINT IN
  EFFECT:** deployed Batch 5 remains policy `5f4f92eec713b65b30d60e3cd8d05a613ab86b4512db4dead699c9b85c30f15e`
  and build `ad5870b23bd1e09b586edb123c504aa0729e0d5d9b3b5201c6830b6d7f336dff`;
  it no longer accrues activation days. The owner reopened the identity after
  confirming that the shipped evaluator applies the 5% material-share gate only
  to chain common mode, while the Batch 5 ruling requires it across domain kinds.
  Identity-bound changes to policy, engine, schema, or producer capability may
  proceed only through retained same-input calibration replays. A later explicit
  owner re-freeze of a deployed identity is required before any prospective
  qualifying window can begin. Each kept identity-bound batch also pays the
  deterministic digest pin, generated manifest, and readiness-pin refresh cost;
  batch same-day changes so those identity updates happen once, never against a
  stale manifest.
- The 2026-07-15 Batch 3 calibration revision (owner rulings 2026-07-15)
  applies the two ruled cap changes and nothing else. (1) The mint posture gains
  a distinct `unbounded-reconciled` rung (`mintPostureQuality` = 55) for an
  economically unbounded mint whose supply is reconciled against reserves; only
  compromise or an unreconciled/unknown mint stays `unbounded-or-compromised`
  (25). Its centralized-mint severity is `high`, graduating to `moderate`
  (centralized-mint `moderate` = 74) when the reviewed
  `economicControlReview.mint.supervision` fact is `prudential`. Supervision
  defaults to `unknown` everywhere and the rung requires reconciliation
  evidence, so the graduation stays inert for top attested issuers; compromise
  and unreconciled minting stay `critical`. (2) Common-mode dependency severity is now conditioned on
  chain maturity: a shared chain-kind failure domain in the reviewed
  `materiality.matureChains` set grades at `moderate` (critical-dependency
  `moderate` = 79, top of B+); any fragile, unreviewed, or non-chain domain
  stays fail-closed at `high` (64). The ruling is on chains rather than string
  encodings, so the failure-domain key is normalized to its canonical slug via
  `resolveChainId` before the `matureChains` match — exit-route facts key by slug
  (`ethereum`) while supply facts key by DefiLlama display name (`Ethereum`,
  `OP Mainnet`), and both now tier identically; an unresolvable name stays
  fail-closed at `high`. Dials, bands, and every other cap are untouched;
  full-distribution confirmation follows the post-DEX-fix measurement. The
  data-side authoring contract for the mint rung lives on the strict
  `MintAuthorityProfile`: optional reviewed `economicCapSemantics` (supersedes the
  encoding-derived cap), `reconciliation` (supersedes the proof-of-reserves
  inference), and `supervision` (graduates the reconciled rung). Absent fields
  reproduce today's behavior exactly; the reference shape and precedence are
  pinned by `worker/src/lib/__tests__/safety-score-v9-mint-authoring-contract.test.ts`.
- The 2026-07-16 Batch 4 calibration revision (owner ruling Batch 4, option A)
  grades a chain common-mode signal by MATERIAL exposure rather than path count.
  `materiality.commonModeShareThreshold` (0.05) sets the immateriality floor.
  Chain exposure comes from the conserved, canonical `supply.chainDistribution`
  rows; unresolved source labels remain unattributed and fail closed. A
  non-mature chain below 5% grades `moderate`, while a material or unattributable
  non-mature share grades `high`; mature chains stay `moderate`.
- The 2026-07-16 Batch 5 calibration revision (owner ruling Batch 5) extends the
  5% common-mode decision to DEX and bridge domains. DEX exposure uses distinct,
  score-eligible executable capacity at the policy stress notional; incomplete,
  stale, or unvalued coverage remains unknown. Bridge-domain exposure joins
  reviewed deployment supply to reviewed tiers, with missing or ambiguous joins
  failing closed. Mature or proven-immaterial DEX domains are diagnostic; proven
  immaterial bridges are `moderate`, while material bridges retain their reviewed
  tier semantics. Reserve-issuer concentration remains diagnostic because
  backing already prices the same obligor.
- The 2026-07-16 real-A calibration batch makes proportional chain, DEX, and
  bridge common mode diagnostic below 5%, moderate from 5% to below 10%, and
  high at 10% or when exposure is unknown. Mature chain and DEX ecosystem
  domains remain diagnostic; serial control domains do not enter this
  proportional path. Whole missing mechanism reviews now retain known reserve
  evidence and charge only the missing authored components at the existing
  bounded quality, while authored partial reviews and integrity failures keep
  their stricter treatment. The route compiler carries reviewed modeled
  confidence instead of re-deriving it from execution certainty, defaults old
  schema-v2 rows conservatively to low, and applies static-open suppression only
  in the V9 adapter so public Redemption Backstop v4.18 remains unchanged.
  Exact tracked-asset reserve slices inherit the evaluated upstream bound;
  vague labels stay unresolved. Partially reviewed control inventories now
  localize known status to semantically complete controls, including a known
  authority model and incident state. The score-bearing mechanism overlay is
  included in the evaluation-build manifest.
- Deployment control is a separate 10% gate, not the 5% common-mode gate. Every
  reviewed non-native supply row requires exactly one known control and one
  reviewed route with the same share. Explicit native rows require no bridge
  control. Unmatched deployments and pooled uncanonicalized labels must each be
  strictly below 10%; unknown, stale, ambiguous, duplicate, or non-conserved
  inventories fail closed. Retained rows that predate the native/controlled
  discriminator remain parseable but cannot earn a native exemption.
- The sprint limits the global evidence ceiling to reasons whose policy treatment
  is `ceiling`; owning-pillar and diagnostic reasons stay visible without adding
  a second global 69 cap. Exact USD chain supply is consumed directly without
  price multiplication. LUSD now carries its reviewed immutable mint posture,
  while FXUSD records native Ethereum issuance and the independently controlled
  0.54% LayerZero Base deployment. A missing live peg deviation also no longer
  erases an independently observed active-depeg score and peak: the current field
  remains bounded-unknown while the adverse facts continue to score.
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
- A recorded disposition **carries forward** across runs while the movement's
  class is unchanged. The class is the movement with its exact magnitude
  removed: grades, binding-cap kinds, reason codes, weakest-pillar name,
  downstream threshold crossings and structural flags are retained, while exact
  scores, deltas and the continuous weakest-pillar score are delegated to a
  reviewed-score anchor. A carry applies only when both the reviewed V8 and V9
  scores are within `V9_SHADOW_MOVEMENT_REVIEW_CARRY_SCORE_DRIFT` (3 points) of
  today's, which bounds cumulative drift for the whole window rather than per
  run. Any class change — a grade, reason code, cap kind or crossing-set move —
  expires the carry and re-pends the movement, so a `defect`-class movement can
  never inherit a benign disposition. The exact review key and the reviewed
  scores stay recorded, and each carried card names the review it came from, so
  a reviewer can always separate what was adjudicated from what was carried.
- The read-only `safety-score-v9:shadow-gate` evaluator accepts compact daily
  summaries plus the selected immutable artifact rows and derives replay status
  by rebuilding each candidate. It requires at least 8 consecutive UTC days
  (14 before the 2026-07-23 owner amendment recorded below),
  at least two elapsed cycles of the four-hour slowest score-bearing producer,
  and at least two distinct observed and archived `liveReserves` and
  `redemption` generations for one frozen candidate/policy/build/capability and
  operational-policy identity. It also requires exact active-ID and coverage
  evidence, resolved blockers, and passed first/final/anomaly replays.
  It cannot authorize or activate production at runtime.
- **Movement adjudication is evaluated at window end, not per day.** Pipeline
  stability and methodology adjudication are distinct properties: whether V9's
  treatment of an asset is correct is a one-time question about the transition,
  not evidence that today's run was stable. Re-adjudicating an asset because its
  score moved a point serves neither. `unresolvedCriticalMovementIds` and
  `pendingReviewCount` are therefore recorded on every run but enforced once, on
  the final day of the window, by the offline gate. "Nothing ships
  unadjudicated" is preserved exactly. Every pipeline-stability floor —
  active-result-count, minimum-rateable-assets, scheduled-start-latency,
  ratified-release-coverage, replayability and no-compiler-exceptions — still
  gates every single day.
- The `ratified-release-coverage` floor intentionally fails closed until the
  frozen V9-9 release cohort and its passing report are wired into the shadow
  producer. Every daily run therefore remains non-qualifying and activation is
  hard-blocked even if the operational shadow infrastructure is deployed.
  Wiring it requires TWO distinct owner-supplied artifacts, because the floor
  works with two different identifiers:
  - The **sealed release-candidate label** (`v9-rc-N`) names an owner-ratified
    release line and is the primary key of `safety_score_v9_release_cohorts`.
  - The **content-addressed candidate id**
    (`safety-score-v9-candidate:v1:<sha256>`) names one day's exact evaluation
    and is what the coverage report's policy, evaluation-build, fact-set, and
    result digests bind to. It is computed per run and is never a cohort key.

  A shadow run computes the second and must be told the first, so the owner
  must supply, out of band in production D1:
  1. the ratified cohort row itself, keyed by the sealed label; and
  2. one `cache` row designating which sealed label is under the gate —
     key `safety-score-v9:sealed-release-candidate`, value
     `{"schemaVersion":1,"releaseCandidateId":"v9-rc-N"}`.

  The designation only SELECTS a cohort; it authorizes nothing. A missing,
  malformed, or wrong designation resolves to no cohort row, or to a cohort
  whose policy/evaluation-build digests do not match the day's candidate, and
  the floor fails closed with `ratified-release-coverage-unavailable` either
  way. Until both artifacts exist the floor remains the standing release
  blocker by design.
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

## 2026-07-17 Anchor-Coherence Batch Chain

Five accepted, identity-chained engine batches implemented the 2026-07-17
owner rulings (anchor set R1–R9 and D1–D15; the working record lives in the
ignored research workspace's anchor-coherence plan):

1. Stage A/B (`02f7d183`, `148389d2`): mature-domain conditioning for
   tron/hyperliquid/xrpl/raydium, the superseded Batch3#1 mint ladder
   (prudential+reconciled uncapped, attestation-only+reconciled capped 83),
   graded control posture, issuer-scoped mint-control common-mode, the
   36-month peg window, and owner-ratified 0.80-confidence admission of
   prudentially supervised, independently signed issuer-attested reserve
   compositions.
2. Reviewed transfer facts (`6695f228`): a V9-only transfer overlay
   (permissionless/restrictable/permissioned) preferred by the access
   adapter, with a 365-day access-evidence freshness bound; missing facts
   stay fail-closed and the public V8 producer is byte-unchanged.
3. Shock-coverage integration (`cf71c1ba`): journaled 50% shock-demand
   coverage (`cdp.instantaneousCollateralShock = 0.5`) preferred over
   legacy liquidation-capacity when a complete measurement is at most
   259,200 seconds old; staleness and incompleteness fall back visibly to
   the legacy ratio. LUSD clears `unsafe-backing:high` at `coverage50 = 1`
   on the pinned input; MIM and all six adverse projections are
   hash-identical across the chain.
4. CL measured-execution activation (`615a7fea`): the owner-ratified
   six-key QuoterV2 cohort became score-eligible behind the existing
   fail-closed gate; unratified deployments remain shadow-only.
5. Fresh-capture defect fixes (`0a6767d34`, `6d1fdaa84`; rulings D14/D15):
   venue maturity resolves on the version-stripped family key so live
   measured-execution registrations (`uniswap-v3`, `pancakeswap-v3`) match
   `matureVenues` — the first post-deploy envelope had fail-closed 36 coins
   to spurious `critical-dependency:high@64` — pancakeswap joins
   `matureVenues` (D14), and the same-issuer diagnostic treatment extends
   from mint-control to upgrade-control groups (D15; cross-issuer and
   unresolved identities keep failing closed). The reviewed reserve join
   tolerates 5pp of live weight drift (was 0.5pp, which severed 36 coins'
   classifications on ordinary issuer rebalancing); identity stays the
   bijection-guarded name match and scoring weights come from the live row.
6. Bounded unrecognized-supply treatment, reserve itemization, and dead-ladder
   cleanup (rulings D-J, 1i(b), D-E, 2026-07-19): an unrecognized provider
   chain-label pool below the common-mode materiality floor is a bounded
   condition — excluded from the common-mode unattributed add-on, tolerated by
   both supply completeness proofs, and kept visible through the new
   diagnostic-only reason `immaterial-unrecognized-chain-pool` (at or above
   the floor the pool stays fail-closed exactly as before). The
   `ripple-transparency` reserve adapter itemizes its one hard-coded 100%
   aggregate slice into the Deloitte-examined May 2026 composition (T-bills
   65.41% / government money-market funds 19.44% / cash 15.15%), deriving the
   split from the payload when the transparency page carries a breakdown and
   falling back to the attested static split otherwise; the
   undercollateralization breaker is unchanged. The never-emitted
   `bounded-unknown` structural signal ladder (high@69/critical@49) is
   removed from the policy surface.
7. Evidence-derived DEX route model confidence (E-3, 2026-07-19): the v9 DEX
   route review no longer hardcodes `modelConfidence: "medium"` on every
   route — a `measured-executable-depth` observation (the producer's own
   realized-quote evidence) now earns `high`, while simulated, orderbook,
   proxy, fallback, and unobserved evidence kinds keep `medium`.
   `executionCertainty` and every other review field are unchanged, and the
   policy's confidence-factor tables already carried both tiers, so the
   policy digest is untouched. Replaying the captured 2026-07-18 exact
   envelope (freshness-shifted to 2026-07-19, 7 since-delisted assets
   dropped): 30 assets move, all upward — 29 hold score-eligible measured
   routes and lift their exit pillar (USDC 74.75 to 98.87, quality score
   80.54 to 88.98, composite held at 55/C by the binding
   `material-bridge-supply-unmatched` reason cap; USDT 69/B- to 77/B+; EURC
   73/B to 81/A-), and honey-berachain lifts only through its 100% USDe
   reserve dependency. The six adverse projections stay byte-identical —
   USDD 39, U 32, USDai 39, EURS 21, MIM 0, TUSD 48 (TUSD holds no measured
   routes).
8. ROTATION-1 (2026-07-23 owner rulings D1-D6, the calibration program's
   final identity rotation before release): five levers ship as one
   identity-bound batch. Proportional common-mode severity banding extends
   the existing chain-materiality treatment to `critical-dependency`
   signals: `commonModeShareThreshold` moves 0.05 to 0.10 and
   `commonModeHighShareThreshold` moves 0.10 to 0.25 in
   `methodology-policy-candidate-v1.json`, so a measured common-mode share
   under 10% stays low, 10% to under 25% grades moderate (79), and 25% or
   more — or an unknown/unattributed share — stays fail-closed high (64);
   pinned shares remain final per the existing measurement-finality ruling.
   A new peg-matched `commodity-allocated` reserve-asset class (quality 90,
   maturity not applicable) is admitted only where the reserve's held metal
   equals the coin's peg metal (XAUT, PAXG, KAU, KAG, XAUM); a metal reserve
   behind a non-metal peg keeps scoring as `other` (40) — the peg-match
   predicate guards against relabeling an unrelated commodity position as
   peg-matched collateral. Reviewed redemption routes gain two exit
   credits: `buildOutputReview` (`worker/src/lib/safety-score-v9-extension-routes.ts`)
   now values an unenumerated-asset collateral-basket output at the same
   USD-normalized par valuation and mixed-collateral quality discount as an
   enumerated one instead of returning null, and a reviewed resolved/open
   route with a disclosed-as-undisclosed fee earns modeled capacity under a
   new `undisclosedFeeRouteScoreCeiling` (52) instead of zero, gated by an
   explicit exclusion for any coin carrying an active danger signal so the
   credit cannot reach the hard-danger set. The oracle lane gains branch
   materiality: a new `OracleRiskBranch.debtSharePct` field lets
   `adaptOracleReview` (`worker/src/lib/safety-score-v9-extension.ts`) feed
   `evaluateV9EconomicControl` (`shared/lib/safety-score-v9/control.ts`) a
   share-gated worst-MATERIAL-branch read instead of an unconditional
   worst-of-all-branches read; a weak branch under 10% of measured debt no
   longer drags the whole CDP to the worst tier by itself, and a branch with
   no measured share keeps failing closed at the worst tier. Seasoned-issuer
   mint credit widens: `control.mintPostureGrading.seasonedCreditPoints`
   moves 5 to 10, still bounded by the next mint-posture rung and still
   unavailable to pinned or hard-danger coins. Riders in the same batch: a
   per-coin AUSD mint-supervision ruling, a DOLA mechanism-overlay honesty
   downgrade, and cap/ceiling reason-string corrections that were
   foregrounding the wrong driver for measured-share caps.
   `docs/process/safety-score-v9-rollout.md` records the paired
   qualifying-window amendment (14 to 8 consecutive UTC days) that ships
   with this batch. This entry records the batch's scope; its policy and
   evaluation-build digests are added here once the batch is deployed and
   the identity is frozen.

The final candidate identity of the chain is policy digest
`76bb98ce18a7f798a2953fb3fce86c36b4809994cfbcb4310d0a7b9e4d3037d1` and
evaluation-build digest
`fa2eb030ec07e265100ede8ae8374d2dee21f712a443b67f1989dbd29143f16f`
(reshape-v3 batch, 2026-07-22: backing-scale re-anchor T4 + seasoned-issuer credit T5
+ documented-fee exit ceiling T1, on top of the reshape-v2 batch [F-gate split D1,
parent-controlled dedup D2, TUSD pin release D8, floor re-derivation D6] — prior pair
policy `91770d4e…` / build `545b3ba8…`;
prior identity `bba4fe1461967763895f0bc2fe0fe56af3c37334ce969141…` from the
2026-07-21 reshape PR #618; the earlier `6917d1f6…` pin here predated #618 and
was never re-pinned, an omission this entry closes)
(the batch-6 identity was evaluation-build digest
`55d7838d57ca7f5ec172527c9c1908f853e4e927609f5038d30b81282d4a5425`,
candidate
`safety-score-v9-candidate:v1:301a4bc45f26506834f943aeb617531422f2f64358bd2f431e940e802c8b901d`
on the captured 2026-07-18 exact envelope: A 1, B+ 1, B 6, B- 1, with
RLUSD lifted 66 to 72 (B- to B) by the reserve itemization and the six
adverse projections byte-identical — USDD 39, U 32, USDai 39, EURS 21,
MIM 0, TUSD 48; the E-3 replay above re-verified those six projections
byte-identical under the new build digest).
Every batch was accepted against the same pinned 2026-07-16 exact input
with per-change causal attribution and byte-identical adverse projections;
batch 5 was additionally verified against the fresh 2026-07-18 production
envelope. These are calibration results, not activation evidence; V8.17
remains the public methodology and the recorded no-go ruling stands until
a qualifying window under an owner-frozen deployed identity completes.

## 2026-07-16 Real-A Calibration Result

The latest calibration projection uses registry fingerprint
`b7c6f74a5eb4183571a50a4b5b41ee3fdedf8cf5d97b8830e9192b3867e50fb6`
and the candidate identities pinned in Implementation Status. It remains a
local reviewed-registry projection rather than activation evidence: the three
production inputs were captured before that registry evidence was deployed and
were rekeyed locally. V8.17 remains the public methodology.

Release review corrected four feUSD debt-cap controls that an administrator can
raise and restored USDKG physical bullion to the active V8 reserve-risk rubric.
Rekeying all three captures changed their registry, base-input, fact-set, and
result identities but did not change any V9 score, grade, or histogram count.

The retained engine-only replay and the reviewed evidence batch establish the
following distribution:

| Replay                       | Grade distribution                                    | C- or better | B- or better | IQR |
| ---------------------------- | ----------------------------------------------------- | -----------: | -----------: | --: |
| Locked baseline              | B+ 1, B 1, C+ 2, C 9, C- 12, D 105, F 212, NR 2       |           25 |            2 |   9 |
| Corrected retained engine    | A 1, B 1, C+ 3, C 14, C- 14, D 123, F 186, NR 2       |           33 |            2 |   9 |
| Reviewed-registry projection | A 1, B 1, B- 1, C+ 3, C 13, C- 14, D 123, F 186, NR 2 |           33 |            3 |   9 |
| Each fresh capture           | A 1, B 1, B- 1, C+ 2, C 14, C- 14, D 127, F 182, NR 2 |           33 |            3 |   9 |

Coverage stays 342/344 with `brlm-mento` and `zeusd-zoth` as the two
integrity/classification `NR` assets and more than 99.99% of tracked supply
rated. The fresh captures reduce the largest exact pillar tuple to 61/342
(17.8%) and the largest score bucket to 47/342 (13.7%). Those two concentration
gates pass. The retained reviewed-registry projection has 65/342 (19.0%) at the
largest tuple and 52/342 (15.2%) in the largest score bucket.

BOLD produces a normal production-path 84/A: backing 78.05, exit 90.74,
control 90, uncapped quality 85.48, and the unchanged less-than-24-month
track-record cap. The hardened judge does not qualify that output as the
contract's defensible real A. Of its 34 score-bearing evidence references, 15
have `not-assessed` freshness: three bridge reviews, five mint-authority
reviews, two oracle reviews, four DEX route valuations, and one redemption
route valuation. BOLD has positive supply, an executable DEX route, strong
pillar classifications, and resolved asset-wide controls, but its
evidence-freshness gate therefore fails. FXUSD is 70/B. Reviewed PUSD mint and
upgrade evidence adds a third B-range asset at 68/B-.

The production-shaped composite fixture still produces 88/A+ without an
injected score, cap, whitelist, or asset exception. No standalone composite
replay or bound causal-attribution artifact was supplied to the hardened Friday
judge, so both of those evidence gates fail closed rather than inheriting the
fixture assertion.

Three distinct schema-v3 exact inputs were captured at 17:49, 18:04, and 18:19
UTC. Trusted production rebuilds confirm distinct source and base-input
generations, matching identities and asset sets, fresh inputs, the same
histogram and B-range set, and no movement greater than three points. All three
reproduce the numerical BOLD 84/A output, but none qualifies it as a real A
while those 15 score-bearing references remain freshness-unassessed. Outside
the top 30, Last USD moves by one point with its peg input; other observed
changes do not cross a grade.

The adverse-control gate does not pass. On the retained input, USDD moves from
31/F to 39/F because its documented redemption route had been double-discounted:
the captured medium modeled confidence was incorrectly re-derived as low. The
fixed route is still bounded by the critical centralized-mint cap at 39, but a
same-input lift violates the written guard. On fresh inputs, U also moves from
31/F to 32/F when a current live reserve snapshot replaces the missing reserve
envelope; the snapshot still records an undisclosed mixed basket, unsafe
backing signals, and control 25. Neither movement is counted as calibration
success.

| Friday gate                                 | Result                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| Coverage 342/344 and at least 99.99% supply | Pass                                                                            |
| Existing live asset at 83-86/A              | Fail: BOLD is 84/A, but 15/34 score-bearing references are freshness-unassessed |
| A+ composite at least 87                    | Fail closed: 88/A+ fixture exists, but no trusted composite replay was supplied |
| Three fresh, stable captures                | Pass: distinct, fresh, matching, and no movement over 3 points                  |
| Same qualifying real A across captures      | Fail: BOLD does not pass evidence freshness                                     |
| Causal attribution for every improvement    | Fail closed: no bound attribution artifact was supplied                         |
| F at most 180                               | Fail: 186 retained, 182 fresh                                                   |
| C- or better at least 35                    | Fail: 33                                                                        |
| B- or better at least 5                     | Fail: 3                                                                         |
| Largest pillar tuple at most 20%            | Pass                                                                            |
| Largest score bucket at most 15%            | Pass fresh; fail retained at 15.2%                                              |
| Score IQR at least 12                       | Fail: 9                                                                         |
| Adverse controls unchanged                  | Fail: USDD retained; U on fresh input                                           |

**Latest ruling: not calibration-ready.** The batch proves that V9 can produce
an A-range numerical output for an existing live stablecoin without moving
grade bands, weights, floors, or known-risk caps. It does not yet prove a
defensible real A under the written evidence-freshness contract. It also
materially reduces evidence compression, but the distribution gate and the
adverse-control gate fail while the composite-replay and causal-attribution
gates remain incomplete. V9 stays shadow-only, qualifying days remain zero, and
no activation or public cutover is authorized.

## Prior 2026-07-16 Calibration Sprint Result

The selected shadow candidate uses registry revision
`sha256:2a821e9b50c4a82177c1589e0375a1a673ecee7be1a642329163486af5a47a39`.
Its final same-input Day 3 replay has fact-set digest
`fdbb0d345c1e7bcee0e39fd88da0b21213181c2fb03e7f52833c49a6d0e59402`
and result digest
`bfdbff11a1358813e83f8a2091a4c3af8c2a19e0030921593371b3f9cc87a56b`.
The policy, build, compiler, producer, and candidate identities are pinned in
Implementation Status above. Two assets remain honestly `NR`: `brlm-mento` and
`zeusd-zoth`.

| Exact replay                     | Grade distribution                              |
| --- | --- |
| Day 1 deployed Batch 5 baseline  | B- 2, C+ 3, C 12, C- 22, D 132, F 171, NR 2     |
| Final same-input Day 3 candidate | B+ 1, B 1, C+ 2, C 9, C- 11, D 106, F 212, NR 2 |
| Each post-lock Day 4 capture     | B+ 1, B 1, C+ 2, C 9, C- 12, D 105, F 212, NR 2 |

The larger F cohort is not a target histogram. It is the result of replacing
optimistic aggregate bridge/control assumptions with conserved deployment rows
and fail-closed unresolved controls. All 19 top-30 D/F cards have a material
trace: twelve are held by the missing/unsupported same-notional exit floor, four
by critical mint/control posture, two by backing plus unresolved mechanism or
control evidence, and one by its peg multiplier. No unexplained top-30 lift or
regression remains.

| Target | Day 1 | Final | Material result                                                                       |
| --- | ---: | ---: | --- |
| BOLD   | 69/B- | 79/B+ | Strong evidence; actual backing 78.05 and exit 72.76 keep raw quality at 79.19.       |
| FXUSD  | 69/B- |  70/B | Strong evidence; exit 65.85 and correlated routes keep peg-adjusted quality at 70.19. |
| USDC   | 64/C+ | 64/C+ | 8.36% Hyperliquid supply is material non-mature-chain common mode, capped at 64.      |
| GHO    | 64/C+ | 64/C+ | Shared Ethereum mint controller is material common mode, capped at 64.                |
| LUSD   |  55/C |  59/C | Immutable mint evidence clears the old hold; unsafe liquidation mechanics cap at 59.  |
| USDT   |  59/C |  55/C | Missing upgradeability and unresolved bridge/control identities now fail closed.      |

There is no real A-range asset. This is a successful falsification of that
hypothesis, not a reason to move a dial: the strongest real candidates remain
below A on the material facts in the table. The production-shaped composite
test mixes reviewed real-asset backing, exit, control, peg, evidence, and
track-record facts through the normal compiler and evaluator. It produces 88/A+
with backing 90.53, exit 79.44, control 95, strong evidence, no gaps, and no
binding cap. It injects no pillar score, cap, override, or asset exception.

| Adverse control | Day 3 | Post-lock Day 4 |
| --- | ---: | ---: |
| USDD            |  31/F |            31/F |
| U               |  31/F |            31/F |
| USDai           |  39/F |            39/F |
| TUSD            |  49/D |           53/C- |
| EURS            |  20/F |            20/F |
| MIM             |   0/F |             0/F |

TUSD's fresh-input move is explained by a new measured Polygon DEX route, which
raises exit from 35 to 46.37 without removing its adverse issuer facts. The
other five controls are unchanged.

After the Day 4 peg audit found and fixed a fail-open active-depeg projection,
three new schema-v3 `exact-publication-inputs` generations at 14:35, 14:49, and
15:05 UTC were replayed under the final identity. Their top-30 maximum score
delta is zero. Outside the top 30, scUSD moves +1 when its measured DEX exit
changes and Last USD moves -1 when a fresh active-depeg event lowers its peg
score; both remain F. The captures were produced against registry `1778128d...`
and then rekeyed to the local `2a821e9b...` metadata revision, so they are valid
calibration projections, not release-window or activation evidence.

**Sprint decision: no-go.** The candidate clears full-cohort reconciliation,
the allowed A-range alternative, adverse-control preservation, causal top-30
explanations, and post-lock stability. It misses two explicit readiness targets:
USDC does not reach B-range, and only two real assets rather than five are B- or
better. The smallest evidenced remaining causes are USDC's real Hyperliquid
exposure, GHO's shared mint controller, and LUSD's unsafe liquidation mechanics;
none justifies policy tuning solely to reach a grade. Keep the candidate available
for dark diagnostics only. V8.17 remains public, qualifying days remain zero,
and activation stays blocked until a later owner re-freeze and a new prospective
window.

## Legacy 2026-07-13 Recorded Result

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

## Activation-Exact Capture

For a later prospective qualification window, capture and replay the deployed,
owner-frozen identity under distinct V9 filenames rather than overwriting the
legacy baseline inputs:

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

The exact-cache export may be either the raw private cache envelope or Wrangler's
D1 JSON query result. The V9 replay accepts the normalized exact JSON or raw
envelope, uses only its explicit publication time and epoch, and emits the
pipeline intermediates and identities needed for byte comparison. The sprint
captures prove that path, but their registry rekey means they are calibration
projections rather than publication-exact activation evidence. A qualifying
capture must match the deployed registry, producer generation, policy, build,
compiler, and capability without rekey or mismatch allowance. Public-endpoint
reconstruction and the calibration-only methodology/registry mismatch flags
remain ineligible for activation evidence. An optional `v9-rc-N` label does not
promote the candidate or authorize release.

Files under `agents/` are ignored fixed-input/research working artifacts, not a
durable evidence archive. An exact schema-v3 capture with matching deployed
registry, producer generation, fingerprint, methodology, and replay bindings
remains an activation blocker. Production remains on V8.17; V9 stays shadow-only
and no activation is authorized while the recorded decision is no-go.
